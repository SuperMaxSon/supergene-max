#!/usr/bin/env python3
"""토너 클리어 소셜 슬롯 A/B 문서 자동 갱신.

흐름
    bq query (블록당 1행 JSON)
      -> docs/data/sol-slot-ab.json 에 병합    (날짜 축 있는 블록은 날짜 키 머지)
      -> docs/sol-tournament-slot-ab.html 의 DATA:START~DATA:END 재생성
      -> 가드 통과 + 내용 변화 있을 때만 커밋/푸시

설계 원칙
    · 오늘(부분일)은 절대 읽지 않는다. 쿼리의 마지막 날은 항상 어제다.
    · 멱등하다. 같은 데이터가 나오면 아무것도 커밋하지 않는다.
    · 페이지는 fetch 를 쓰지 않는다 — 데이터를 HTML 에 직접 심어 자기완결로 둔다.
      JSON 은 스크립트의 누적 상태(state)일 뿐이다.

사용
    python3 scripts/refresh_sol_slot_ab.py              # 조회 -> 갱신 -> 커밋/푸시
    python3 scripts/refresh_sol_slot_ab.py --no-push    # 커밋만
    python3 scripts/refresh_sol_slot_ab.py --dry-run    # 파일도 안 건드림
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

REPO     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML     = os.path.join(REPO, "docs", "sol-tournament-slot-ab.html")
STATE    = os.path.join(REPO, "docs", "data", "sol-slot-ab.json")
DATA_JS  = os.path.join(REPO, "data.js")
INDEX    = os.path.join(REPO, "index.html")
LOG      = os.path.join(REPO, "scripts", "refresh.log")
REGISTRY = os.path.join(REPO, "scripts", "automation.json")
JOB_ID   = "sol-slot-ab"   # launchd stdout 은 refresh.launchd.log 로 분리

BQ       = "/opt/homebrew/bin/bq"
PROJECT  = "game-log-359704"
EXP_FROM = "2026-09-03"          # 실험 시작일
A, B     = "485", "486"

SQL = r"""-- 이 문서를 채우는 쿼리다. scripts/refresh_sol_slot_ab.py 가 매일 KST 09·12·18시에 이 문자열을
-- 그대로 실행하고, 같은 문자열을 문서의 SQL 폴드에 심는다 — 사본이 갈라질 수 없다.
--
-- 스캔 원칙
--  · 오늘은 절대 넣지 않는다. 마지막 날은 항상 어제다(log_date 는 KST 기준).
--  · 무거운 컬럼(data · entrypoint_now)은 최근 3일만 읽는다. 그 이전은 이미 뽑혀 있고 불변이다.
--  · 가벼운 컬럼만 읽는 스캔(lite)은 전 구간이어도 싸다 — 실험 성립 판정은 전 구간이 필요하다.
--  · 리텐션은 raw 조인을 쓰지 않는다. stat 사전집계를 읽는다.
--  · 블록을 쪼개지 않는다. 하나만 다시 뽑으면 블록을 가로지르는 값이 조용히 어긋난다.
WITH us AS (
    SELECT log_date, player_id, event, data, entrypoint_now, client_version
    FROM `game-log-359704.raw.solitaire_city_journey`
    WHERE log_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
                       AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        AND country = 'US'
),
lite AS (
    SELECT log_date, player_id, client_version, country, os
    FROM `game-log-359704.raw.solitaire_city_journey`
    WHERE log_date BETWEEN DATE '2026-09-03' AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        AND event = '1000_LOGIN_COMPLETE'
),
ab AS (
    SELECT
        log_date, player_id, event, data, client_version,
        MAX(IF(event = '1000_LOGIN_COMPLETE', 1, 0))
            OVER (PARTITION BY log_date, player_id) AS has_login,
        MAX(IF(event = '1000_LOGIN_COMPLETE'
               AND JSON_VALUE(data, '$.is_new_device') = 'true', 1, 0))
            OVER (PARTITION BY log_date, player_id) AS is_nru
    FROM us
    WHERE client_version IN (485, 486)
),
daily AS (
    SELECT
        log_date, client_version, IF(is_nru = 1, 'NRU', 'RU') AS seg,
        COUNT(DISTINCT IF(has_login = 1, player_id, NULL))                AS ud,
        COUNTIF(event = '2300_GAMEPLAY_FINISH')                           AS fin,
        COUNTIF(event = '3200_TOURNAMENT_SHARE')                          AS sh_try,
        COUNTIF(event = '3210_TOURNAMENT_SHARE_SUCCESS')                  AS sh_ok,
        COUNTIF(event = '3460_MSG_P2P_INVITE'
                AND JSON_VALUE(data, '$.position') = 'tournament_invite') AS inv_try,
        COUNTIF(event = '3470_MSG_P2P_INVITE_SUCCESS'
                AND JSON_VALUE(data, '$.position') = 'tournament_invite') AS inv_ok,
        COUNTIF(event = '3230_TOURNAMENT_SHARE_SUPPRESSED')               AS sup,
        COUNTIF(event = '3100_TOURNAMENT_CREATE')                         AS cr_try,
        COUNTIF(event = '3110_TOURNAMENT_CREATE_SUCCESS')                 AS cr_ok,
        COUNTIF(event = '4010_INTERSTITIAL_AD_FINISH')                    AS it,
        COUNTIF(event = '4210_RV_FINISH')                                 AS rv
    FROM ab
    GROUP BY log_date, client_version, seg
),
perday AS (
    SELECT
        log_date, player_id, client_version,
        IF(MAX(is_nru) = 1, 'NRU', 'RU')        AS seg,
        COUNTIF(event = '2300_GAMEPLAY_FINISH') AS n
    FROM ab
    GROUP BY log_date, player_id, client_version
),
dist AS (
    SELECT
        client_version, seg,
        COUNT(*)                                              AS uday,
        ROUND(AVG(n), 2)                                      AS avg_n,
        APPROX_QUANTILES(n, 100)[OFFSET(50)]                  AS p50,
        APPROX_QUANTILES(n, 100)[OFFSET(75)]                  AS p75,
        APPROX_QUANTILES(n, 100)[OFFSET(90)]                  AS p90,
        ROUND(COUNTIF(n > 0) * 100.0 / COUNT(*), 1)           AS play,
        APPROX_QUANTILES(IF(n > 0, n, NULL), 100)[OFFSET(50)] AS p50p
    FROM perday
    GROUP BY client_version, seg
),
retn AS (
    SELECT
        join_date, client_version, social,
        SUM(nru_count) AS coh,
        DATE_DIFF(DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY), join_date, DAY) AS observed_days,
        ROUND(SUM(nru_count * d1)) AS d1,
        ROUND(SUM(nru_count * d2)) AS d2,
        ROUND(SUM(nru_count * d3)) AS d3,
        ROUND(SUM(nru_count * d4)) AS d4,
        ROUND(SUM(nru_count * d5)) AS d5,
        ROUND(SUM(nru_count * d6)) AS d6,
        ROUND(SUM(nru_count * d7)) AS d7
    FROM `game-log-359704.stat.solitaire_city_journey_nru_retention3`
    WHERE join_date >= DATE '2026-09-03'
        AND client_version IN (485, 486)
        AND country = 'US'
    GROUP BY join_date, client_version, social
),
inflow AS (
    SELECT
        log_date,
        COUNTIF(JSON_VALUE(entrypoint_now, '$.payload.social') = 'TOURNAMENT')        AS t,
        COUNTIF(JSON_VALUE(entrypoint_now, '$.payload.social') = 'TOURNAMENT_INVITE') AS ti
    FROM us
    WHERE event = '1000_LOGIN_COMPLETE'
    GROUP BY log_date
),
res AS (
    SELECT
        client_version, IF(is_nru = 1, 'NRU', 'RU') AS seg,
        JSON_VALUE(data, '$.result') AS result,
        COUNT(*) AS n
    FROM ab
    WHERE event = '2300_GAMEPLAY_FINISH'
    GROUP BY client_version, seg, result
),
bal AS (
    SELECT
        client_version, country, IFNULL(os, '(null)') AS os,
        COUNT(DISTINCT player_id) AS users
    FROM lite
    WHERE client_version IN (485, 486)
    GROUP BY client_version, country, os
    HAVING users >= 10
),
vers AS (
    SELECT log_date, client_version, COUNT(DISTINCT player_id) AS dau
    FROM lite
    WHERE country = 'US'
    GROUP BY log_date, client_version
    HAVING dau >= 10
)
SELECT '0_META' AS blk, 1 AS rows_n,
    TO_JSON_STRING(STRUCT(
        FORMAT_DATETIME('%Y-%m-%d %H:%M', CURRENT_DATETIME('Asia/Seoul')) AS pulled_kst,
        DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AS last_day,
        DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY) AS heavy_scan_from)) AS payload
