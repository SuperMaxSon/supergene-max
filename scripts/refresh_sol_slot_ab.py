#!/usr/bin/env python3
"""판 클리어 초대 제거 A/B 문서 자동 갱신.

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
import datetime
import json
import os
import sys

import refresh_common as C
from refresh_common import Guard, bq_query, j, log, merge_by_key, notify

REPO    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML    = os.path.join(REPO, "docs", "sol-tournament-slot-ab.html")
STATE   = os.path.join(REPO, "docs", "data", "sol-slot-ab.json")
DOC_URL = "docs/sol-tournament-slot-ab.html"
JOB_ID  = "sol-slot-ab"

C.configure(job_id=JOB_ID, log_prefix="", notify_title="슬롯 A/B 갱신 실패",
            html=HTML, state=STATE, doc_url=DOC_URL,
            commit_msg="[Max] 슬롯 A/B 자동 갱신 — %s 까지 (%s)")

EXP_FROM = "2026-09-03"          # 실험 시작일
A, B     = "485", "486"

SQL = r"""-- 이 문서를 채우는 쿼리다. scripts/refresh_sol_slot_ab.py 가 매일 KST 09시(scripts/automation.json 기준)에 이 문자열을
-- 그대로 실행하고, 같은 문자열을 문서의 SQL 폴드에 심는다 — 사본이 갈라질 수 없다.
--
-- 스캔 원칙
--  · 오늘은 절대 넣지 않는다. 마지막 날은 항상 어제다(log_date 는 KST 기준).
--  · 무거운 컬럼(data · entrypoint_now)은 최근 3일만 읽는다. 그 이전은 이미 뽑혀 있고 불변이다.
--  · raw 스캔은 이 3일 창 하나뿐이다. DAU·빌드 점유·배정 균형은 stat 사전집계에서 뽑는다.
--  · 초대(3460 position)와 유입(payload.social)만 raw 전용이다 — stat 에 그 차원이 없다.
--  · 리텐션은 raw 조인을 쓰지 않는다. stat 사전집계를 읽는다.
--  · 블록을 쪼개지 않는다. 하나만 다시 뽑으면 블록을 가로지르는 값이 조용히 어긋난다.
WITH us AS (
    SELECT log_date, player_id, event, data, entrypoint_now, client_version
    FROM `game-log-359704.raw.solitaire_city_journey`
    WHERE log_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
                       AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        AND country = 'US'
),
slog AS (
    -- 로그인 사전집계. 예전에는 이 몫도 raw 전 구간을 훑었다(0.33 GiB, 실험이 길어지면 계속 증가).
    -- stat 에 같은 차원이 다 있어 옮겼다 — 이제 스캔량이 기간과 무관하게 고정된다.
    -- ⚠ player_type 은 ALL 만 읽는다. ALL/NRU/RU 가 같은 유저를 중복 적재하므로 섞으면 2배가 된다.
    SELECT log_date, client_version, IFNULL(country, '(null)') AS country,
           IFNULL(os, '(null)') AS os, player_count
    FROM `game-log-359704.stat.solitaire_city_journey`
    WHERE log_date BETWEEN DATE '2026-09-03' AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        AND stat_name = '1000_LOGIN_COMPLETE'
        AND player_type = 'ALL'
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
    -- 배정 균형만 국가 필터를 뺀다. FB 가 지역으로 갈랐는지 보려면 US 밖이 필요하다.
    -- ⚠ 어제 하루 기준이다. stat 은 날짜별 유니크만 갖고 있어 여러 날을 더하면 유저가 중복된다
    --   (HLL 테이블에 버전·OS 차원이 없어 기간 누적 유니크를 만들 수 없다).
    --   묻는 것이 '배정이 한쪽으로 쏠렸나'라 하루 구성만으로 답이 나온다.
    SELECT client_version, country, os, player_count AS users
    FROM slog
    WHERE client_version IN (485, 486)
        AND log_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        AND player_count >= 10
),
vers AS (
    -- 실험이 아직 성립하는지부터 본다. 485 가 말라 있으면 대조군이 없는 것이고,
    -- 487 이상이 떴으면 처치가 하나 더 얹힌 것이라 486군이 오염된다.
    -- os 축을 합치므로 하루에 두 OS 로 접속한 유저가 중복된다 — 실측 오차 0.3%(1,232 vs 1,228)로
    -- '대조군이 살아 있나 / 새 빌드가 떴나' 판정에는 영향이 없다.
    SELECT log_date, client_version, SUM(player_count) AS dau
    FROM slog
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


# ── 조회 ────────────────────────────────────────────────────────────────────
def run_query():
    rows = bq_query(SQL)
    blocks = {}
    for r in rows:
        payload = r.get("payload")
        blocks[r["blk"]] = json.loads(payload) if payload else None
    missing = [b for b in ("0_META", "1_DAILY", "3_RET", "7_VERSION") if not blocks.get(b)]
    if missing:
        raise Guard("필수 블록이 비었다: " + ", ".join(missing))
    return blocks


# ── 병합 ────────────────────────────────────────────────────────────────────
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

    # 중간 결손 검사. us CTE 는 최근 3일 고정 창이라(dist/res 가 날짜축 없는 롤링이어서
    # 그 창이 필요하다) 맥이 나흘 넘게 꺼져 있으면 그 사이 날짜가 영구히 빈다.
    # daily 는 날짜별 합산으로 보드를 만들므로, 구멍이 있으면 합계가 조용히 작아진다.
    # 자기치유는 못 하니 최소한 조용히 틀리지는 않게 여기서 세운다.
    want = []
    d = datetime.date.fromisoformat(EXP_FROM)
    while d <= datetime.date.fromisoformat(state["last_day"]):
        want.append(d.strftime("%m-%d"))
        d += datetime.timedelta(days=1)
    gaps = [k for k in want if k not in set(days)]
    if gaps:
        raise Guard("중간 결손일 %d개 (%s) — 보드 합계가 틀린다. us 창(3일)보다 긴 공백이라 "
                    "자동 복구되지 않는다: 창을 늘려 1회 수동 실행할 것"
                    % (len(gaps), ", ".join(gaps[:5])))

    # 부분 적재 검사. 전일 대비 ±50% 밴드는 70% 적재를 그냥 통과시켰다(실측 일간 변동은
    # 88~105%). 최근 7일 중앙값의 75% 미만만 부분일로 본다 — 급증은 부분 적재가 아니므로
    # 상한은 두지 않는다. 실험 초기 램프에서는 중앙값이 의미 없어 3일 미만이면 건너뛴다.
    dau = {d: sum(r["ud"] for r in state["daily"] if r["d"] == d) for d in days}
    if len(days) >= 3:
        ref = sorted(dau[k] for k in days[-7:])
        med = ref[len(ref) // 2]
        last = days[-1]
        if med and dau[last] < med * 0.75:
            raise Guard("%s DAU %d 이 최근 중앙값 %d 의 %.0f%% — 부분 적재로 보인다"
                        % (last, dau[last], med, dau[last] / med * 100))
    last = days[-1]
    for v in (A, B):
        if not any(r["ver"] == v for r in state["daily"] if r["d"] == last):
            raise Guard("%s 마지막 날에 빌드 %s 행이 없다 — 대조군이 사라졌다" % (last, v))
    others = sorted({r["ver"] for r in state["version"]} - {A, B})
    if any(int(v) > int(B) for v in others):
        log("⚠ 경고: %s 이상 빌드가 떴다 — 그 뒤 날짜는 A/B 대조가 아니다" % others)


# ── JS 블록 생성 ────────────────────────────────────────────────────────────
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


def main():
    a = C.parse_args()
    if not a.force and not C.enabled():
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

    return C.finish(a, state, rng, old, new)


if __name__ == "__main__":
    sys.exit(main())
