#!/usr/bin/env python3
"""토너 클리어 생성 지면 A/B + 배너 KPI 문서 갱신 (수동 실행).

흐름
    bq query 1회(한 시점 스냅샷)
      -> docs/sol-clear-create-slot.html 의 보드 3개·리텐션 차트 값 치환
      -> data.js 카드 문구·버전·시각 갱신
      -> 커밋/푸시

이 문서는 다른 갱신 스크립트들과 데이터 계약이 다르다. DATA:START~DATA:END 한 블록이
아니라 보드 스크립트 안의 값 자리(a·b·nA·nB, num·den·base, 세그먼트 n, RET-DATA)를
그대로 들고 있어서, refresh_common 에서는 bq/로그/커밋만 빌려 쓰고 치환은 여기서 한다.

누적 창이라 증분 상태(state json)가 없다 — 매번 09-15~오늘을 다시 읽는다. 오늘(부분일)을
포함하는 것은 의도다: 문서가 "지금까지 누적"을 보여주기로 한 값이다. 리텐션만 창이
필요해 코호트를 d <= 오늘-n 으로 자른다.

사용
    python3 scripts/refresh_sol_clear_create.py             # 조회 -> 갱신 -> 커밋/푸시
    python3 scripts/refresh_sol_clear_create.py --no-push   # 커밋만
    python3 scripts/refresh_sol_clear_create.py --dry-run   # 파일도 안 건드림
"""
import datetime
import json
import os
import re
import sys

import refresh_common as C
from refresh_common import Guard, bq_query, log, notify, parse_args

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(REPO, "docs", "sol-clear-create-slot.html")
DATA = os.path.join(REPO, "data.js")

# 배너 도입 이전 고정 기준선 창. 배너는 09-16 부터라 그 앞 7일을 쓴다.
PRE_FROM, PRE_TO = "2026-09-09", "2026-09-15"
# A/B 시작일. 두 빌드가 처음 함께 서빙된 날.
AB_FROM = "2026-09-15"