UNION ALL SELECT '1_DAILY', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    FORMAT_DATE('%m-%d', log_date) AS d, CAST(client_version AS STRING) AS ver, seg,
    ud, fin, sh_try, sh_ok, inv_try, inv_ok, sup, cr_try, cr_ok, it, rv)
    ORDER BY log_date, client_version, seg)) FROM daily
UNION ALL SELECT '2_EXTRA', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    CAST(client_version AS STRING) AS ver, seg, uday, avg_n, p50, p75, p90, play, p50p)
    ORDER BY seg, client_version)) FROM dist
UNION ALL SELECT '3_RET', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    FORMAT_DATE('%m-%d', join_date) AS coh_date, CAST(client_version AS STRING) AS ver,
    social, coh, observed_days, d1, d2, d3, d4, d5, d6, d7)
    ORDER BY join_date, client_version, social)) FROM retn
UNION ALL SELECT '4_INFLOW', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    FORMAT_DATE('%m-%d', log_date) AS d, t, ti)
    ORDER BY log_date)) FROM inflow
UNION ALL SELECT '5_RESULT', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    CAST(client_version AS STRING) AS ver, seg, result, n)
    ORDER BY seg, client_version, result)) FROM res
UNION ALL SELECT '6_BALANCE', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    CAST(client_version AS STRING) AS ver, country, os, users)
    ORDER BY country, os, client_version)) FROM bal