SQL = """
WITH src AS (
  SELECT * FROM `game-log-359704.raw.solitaire_city_journey`
  WHERE log_date BETWEEN '%(ab_from)s' AND CURRENT_DATE('Asia/Seoul') AND client_version IN (496,497)
),
ab AS (
  SELECT
    COUNTIF(client_version=496 AND event='3200_TOURNAMENT_SHARE' AND os='Android') AS a_try,
    COUNTIF(client_version=496 AND event='3210_TOURNAMENT_SHARE_SUCCESS' AND os='Android') AS a_ok,
    COUNTIF(client_version=497 AND event='3100_TOURNAMENT_CREATE' AND os='Android' AND JSON_VALUE(data,'$.position')='game_clear_tournament') AS b_try,
    COUNTIF(client_version=497 AND event='3110_TOURNAMENT_CREATE_SUCCESS' AND os='Android' AND JSON_VALUE(data,'$.position')='game_clear_tournament') AS b_ok,
    COUNTIF(client_version=496 AND event='2300_GAMEPLAY_FINISH' AND os='Android' AND JSON_VALUE(data,'$.result')='clear') AS a_clear,
    COUNTIF(client_version=497 AND event='2300_GAMEPLAY_FINISH' AND os='Android' AND JSON_VALUE(data,'$.result')='clear') AS b_clear,
    COUNTIF(client_version=496 AND event='3410_MSG_P2P_SUCCESS' AND os='Android') AS a_p2p,
    COUNTIF(client_version=497 AND event='3410_MSG_P2P_SUCCESS' AND os='Android') AS b_p2p,
    COUNTIF(client_version=497 AND event='3130_TOURNAMENT_CREATE_SUPPRESSED' AND os='Android') AS b_supp
  FROM src
),
bn AS (
  SELECT
    COUNTIF(event='4300_BANNER_AD_START') AS judge,
    COUNTIF(event='4300_BANNER_AD_START' AND JSON_VALUE(data,'$.status')='true') AS try_,
    COUNTIF(event='4310_BANNER_AD_FINISH') AS shown,
    COUNTIF(event='4320_BANNER_AD_ERROR') AS err,
    COUNTIF(event='4320_BANNER_AD_ERROR' AND JSON_VALUE(data,'$.error_code')='CLIENT_UNSUPPORTED_OPERATION') AS unsup,
    COUNTIF(event='4320_BANNER_AD_ERROR' AND JSON_VALUE(data,'$.error_code')='ADS_NO_FILL') AS nofill,
    COUNTIF(event='4321_BANNER_AD_HIDE') AS hide,
    APPROX_QUANTILES(IF(event='4321_BANNER_AD_HIDE', SAFE_CAST(NULLIF(JSON_VALUE(data,'$.duration'),'') AS INT64), NULL),2)[OFFSET(1)] AS dur_med
  FROM src
),
ev AS (
  SELECT log_date AS d, player_id, event,
         JSON_VALUE(data,'$.skip_reason') AS sr, JSON_VALUE(data,'$.result') AS result
  FROM src
  WHERE event IN ('4300_BANNER_AD_START','4310_BANNER_AD_FINISH',
                  '2100_GAMEPLAY_START','2300_GAMEPLAY_FINISH','2223_GAMEPLAY_END_SURE_RETRY')
),
grp AS (
  SELECT d, player_id,
    CASE WHEN COUNTIF(event='4310_BANNER_AD_FINISH')>0 THEN 'shown'
         WHEN COUNTIF(event='4300_BANNER_AD_START' AND sr='min_plays_not_met')>0 THEN 'notshown' END AS g,
    COUNTIF(event='2100_GAMEPLAY_START') AS plays,
    COUNTIF(event='2300_GAMEPLAY_FINISH') AS fin,
    COUNTIF(event='2300_GAMEPLAY_FINISH' AND result='clear') AS clears,
    COUNTIF(event='2223_GAMEPLAY_END_SURE_RETRY') AS retries
  FROM ev GROUP BY d, player_id
),
se AS (
  SELECT
    COUNTIF(g='notshown') AS n_users, SUM(IF(g='notshown',plays,0)) AS n_plays,
    SUM(IF(g='notshown',fin,0)) AS n_fin, SUM(IF(g='notshown',clears,0)) AS n_clears,
    SUM(IF(g='notshown',retries,0)) AS n_ret,
    COUNTIF(g='shown') AS s_users, SUM(IF(g='shown',plays,0)) AS s_plays,
    SUM(IF(g='shown',fin,0)) AS s_fin, SUM(IF(g='shown',clears,0)) AS s_clears,
    SUM(IF(g='shown',retries,0)) AS s_ret
  FROM grp WHERE g IS NOT NULL
),
logins AS (
  -- 복귀 판정용. 기준선(배너 이전) 코호트까지 덮으려고 %(pre_from)s 부터 읽는다.
  SELECT DISTINCT log_date AS d, player_id
  FROM `game-log-359704.raw.solitaire_city_journey`
  WHERE log_date BETWEEN '%(pre_from)s' AND CURRENT_DATE('Asia/Seoul') AND event='1000_LOGIN_COMPLETE'
),
pcoh AS (
  -- 배너 이전 고정 기준선 코호트: %(pre_from)s~%(pre_to)s 각 날짜의 활성 유저
  SELECT d, player_id FROM logins WHERE d BETWEEN '%(pre_from)s' AND '%(pre_to)s'
),
pdays AS (
  SELECT n,
    COUNTIF(d <= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL n DAY)) AS base,
    COUNTIF(d <= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL n DAY)
            AND EXISTS(SELECT 1 FROM logins l
                       WHERE l.player_id = pcoh.player_id AND l.d = DATE_ADD(pcoh.d, INTERVAL n DAY))) AS ret
  FROM pcoh, UNNEST(GENERATE_ARRAY(1, 7)) AS n
  GROUP BY n
),
vers AS (
  SELECT log_date AS d, player_id, client_version AS ver,
    ROW_NUMBER() OVER (PARTITION BY log_date, player_id ORDER BY COUNT(*) DESC) AS rk
  FROM src GROUP BY d, player_id, ver
),
rbase AS (
  SELECT g.d, g.player_id, g.g, v.ver,
    EXISTS(SELECT 1 FROM logins l
           WHERE l.player_id=g.player_id AND l.d=DATE_ADD(g.d, INTERVAL 1 DAY)) AS r1
  FROM grp g JOIN vers v USING (d, player_id)
  WHERE v.rk = 1 AND g.d <= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 DAY)
),
rdays AS (
  SELECT g AS grp, n,
    COUNTIF(d <= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL n DAY)) AS base,
    COUNTIF(d <= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL n DAY)
            AND EXISTS(SELECT 1 FROM logins l
                       WHERE l.player_id = rbase.player_id AND l.d = DATE_ADD(rbase.d, INTERVAL n DAY))) AS ret
  FROM rbase, UNNEST(GENERATE_ARRAY(1, 7)) AS n
  WHERE g IS NOT NULL
  GROUP BY grp, n
),
ret AS (
  SELECT
    (SELECT COUNTIF(g='shown') FROM rbase) AS s_cohort,
    (SELECT COUNT(*) FROM pcoh) AS p_cohort,
    (SELECT ARRAY_AGG(STRUCT(n, base, ret) ORDER BY n) FROM rdays WHERE grp='shown') AS s_days,
    (SELECT ARRAY_AGG(STRUCT(n, base, ret) ORDER BY n) FROM pdays) AS p_days,
    (SELECT COUNTIF(ver=496) FROM rbase) AS a_cohort,
    (SELECT COUNTIF(ver=496 AND r1) FROM rbase) AS a_d1,
    (SELECT COUNTIF(ver=497) FROM rbase) AS b_cohort,
    (SELECT COUNTIF(ver=497 AND r1) FROM rbase) AS b_d1
),
codes AS (
  SELECT ARRAY_AGG(STRUCT(code, n) ORDER BY n DESC) AS list FROM (
    SELECT COALESCE(NULLIF(JSON_VALUE(data,'$.error_code'),''),'UNKNOWN') AS code, COUNT(*) AS n
    FROM src WHERE event='4320_BANNER_AD_ERROR' GROUP BY code)
)
SELECT TO_JSON_STRING(STRUCT(ab AS ab, bn AS bn, se AS se, ret AS ret,
                             (SELECT list FROM codes) AS codes)) AS j
FROM ab, bn, se, ret
"""


def pct(n, d):
    return round(n / d * 100, 1) if d else 0.0


def fetch():
    rows = bq_query(SQL % {"ab_from": AB_FROM, "pre_from": PRE_FROM, "pre_to": PRE_TO})
    if not rows:
        raise Guard("쿼리가 빈 결과를 냈다")
    d = json.loads(rows[0]["j"])
    for k in ("ab", "bn", "se", "ret"):
        d[k] = {kk: (int(vv) if isinstance(vv, str) and vv.lstrip("-").isdigit() else vv)
                for kk, vv in d[k].items()}
    for k in ("s_days", "p_days"):
        d["ret"][k] = [{kk: int(vv) for kk, vv in x.items()} for x in d["ret"][k]]
    d["codes"] = [{"code": c["code"], "n": int(c["n"])} for c in d["codes"]]
    return d


def board_row(doc, label, a, b, nA, nB):
    """보드 한 행의 a·b·nA·nB 만 바꾼다. 라벨 뒤 한 행 범위에서만 친다."""
    pat = re.compile(r'(lab: "' + re.escape(label) + r'".{0,200}?)'
                     r'a: (?:null|[\d.]+), b: (?:null|[\d.]+), '
                     r'nA: (?:null|\[[^\]]*\]), nB: (?:null|\[[^\]]*\])', re.S)
    fmt = lambda v: "null" if v is None else str(v)
    arr = lambda v: "null" if v is None else "[%d, %d]" % v
    doc, n = pat.subn(r"\1" + "a: %s, b: %s, nA: %s, nB: %s"
                      % (fmt(a), fmt(b), arr(nA), arr(nB)), doc, count=1)
    if n != 1:
        raise Guard("보드 행을 못 찾았다: " + label)
    return doc


def funnel_row(doc, label, num, den, base):
    pat = re.compile(r'(lab: "' + re.escape(label) + r'", src: "[^"]*", )'
                     r'num: \d+, den: \d+, base: "[^"]*"')
    doc, n = pat.subn(r"\1" + 'num: %d, den: %d, base: "%s"' % (num, den, base), doc, count=1)
    if n != 1:
        raise Guard("퍼널 행을 못 찾았다: " + label)
    return doc


def ret_block(ret):
    days = lambda arr: ",\n                ".join(
        "{ n: %d, base: %d, ret: %d }" % (x["n"], x["base"], x["ret"]) for x in arr)
    return ("""            const RET = {
              cohorts: { shown: %d, pre: %d },
              shown: [
                %s
              ],
              pre: [
                %s
              ]
            };""" % (ret["s_cohort"], ret["p_cohort"], days(ret["s_days"]), days(ret["p_days"])))