UNION ALL SELECT '7_VERSION', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    FORMAT_DATE('%m-%d', log_date) AS d, CAST(client_version AS STRING) AS ver, dau)
    ORDER BY log_date, client_version)) FROM vers
ORDER BY blk
"""


def notify(msg):
    """실패했을 때만 맥 알림을 띄운다. 로그만 남기면 아무도 안 본다."""
    try:
        subprocess.run(["/usr/bin/osascript", "-e",
                        'display notification %s with title "슬롯 A/B 갱신 실패"'
                        % json.dumps(msg[:200])], timeout=20)
    except Exception:
        pass


def log(msg):
    line = "%s  %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


class Guard(Exception):
    pass


# ── 조회 ────────────────────────────────────────────────────────────────────
def run_query():
    out = subprocess.run(
        [BQ, "query", "--use_legacy_sql=false", "--format=json", "--quiet",
         "--project_id=" + PROJECT, "--max_rows=100"],
        input=SQL, capture_output=True, text=True, timeout=900)
    if out.returncode != 0:
        raise Guard("bq query 실패: " + (out.stderr or out.stdout).strip()[:500])
    rows = json.loads(out.stdout)
    blocks = {}
    for r in rows:
        payload = r.get("payload")
        blocks[r["blk"]] = json.loads(payload) if payload else None
    missing = [b for b in ("0_META", "1_DAILY", "3_RET", "7_VERSION") if not blocks.get(b)]
    if missing:
        raise Guard("필수 블록이 비었다: " + ", ".join(missing))
    return blocks


# ── 병합 ────────────────────────────────────────────────────────────────────
def merge_by_key(old, new, keys):
    """날짜 축이 있는 블록: 같은 키의 행은 덮어쓰고 새 키는 추가한다."""
    idx = {tuple(str(r[k]) for k in keys): r for r in old}
    for r in new:
        idx[tuple(str(r[k]) for k in keys)] = r
    return [idx[k] for k in sorted(idx)]


def merge_state(state, blocks):
    meta = blocks["0_META"]
    state["pulled"]   = meta["pulled_kst"]
    state["last_day"] = meta["last_day"]
    # 날짜 축 있음 -> 머지 (과거는 불변이므로 보존)
    state["daily"]   = merge_by_key(state.get("daily", []),   blocks["1_DAILY"] or [],  ["d", "ver", "seg"])
    state["inflow"]  = merge_by_key(state.get("inflow", []),  blocks["4_INFLOW"] or [], ["d"])
    state["version"] = merge_by_key(state.get("version", []), blocks["7_VERSION"] or [], ["d", "ver"])
    # 날짜 축 없음 -> 통째 교체 (최근 3일 롤링). ret/balance 는 쿼리가 전 구간을 준다.
    state["extra"]   = blocks["2_EXTRA"]   or []
    state["ret"]     = blocks["3_RET"]     or []
    state["result"]  = blocks["5_RESULT"]  or []
    state["balance"] = blocks["6_BALANCE"] or []
    return state


# ── 가드 ────────────────────────────────────────────────────────────────────
def check(state):
    y = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    if state["last_day"] != y:
        raise Guard("마지막 날(%s)이 어제(%s)가 아니다 — 적재가 안 끝났거나 시각이 어긋났다"
                    % (state["last_day"], y))
    days = sorted({r["d"] for r in state["daily"]})
    if len(days) < 2:
        raise Guard("daily 날짜가 %d개뿐이다" % len(days))
    dau = {d: sum(r["ud"] for r in state["daily"] if r["d"] == d) for d in days}
    last, prev = days[-1], days[-2]
    if dau[prev] and not (0.5 <= dau[last] / dau[prev] <= 1.5):
        raise Guard("DAU 가 전일 대비 %.0f%% — 부분일이거나 집계 이상 (%s %d -> %s %d)"
                    % (dau[last] / dau[prev] * 100, prev, dau[prev], last, dau[last]))
    for v in (A, B):
        if not any(r["ver"] == v for r in state["daily"] if r["d"] == last):
            raise Guard("%s 마지막 날에 빌드 %s 행이 없다 — 대조군이 사라졌다" % (last, v))
    others = sorted({r["ver"] for r in state["version"]} - {A, B})
    if any(int(v) > int(B) for v in others):
        log("⚠ 경고: %s 이상 빌드가 떴다 — 그 뒤 날짜는 A/B 대조가 아니다" % others)


# ── JS 블록 생성 ────────────────────────────────────────────────────────────
def j(v):
    return json.dumps(v, ensure_ascii=False)


def build_js(state):
    days   = sorted({r["d"] for r in state["daily"]})
    rng    = "%d/%d~%d/%d" % (int(days[0][:2]), int(days[0][3:]),
                              int(days[-1][:2]), int(days[-1][3:]))
    L = []
    L.append("      /* DATA:START */")
    L.append('      // 이 블록은 scripts/refresh_sol_slot_ab.py 가 생성한다. 손으로 고치면 사라진다.')
    L.append('      const PULLED = %s;' % j(state["pulled"]))
    L.append('      const RANGE  = %s;' % j(rng))
    L.append("")

    L.append("      // 1_DAILY — 일자 × 빌드 × 유저군. 보드는 전부 여기서 합산해 만든다.")
    L.append("      const DAILY = [")
    for r in sorted(state["daily"], key=lambda r: (r["d"], r["ver"], r["seg"])):
        L.append("        { d:%s, ver:%s, seg:%s, ud:%d, fin:%d, sh_try:%d, sh_ok:%d, "
                 "inv_try:%d, inv_ok:%d, sup:%d, cr_try:%d, cr_ok:%d, it:%d, rv:%d }," % (
                     j(r["d"]), j(r["ver"]), j(r["seg"]), r["ud"], r["fin"], r["sh_try"],
                     r["sh_ok"], r["inv_try"], r["inv_ok"], r["sup"], r["cr_try"],
                     r["cr_ok"], r["it"], r["rv"]))
    L.append("      ];")
    L.append("")

    L.append("      // 2_EXTRA — 판수 분포. 날짜축이 없어 갱신마다 통째로 바뀐다(최근 3일 롤링).")
    L.append("      // 분위수는 세그먼트 합산이 불가능하다(중앙값은 더할 수 없다) — 전체 탭에서는 비운다.")
    L.append("      const EXTRA = {")
    for v in (A, B):
        segs = []
        for seg in ("NRU", "RU"):
            e = next((r for r in state["extra"] if r["ver"] == v and r["seg"] == seg), None)
            if not e:
                continue
            segs.append("%s:{ uday:%d, avg:%s, p50:%d, p75:%d, p90:%d, play:%s, p50p:%d }" % (
                seg, int(e["uday"]), e["avg_n"], int(e["p50"]), int(e["p75"]),
                int(e["p90"]), e["play"], int(e["p50p"])))
        L.append("        %s: { %s }," % (j(v), ", ".join(segs)))
    L.append("      };")
    L.append("")

    L.append("      // 3_RET — stat.solitaire_city_journey_nru_retention3 (사전집계, raw 스캔 없음).")
    L.append("      // classic Day-N. d 는 인원이고 비율은 화면에서 계산한다. 원본이 social(유입 경로)별로")
    L.append("      // 쪼개져 있어 nru_count 가중합으로 합쳤고, 광고분(adc/add)은 social='AD' 행이다.")
    L.append("      // obs = 그 코호트를 며칠까지 관측했는지. D+n 도래 판정의 유일한 기준이다.")
    L.append("      const RET = [")
    cohorts = sorted({(r["coh_date"], r["ver"]) for r in state["ret"]})
    for coh, v in cohorts:
        rs  = [r for r in state["ret"] if r["coh_date"] == coh and r["ver"] == v]
        obs = min(int(r["observed_days"]) for r in rs)
        tot = sum(int(r["coh"]) for r in rs)
        adr = [r for r in rs if r["social"] == "AD"]
        adc = sum(int(r["coh"]) for r in adr)
        d   = [sum(int(r["d%d" % n] or 0) for r in rs)  for n in range(1, min(obs, 7) + 1)]
        ad  = [sum(int(r["d%d" % n] or 0) for r in adr) for n in range(1, min(obs, 7) + 1)]
        L.append('        { c:%s, ver:%s, seg:"NRU", obs:%d, coh:%d, d:[%s], adc:%d, add:[%s] },' % (
            j(coh), j(v), obs, tot, ", ".join(map(str, d)), adc, ", ".join(map(str, ad))))
    L.append("      ];")
    L.append("")

    L.append("      // 4_INFLOW — 유입 세션. 발신자 버전으로도 유저군으로도 못 가른다. 날짜축만 있다.")
    L.append("      const INFLOW = [")
    for r in sorted(state["inflow"], key=lambda r: r["d"]):
        L.append("        { d:%s, t:%d, ti:%d }," % (j(r["d"]), int(r["t"]), int(r["ti"])))
    L.append("      ];")
    post = [r["d"] for r in sorted(state["inflow"], key=lambda r: r["d"])
            if r["d"] >= EXP_FROM[5:]]
    L.append("      const POST = [%s];" % ", ".join(j(d) for d in post))
    L.append("")

    L.append("      // 5_RESULT · 6_BALANCE · 7_VERSION — 원본 폴드와 판정 전제에서 쓴다.")
    L.append("      const RESULT = [")
    for seg in ("NRU", "RU"):
        for v in (A, B):
            rs = [r for r in state["result"] if r["ver"] == v and r["seg"] == seg]
            if not rs:
                continue
            clear = sum(int(r["n"]) for r in rs if (r["result"] or "").lower().startswith("clear"))
            fail  = sum(int(r["n"]) for r in rs) - clear
            L.append('        { ver:%s, seg:%s, clear:%d, fail:%d },' % (j(v), j(seg), clear, fail))
    L.append("      ];")

    L.append("      const BALANCE_US = [")
    us = [r for r in state["balance"] if r["country"] == "US"]
    for os_ in sorted({r["os"] for r in us},
                      key=lambda o: -sum(int(r["users"]) for r in us if r["os"] == o)):
        a = sum(int(r["users"]) for r in us if r["os"] == os_ and r["ver"] == A)
        b = sum(int(r["users"]) for r in us if r["os"] == os_ and r["ver"] == B)
        L.append("        { os:%s, a:%d, b:%d }," % (j(os_), a, b))
    L.append("      ];")

    L.append("      // vo = 485·486 이 아닌 다른 빌드의 DAU 합. OTHER_VERS 가 비어 있지 않으면 그 빌드가")
    L.append("      // 실제로 떴다는 뜻이고, 487 이상이 섞이면 그 뒤 날짜는 A/B 대조가 아니다.")
    L.append("      const VERSION = [")
    others = set()
    for d in sorted({r["d"] for r in state["version"]}):
        rs = [r for r in state["version"] if r["d"] == d]
        a  = sum(int(r["dau"]) for r in rs if r["ver"] == A)
        b  = sum(int(r["dau"]) for r in rs if r["ver"] == B)
        vo = sum(int(r["dau"]) for r in rs if r["ver"] not in (A, B))
        others |= {r["ver"] for r in rs if r["ver"] not in (A, B)}
        L.append("        { d:%s, vo:%d, a:%d, b:%d }," % (j(d), vo, a, b))
    L.append("      ];")
    L.append("      const OTHER_VERS = [%s];" % ", ".join(j(v) for v in sorted(others)))
    L.append("      /* DATA:END */")
    return "\n".join(L), rng


# ── 파일 반영 ───────────────────────────────────────────────────────────────
def splice(block):
    """DATA 블록과 SQL 블록을 둘 다 재생성한다.

    SQL 을 문서에 심는 이유: 손으로 유지하는 사본은 반드시 갈라진다. 실제로 한 번 갈라져서
    '문서에 실린 쿼리로는 문서의 값이 재현되지 않는' 상태가 됐었다(2026-09-07 수정).
    """
    s = open(HTML, encoding="utf-8").read()
    a = s.index("      /* DATA:START */")
    b = s.index("      /* DATA:END */") + len("      /* DATA:END */")
    new = s[:a] + block + s[b:]

    esc = SQL.strip().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    a = new.index("            <!-- SQL:START -->")
    b = new.index("            <!-- SQL:END -->") + len("            <!-- SQL:END -->")
    new = (new[:a] + "            <!-- SQL:START -->\n"
           + '            <div class="table-scroll"><pre>' + esc + "</pre></div>\n"
           + "            <!-- SQL:END -->" + new[b:])
    return s, new


def stamp(now, bust, rng):
    s = open(HTML, encoding="utf-8").read()
    s = re.sub(r"문서 갱신 <b>[^<]*</b> KST", "문서 갱신 <b>%s</b> KST" % now, s, count=1)
    s = re.sub(r"데이터 <b>[^<]*</b>", "데이터 <b>%s</b>" % rng, s, count=1)
    open(HTML, "w", encoding="utf-8").write(s)

    d = open(DATA_JS, encoding="utf-8").read()
    d = re.sub(r'(\n  updated: ")[^"]*(")', r"\g<1>%s\g<2>" % now, d, count=1)
    m = re.search(r'(url: "docs/sol-tournament-slot-ab\.html".*?)version: "v(\d+)\.(\d+)"',
                  d, re.S)
    if m:
        ver = 'version: "v%s.%d"' % (m.group(2), int(m.group(3)) + 1)
        d = d[:m.start()] + m.group(1) + ver + d[m.end():]
    # 카드의 updated (url 뒤쪽 블록 안) 갱신
    d = re.sub(r'(url: "docs/sol-tournament-slot-ab\.html".*?updated: ")[^"]*(")',
               r"\g<1>%s\g<2>" % now, d, count=1, flags=re.S)
    open(DATA_JS, "w", encoding="utf-8").write(d)

    i = open(INDEX, encoding="utf-8").read()
    i = re.sub(r"data\.js\?v=\d{12}", "data.js?v=" + bust, i)
    open(INDEX, "w", encoding="utf-8").write(i)


def git(*args):
    return subprocess.run(["git", "-C", REPO] + list(args),
                          capture_output=True, text=True, timeout=300)


def enabled():
    """제어판(scripts/control_panel.py)이 끈 작업은 아무것도 하지 않는다.
    launchd 를 껐다 켜는 것보다 이쪽이 안전하다 — 스케줄 정의를 건드리지 않는다."""
    try:
        reg = json.load(open(REGISTRY, encoding="utf-8"))
        return bool(reg["jobs"][JOB_ID]["enabled"])
    except Exception:
        return True          # 레지스트리가 깨졌으면 멈추지 않는다


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="꺼져 있어도 실행")
    a = ap.parse_args()

    if not a.force and not enabled():
        log("건너뜀 — 제어판에서 꺼져 있다 (%s)" % JOB_ID)
        return 0

    try:
        blocks = run_query()
        state  = json.load(open(STATE, encoding="utf-8")) if os.path.exists(STATE) else {}
        state  = merge_state(state, blocks)
        check(state)
        block, rng = build_js(state)
        old, new   = splice(block)
    except Guard as e:
        log("중단(가드): %s" % e)
        notify(str(e))
        return 1
    except Exception as e:
        log("중단(예외): %s: %s" % (type(e).__name__, e))
        notify("%s: %s" % (type(e).__name__, e))
        return 1

    # PULLED(조회 시각)는 매 실행마다 바뀐다. 그것만 다르면 데이터는 그대로라는 뜻이므로
    # 커밋하지 않는다 — 안 그러면 같은 값을 매일 새 커밋으로 쌓는다.
    strip = lambda t: re.sub(r'\n *const PULLED = "[^"]*";', "", t)
    if strip(old) == strip(new):
        log("변화 없음 — 커밋하지 않는다 (last_day=%s)" % state["last_day"])
        return 0
    if a.dry_run:
        log("dry-run: 변화 있음 (last_day=%s, 기간=%s) — 파일은 건드리지 않았다"
            % (state["last_day"], rng))
        return 0

    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(state, open(STATE, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1, sort_keys=True)
    open(HTML, "w", encoding="utf-8").write(new)
    now  = datetime.datetime.now()
    stamp(now.strftime("%Y-%m-%d %H:%M"), now.strftime("%Y%m%d%H%M"), rng)

    git("add", "-A")
    msg = "[Max] 슬롯 A/B 자동 갱신 — %s 까지 (%s)" % (state["last_day"], rng)
    r = git("commit", "-q", "-m", msg)
    if r.returncode != 0:
        log("커밋 실패: %s" % (r.stderr or r.stdout).strip()[:300])
        notify("커밋 실패")
        return 1
    if a.no_push:
        log("커밋 완료(푸시 생략): %s" % msg)
        return 0
    r = git("push", "-q", "origin", "HEAD")
    if r.returncode != 0:
        log("푸시 실패: %s" % (r.stderr or r.stdout).strip()[:300])
        notify("푸시 실패 — 인증이 만료됐을 수 있습니다")
        return 1
    log("갱신 완료: %s" % msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