def render(d, now, today):
    ab, bn, se, ret, codes = d["ab"], d["bn"], d["se"], d["ret"], d["codes"]
    etc = bn["err"] - bn["unsup"] - bn["nofill"]

    doc = open(HTML, encoding="utf-8").read()

    # A/B 보드
    doc = board_row(doc, "지면 수락률", pct(ab["a_ok"], ab["a_try"]), pct(ab["b_ok"], ab["b_try"]),
                    (ab["a_ok"], ab["a_try"]), (ab["b_ok"], ab["b_try"]))
    doc = board_row(doc, "클리어당 바이럴 발사율", pct(ab["a_ok"], ab["a_clear"]), pct(ab["b_ok"], ab["b_clear"]),
                    (ab["a_ok"], ab["a_clear"]), (ab["b_ok"], ab["b_clear"]))
    doc = board_row(doc, "지면 미노출률", None, pct(ab["b_supp"], ab["b_clear"]),
                    None, (ab["b_supp"], ab["b_clear"]))
    doc = board_row(doc, "P2P 메시지 발송률", pct(ab["a_p2p"], ab["a_clear"]), pct(ab["b_p2p"], ab["b_clear"]),
                    (ab["a_p2p"], ab["a_clear"]), (ab["b_p2p"], ab["b_clear"]))
    doc = board_row(doc, "D1 잔존율", pct(ret["a_d1"], ret["a_cohort"]), pct(ret["b_d1"], ret["b_cohort"]),
                    (ret["a_d1"], ret["a_cohort"]), (ret["b_d1"], ret["b_cohort"]))

    # 배너 부작용 보드
    doc = board_row(doc, "판 클리어율", pct(se["n_clears"], se["n_fin"]), pct(se["s_clears"], se["s_fin"]),
                    (se["n_clears"], se["n_fin"]), (se["s_clears"], se["s_fin"]))
    doc = board_row(doc, "인당 판수",
                    round(se["n_plays"] / se["n_users"], 2) if se["n_users"] else 0.0,
                    round(se["s_plays"] / se["s_users"], 2) if se["s_users"] else 0.0,
                    (se["n_plays"], se["n_users"]), (se["s_plays"], se["s_users"]))
    doc = board_row(doc, "재시도율", pct(se["n_ret"], se["n_fin"]), pct(se["s_ret"], se["s_fin"]),
                    (se["n_ret"], se["n_fin"]), (se["s_ret"], se["s_fin"]))

    # 배너 퍼널 막대
    doc = funnel_row(doc, "노출 시도율", bn["try_"], bn["judge"], "판정 %s" % f'{bn["judge"]:,}')
    doc = funnel_row(doc, "로드 성공률", bn["shown"], bn["try_"], "시도 %s" % f'{bn["try_"]:,}')
    doc = funnel_row(doc, "로드 실패율", bn["err"], bn["try_"], "시도 %s" % f'{bn["try_"]:,}')
    doc = re.sub(r'(src: "4320\.error_code", den: )\d+', r"\g<1>" + str(bn["err"]), doc, count=1)
    doc = re.sub(r'(\{ lab: "미지원", n: )\d+', r"\g<1>" + str(bn["unsup"]), doc, count=1)
    doc = re.sub(r'(\{ lab: "재고 없음", n: )\d+', r"\g<1>" + str(bn["nofill"]), doc, count=1)
    doc = re.sub(r'(\{ lab: "기타", n: )\d+', r"\g<1>" + str(etc), doc, count=1)

    # 리텐션 차트 — 블록을 통째로 다시 쓴다(필드별 치환보다 안전하다)
    doc = re.sub(r"(/\* RET-DATA \*/\n)[\s\S]*?(\n\s*/\* /RET-DATA \*/)",
                 lambda m: m.group(1) + ret_block(ret) + m.group(2), doc, count=1)

    # 각주·스탬프
    doc = re.sub(r"노출 지속 중위 <b>\d+초</b>\(n [\d,]+\)",
                 "노출 지속 중위 <b>%d초</b>(n %s)" % (bn["dur_med"], f'{bn["hide"]:,}'), doc, count=1)
    etc_codes = [c["code"] for c in codes
                 if c["code"] not in ("CLIENT_UNSUPPORTED_OPERATION", "ADS_NO_FILL")]
    doc = re.sub(r"기타</b>\([^)]*\)", "기타</b>(" + " · ".join(etc_codes) + ")", doc, count=1)
    doc = re.sub(r"미노출군 <b>[\d,]+명</b>", "미노출군 <b>%s명</b>" % f'{se["n_users"]:,}', doc, count=1)
    doc = re.sub(r"측정 · 09-15~\d\d-\d\d 누적", "측정 · 09-15~%s 누적" % today, doc, count=1)
    doc = re.sub(r"09-15~\d\d-\d\d 누적 \(\d\d-\d\d \d\d:\d\d\)</span>",
                 "09-15~%s 누적 (%s %s)</span>" % (today, today, now), doc, count=1)
    doc = re.sub(r"갱신 \d\d-\d\d \d\d:\d\d", "갱신 %s %s" % (today, now), doc, count=1)

    # 허브 카드
    dj = open(DATA, encoding="utf-8").read()
    dj = re.sub(r"\d\d-\d\d \d\d:\d\d 기준", "%s %s 기준" % (today, now), dj, count=1)
    dj = re.sub(r"지면 수락률 A [\d.]+%\(\d+/\d+\) · B [\d.]+%\(\d+/\d+\)",
                "지면 수락률 A %s%%(%d/%d) · B %s%%(%d/%d)" % (
                    pct(ab["a_ok"], ab["a_try"]), ab["a_ok"], ab["a_try"],
                    pct(ab["b_ok"], ab["b_try"]), ab["b_ok"], ab["b_try"]), dj, count=1)
    dj = re.sub(r"시도 [\d.]+% · 로드 성공 [\d.]+% · 실패 [\d.]+%",
                "시도 %s%% · 로드 성공 %s%% · 실패 %s%%" % (
                    pct(bn["try_"], bn["judge"]), pct(bn["shown"], bn["try_"]),
                    pct(bn["err"], bn["try_"])), dj, count=1)
    dj = re.sub(r"실패 [\d,]+건의 구성은", "실패 %s건의 구성은" % f'{bn["err"]:,}', dj, count=1)
    dj = re.sub(r"미지원 클라이언트 [\d.]+% · 재고 없음 [\d.]+% · 기타 [\d.]+%",
                "미지원 클라이언트 %s%% · 재고 없음 %s%% · 기타 %s%%" % (
                    pct(bn["unsup"], bn["err"]), pct(bn["nofill"], bn["err"]),
                    pct(etc, bn["err"])), dj, count=1)
    dj = re.sub(r"노출 지속 중위 \d+초", "노출 지속 중위 %d초" % bn["dur_med"], dj, count=1)
    dj = re.sub(r'version: "v1\.(\d+)",\n(\s+)updated: "2026-\d\d-\d\d \d\d:\d\d"',
                lambda m: 'version: "v1.%d",\n%supdated: "2026-%s %s"'
                          % (int(m.group(1)) + 1, m.group(2), today, now), dj, count=1)
    return doc, dj


def main():
    a = parse_args()
    C.configure(job_id="sol_clear_create", log_prefix="[클리어 생성 A/B] ",
                notify_title="토너 클리어 A/B 문서 갱신 실패",
                html=HTML, doc_url="docs/sol-clear-create-slot.html",
                commit_msg="[Max] 토너 클리어 A/B·배너 KPI 갱신 (%s 누적, %s)")
    try:
        d = fetch()
        stamp = datetime.datetime.now()
        doc, dj = render(d, stamp.strftime("%H:%M"), stamp.strftime("%m-%d"))
    except Guard as e:
        log("중단: %s" % e)
        notify(str(e))
        return 1

    if a.dry_run:
        log("dry-run — 파일을 쓰지 않는다")
        print(json.dumps(d["bn"], ensure_ascii=False))
        return 0

    if doc == open(HTML, encoding="utf-8").read() and dj == open(DATA, encoding="utf-8").read():
        log("값·시각 모두 그대로 — 커밋 없음")
        return 0

    open(HTML, "w", encoding="utf-8").write(doc)
    open(DATA, "w", encoding="utf-8").write(dj)
    msg = "[Max] 토너 클리어 A/B·배너 KPI %s %s 스냅샷 갱신" % (
        stamp.strftime("%m-%d"), stamp.strftime("%H:%M"))
    return C.commit_push(a, msg, [HTML, DATA], "갱신 완료")


if __name__ == "__main__":
    sys.exit(main())
