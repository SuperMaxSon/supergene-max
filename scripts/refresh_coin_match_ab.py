#!/usr/bin/env python3
"""토너먼트 연속 거절 차단 A/B 문서 자동 갱신.

흐름
    bq query (블록당 1행 JSON)
      -> docs/data/coin-match-ab.json 에 병합   (코호트 축 있는 블록은 날짜 키 머지)
      -> docs/coin-match-tournament-reject-ab.html 의 DATA:START~DATA:END 재생성
      -> 가드 통과 + 내용 변화 있을 때만 커밋/푸시

설계 원칙 (refresh_sol_slot_ab.py 와 동일)
    · 오늘(부분일)은 절대 읽지 않는다. 쿼리의 마지막 날은 항상 어제다.
    · 멱등하다. 같은 데이터가 나오면 아무것도 커밋하지 않는다.
    · 페이지는 fetch 를 쓰지 않는다 — 데이터를 HTML 에 직접 심어 자기완결로 둔다.
      JSON 은 스크립트의 누적 상태(state)일 뿐이다.
    · 이미 가진 날짜는 다시 읽지 않는다. state 에 없는 날짜만 조회하므로 평소에는
      '어제' 하루뿐이고, 맥이 며칠 꺼져 있었으면 빠진 날짜만 정확히 메운다.
    · 「유저-일」은 기간 고유 유저가 아니다. 기간 고유 player_id 는 날짜별로 더할 수
      없어 증분과 양립하지 않으므로, 날짜별 고유 유저의 합을 쓴다. 두 군의 배분이
      반반인지 보는 값이고 어떤 비율의 분모도 아니다(비율 분모는 sessions).

데이터 소스
    · KPI 보드  raw.coin_match          — 결손일만, 평소 1일 0.59 GiB
    · 리텐션    stat.coin_match_prod_nru_retention3 — 사전집계, raw 스캔 0

사용
    python3 scripts/refresh_coin_match_ab.py             # 조회 -> 갱신 -> 커밋/푸시
    python3 scripts/refresh_coin_match_ab.py --no-push   # 커밋만
    python3 scripts/refresh_coin_match_ab.py --dry-run   # 파일도 안 건드림
"""
import datetime
import json
import os
import subprocess
import sys

import refresh_common as C
from refresh_common import Guard, git, j, log, merge_by_key, notify, stamp

REPO    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML    = os.path.join(REPO, "docs", "coin-match-tournament-reject-ab.html")
STATE   = os.path.join(REPO, "docs", "data", "coin-match-ab.json")

BQ       = "/opt/homebrew/bin/bq"
PROJECT  = "game-log-359704"
EXP_FROM = "2026-08-27"      # 두 빌드가 함께 서빙되기 시작한 날
A, B     = "3374", "3375"
DOC_URL  = "docs/coin-match-tournament-reject-ab.html"
JOB_ID   = "coin-match-reject-ab"

C.configure(job_id=JOB_ID, log_prefix="[cm] ", notify_title="코인매치 A/B 갱신 실패",
            html=HTML, state=STATE, doc_url=DOC_URL,
            commit_msg="[Max] 코인매치 연속거절 A/B 자동 갱신 — %s 까지 (%s)")

SQL = r"""
WITH base AS (
    -- 아직 state 에 없는 날짜만 읽는다. 아래 log_date 목록은 스크립트가 채운다.
    -- 평소에는 '어제' 하루뿐이라 0.59 GiB 이고, 맥이 며칠 꺼져 있었으면 빠진 날짜만 정확히 메운다.
    -- 지난 날짜의 로그는 불변이므로 이미 가진 날을 다시 읽지 않는다.
    -- 아래 core 가 날짜별로 집계하고, 문서 쪽에서 날짜를 합산해 기간 값을 만든다.
    -- ⚠ 이 방식이 성립하는 이유: 보드의 모든 지표가 '더할 수 있는' 카운트다.
    --    COUNTIF 는 당연히 더해지고, sessions/sessions_300s 도 session_key 가 하루에만
    --    속하므로(로그인은 한 번) 날짜별 distinct 를 더하면 기간 distinct 와 같다.
    --    기간 고유 유저만은 날짜별로 더할 수 없어서, 「유저」 행은 유저-일(날짜별 고유의 합)로
    --    쓴다. 배분이 반반인지 보는 값이라 그 편이 활동량까지 반영해 더 낫고, 조회가 0이다.
    SELECT
        CASE WHEN client_version = 3375 THEN 'B' ELSE 'A' END AS ab_group,
        log_date,
        player_id,
        CONCAT(CAST(player_id AS STRING), '_', CAST(logincount_total AS STRING)) AS session_key,
        event
    FROM `game-log-359704.raw.coin_match`
    WHERE log_date IN UNNEST([{DAYS}])
      AND client_version IN (3374, 3375)
),
core AS (
    SELECT
        ab_group,
        log_date,
        COUNT(DISTINCT CASE WHEN event = '1000_LOGIN_COMPLETE' THEN player_id END)   AS users_day,
        COUNT(DISTINCT CASE WHEN event = '1000_LOGIN_COMPLETE' THEN session_key END) AS sessions,
        COUNTIF(event = '2100_GAMEPLAY_START')              AS play_starts,
        COUNTIF(event = '2300_GAMEPLAY_FINISH')             AS play_finishes,
        COUNT(DISTINCT CASE WHEN event = '1170_PLAYTIME_300S' THEN session_key END) AS sessions_300s,
        COUNTIF(event = '3100_TOURNAMENT_CREATE')           AS tc_try,
        COUNTIF(event = '3110_TOURNAMENT_CREATE_SUCCESS')   AS tc_success,
        COUNTIF(event = '3130_TOURNAMENT_CREATE_SUPPRESSED') AS tc_suppressed,
        COUNTIF(event = '3200_TOURNAMENT_SHARE')            AS ts_try,
        COUNTIF(event = '3210_TOURNAMENT_SHARE_SUCCESS')    AS ts_success,
        COUNTIF(event = '3400_MSG_P2P')                     AS p2p_try,
        COUNTIF(event = '3410_MSG_P2P_SUCCESS')             AS p2p_success,
        COUNTIF(event = '3500_FEED_SHARE')                  AS feed_try,
        COUNTIF(event = '3510_FEED_SHARE_SUCCESS')          AS feed_success,
        COUNTIF(event = '3000_SWITCH_CONTEXT_START')        AS sc_try,
        COUNTIF(event = '3010_SWITCH_CONTEXT_SUCCESS')      AS sc_success
    FROM base
    GROUP BY ab_group, log_date
),
-- 리텐션은 사전집계 테이블만 쓴다. dN 은 (social × country × os) 행별 비율이라
-- nru_count 로 가중해 재접속 '수'로 복원한다 — 두 비율 검정에 분모가 필요하다.
ret AS (
    SELECT
        join_date,
        CASE WHEN client_version = 3375 THEN 'B' ELSE 'A' END AS ab_group,
        SUM(nru_count) AS cohort,
        SUM(CAST(ROUND(d1  * nru_count) AS INT64)) AS r1,
        SUM(CAST(ROUND(d2  * nru_count) AS INT64)) AS r2,
        SUM(CAST(ROUND(d3  * nru_count) AS INT64)) AS r3,
        SUM(CAST(ROUND(d4  * nru_count) AS INT64)) AS r4,
        SUM(CAST(ROUND(d5  * nru_count) AS INT64)) AS r5,
        SUM(CAST(ROUND(d6  * nru_count) AS INT64)) AS r6,
        SUM(CAST(ROUND(d7  * nru_count) AS INT64)) AS r7,
        SUM(CAST(ROUND(d8  * nru_count) AS INT64)) AS r8,
        SUM(CAST(ROUND(d9  * nru_count) AS INT64)) AS r9,
        SUM(CAST(ROUND(d10 * nru_count) AS INT64)) AS r10,
        SUM(CAST(ROUND(d11 * nru_count) AS INT64)) AS r11,
        SUM(CAST(ROUND(d12 * nru_count) AS INT64)) AS r12,
        SUM(CAST(ROUND(d13 * nru_count) AS INT64)) AS r13,
        SUM(CAST(ROUND(d14 * nru_count) AS INT64)) AS r14
    FROM `game-log-359704.stat.coin_match_prod_nru_retention3`
    WHERE join_date BETWEEN DATE '2026-08-27' AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
      AND client_version IN (3374, 3375)
    GROUP BY join_date, ab_group
),
-- 빌드 점유. 3376 이상이 뜨면 그 뒤 날짜는 A/B 대조가 아니다.
vers AS (
    SELECT log_date, client_version, COUNT(DISTINCT player_id) AS dau
    FROM `game-log-359704.raw.coin_match`
    WHERE log_date IN UNNEST([{DAYS}])
      AND event = '1000_LOGIN_COMPLETE'
    GROUP BY log_date, client_version
    HAVING dau >= 100
)
SELECT '0_META' AS blk, 1 AS rows_n,
    TO_JSON_STRING(STRUCT(
        FORMAT_DATETIME('%Y-%m-%d %H:%M', CURRENT_DATETIME('Asia/Seoul')) AS pulled_kst,
        DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AS last_day,
        DATE '2026-08-27' AS exp_from)) AS payload
UNION ALL SELECT '1_CORE', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    ab_group, FORMAT_DATE('%Y-%m-%d', log_date) AS d,
    users_day, sessions, play_starts, play_finishes, sessions_300s,
    tc_try, tc_success, tc_suppressed, ts_try, ts_success,
    p2p_try, p2p_success, feed_try, feed_success, sc_try, sc_success)
    ORDER BY log_date, ab_group)) FROM core
UNION ALL SELECT '2_RET', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    FORMAT_DATE('%Y-%m-%d', join_date) AS c, ab_group AS g, cohort,
    r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14)
    ORDER BY join_date, ab_group)) FROM ret
UNION ALL SELECT '3_VERSION', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    FORMAT_DATE('%Y-%m-%d', log_date) AS d, CAST(client_version AS STRING) AS ver, dau)
    ORDER BY log_date, client_version)) FROM vers
ORDER BY blk
"""


# ── 조회 ────────────────────────────────────────────────────────────────────
def missing_days(state):
    """아직 state["core"] 에 없는 날짜. 평소에는 [어제] 하나다.

    고정 창(예: 최근 3일)을 쓰면 이미 가진 날을 매번 다시 읽는 낭비가 생기고,
    반대로 창보다 긴 공백(맥이 주말에 꺼져 있었다)은 영구 결손으로 남는다.
    결손일만 읽으면 둘 다 해결된다.

    '가졌다'의 기준은 **두 군이 모두 있는 날**이다. 한쪽 군만 적재된 날을 가진 것으로
    치면 나머지 군이 영구 결손으로 남고, sum_core 가 그 군의 분모만 조용히 깎아
    보드의 모든 비율이 왜곡된다.

    empty_days 에 든 날짜는 조회해도 데이터가 없던 날이라 다시 요청하지 않는다.
    그러지 않으면 트래픽이 0인 날에서 결손 목록이 영구히 줄지 않아 자동화가 멈춘다.
    """
    first = datetime.date.fromisoformat(EXP_FROM)
    last  = datetime.date.today() - datetime.timedelta(days=1)
    byday = {}
    for r in state.get("core", []):
        byday.setdefault(r["d"], set()).add(r["ab_group"])
    have  = {d for d, gs in byday.items() if {"A", "B"} <= gs}
    empty = set(state.get("empty_days") or [])
    out, d = [], first
    while d <= last:
        k = d.isoformat()
        if k not in have and k not in empty:
            out.append(d)
        d += datetime.timedelta(days=1)
    return out


def run_query(days):
    if days:
        lst = ", ".join("DATE '%s'" % d.isoformat() for d in days)
    else:
        # 결손이 없어도 리텐션(stat)은 다시 읽어야 한다 — 지난 코호트의 D+n 이 매일 채워진다.
        # 도래하지 않은 날짜를 넣어 raw 스캔을 0으로 만든다.
        lst = "DATE '1970-01-01'"
    sql = SQL.replace("{DAYS}", lst)
    out = subprocess.run(
        [BQ, "query", "--use_legacy_sql=false", "--format=json", "--quiet",
         "--project_id=" + PROJECT, "--max_rows=100"],
        input=sql, capture_output=True, text=True, timeout=900)
    if out.returncode != 0:
        raise Guard("bq query 실패: " + (out.stderr or out.stdout).strip()[:500])
    rows = json.loads(out.stdout)
    blocks = {}
    for r in rows:
        payload = r.get("payload")
        blocks[r["blk"]] = json.loads(payload) if payload else None
    # 1_CORE 는 요청한 날에 3374/3375 트래픽이 하나도 없으면 정상적으로 빈다
    # (강제 업데이트로 두 빌드가 사라진 날 등). 그걸 실패로 보면 그 날짜가 영구 결손으로
    # 남아 매일 같은 요청을 반복하고 자동화가 멈춘다 — empty_days 로 기록해 넘긴다.
    empty = [b for b in ("0_META", "2_RET") if not blocks.get(b)]
    if empty:
        raise Guard("필수 블록이 비었다: " + ", ".join(empty))
    return blocks


# ── 병합 ────────────────────────────────────────────────────────────────────
def merge_state(state, blocks, days=()):
    meta = blocks["0_META"]
    if isinstance(meta, list):
        meta = meta[0]
    state["pulled_kst"] = meta["pulled_kst"]
    state["last_day"]   = meta["last_day"]

    fresh = blocks.get("1_CORE") or []

    # 요청했는데 두 군이 다 오지 않은 날은 저장하지 않는다. 어제는 적재 지연일 수 있어
    # 그대로 결손으로 남겨 다음 실행이 다시 읽게 하고, 그보다 과거인 날은 정말로 비어
    # 있는 날이므로 empty_days 에 넣어 영구 재요청을 끊는다.
    got = {}
    for r in fresh:
        got.setdefault(r["d"], set()).add(r["ab_group"])
    yesterday = meta["last_day"]
    edrop, marked = set(), set(state.get("empty_days") or [])
    for d in days:
        k = d.isoformat()
        if {"A", "B"} <= got.get(k, set()):
            continue
        edrop.add(k)
        if k != yesterday:
            marked.add(k)
            log("%s: 두 군 데이터가 없다 — 빈 날로 기록하고 다시 요청하지 않는다" % k)
        else:
            log("%s(어제): 데이터가 아직 안 찼다 — 다음 실행에서 다시 읽는다" % k)
    if marked:
        state["empty_days"] = sorted(marked)
    fresh = [r for r in fresh if r["d"] not in edrop]

    # ── 부분일 방어 ──
    # 한 번 저장된 날은 다시 읽지 않으므로, 적재 중인 파티션을 읽어 부분값이 박히면
    # 영구히 남는다. 여기서 그 날짜만 떨어내면 결손으로 남아 다음 실행이 다시 읽는다.
    # 가드로 예외를 던지지 않는 이유: 같은 실행에서 받아온 정상 날짜와 리텐션 갱신까지
    # 통째로 폐기되고, 결손 목록이 매일 늘어 비용이 오히려 증가했다.
    fresh = drop_partial(state, fresh)

    state["core"]    = merge_by_key(state.get("core", []), fresh, ["ab_group", "d"])
    state["version"] = merge_by_key(state.get("version", []), blocks.get("3_VERSION") or [],
                                    ["d", "ver"])
    # 리텐션은 코호트일 × 군 키로 병합한다. 지난 코호트의 D+n 은 나중에 채워진다.
    state["ret"] = merge_by_key(state.get("ret", []), blocks["2_RET"], ["c", "g"])
    return state


def drop_partial(state, fresh):
    """부분 적재로 보이는 날짜를 새 데이터에서 떨어낸다.

    기준은 **이미 저장된 최근 7일의 중앙값**이다. 실측 일간 변동은 88~105% 라
    0.5~1.5 밴드는 70% 적재를 그냥 통과시켰다. 0.75 미만만 부분일로 본다
    (급증은 부분 적재가 아니므로 상한은 두지 않는다).

    실험 초기 램프(08-27 -> 08-28 이 275%)에서는 중앙값이 의미가 없으므로,
    저장된 날이 3일 미만이면 판정하지 않는다.
    """
    have = {}
    for r in state.get("core", []):
        have[r["d"]] = have.get(r["d"], 0) + int(r["users_day"])
    if len(have) < 3:
        return fresh
    ref = sorted(have[d] for d in sorted(have)[-7:])
    med = ref[len(ref) // 2]
    if not med:
        return fresh

    new = {}
    for r in fresh:
        new[r["d"]] = new.get(r["d"], 0) + int(r["users_day"])
    bad = set()
    for d, v in new.items():
        if v < med * 0.75:
            bad.add(d)
            log("%s: 유저-일 %d 이 최근 중앙값 %d 의 %.0f%% — 부분 적재로 보고 저장하지 않는다"
                % (d, v, med, v / med * 100))
    return [r for r in fresh if r["d"] not in bad]


# ── 가드 ────────────────────────────────────────────────────────────────────
def check(state):
    y = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    if state["last_day"] != y:
        raise Guard("마지막 날(%s)이 어제(%s)가 아니다 — 적재가 안 끝났거나 시각이 어긋났다"
                    % (state["last_day"], y))

    # 결손일이 남아 있으면 보드 합계가 조용히 틀린다. 부분일은 drop_partial 이 이미
    # 떨궈 결손으로 만들었으므로, 여기서는 '어제를 제외한 구멍'만 실패로 본다.
    gaps = [d.isoformat() for d in missing_days(state)
            if d.isoformat() != state["last_day"]]
    if gaps:
        raise Guard("중간 결손일 %d개 (%s…) — 보드 합계가 틀린다"
                    % (len(gaps), ", ".join(gaps[:3])))

    core = sum_core(state)
    for g in ("A", "B"):
        if g not in core:
            raise Guard("core 에 %s 군이 없다 — 대조군이 사라졌다" % g)
        if int(core[g]["users"]) < 1000:
            raise Guard("%s 군 유저가 %s명뿐이다" % (g, core[g]["users"]))

    ua, ub = int(core["A"]["users"]), int(core["B"]["users"])
    if not (0.8 <= ub / ua <= 1.25):
        raise Guard("두 군 크기가 %.2f 배로 벌어졌다 (A %d / B %d) — 반반 서빙이 깨졌다"
                    % (ub / ua, ua, ub))

    # 유저-일은 날짜별 합산이라 줄어들 수 없다. 줄었다면 적재 이상이다.
    prev = state.get("prev_users")
    if prev and ua + ub < prev * 0.98:
        raise Guard("누적 유저가 %d -> %d 로 줄었다 — 적재 이상"
                    % (prev, ua + ub))
    state["prev_users"] = ua + ub

    # 처치 지표 존재 확인. A 에 차단 이벤트가 뜨면 빌드가 섞인 것이다.
    if int(core["A"]["tc_suppressed"]) > 0:
        raise Guard("A(3374)에 차단 이벤트가 %s건 있다 — 빌드 배정이 오염됐다"
                    % core["A"]["tc_suppressed"])
    if int(core["B"]["tc_suppressed"]) == 0:
        raise Guard("B(3375)에 차단 이벤트가 0건이다 — 처치가 동작하지 않는다")

    cohorts = sorted({r["c"] for r in state["ret"]})
    if len(cohorts) < 2:
        raise Guard("리텐션 코호트가 %d개뿐이다" % len(cohorts))

    others = sorted({r["ver"] for r in state["version"]} - {A, B})
    big = [v for v in others if v.isdigit() and int(v) > int(B)]
    if big:
        log("⚠ 경고: %s 이상 빌드가 떴다 — 그 뒤 날짜는 A/B 대조가 아니다" % big)


# ── JS 블록 생성 ────────────────────────────────────────────────────────────
def pct(num, den):
    return round(num / den * 100, 2) if den else 0.0


def sum_core(state):
    """날짜별 core 행을 군별로 합산해 기간 값을 만든다.

    보드의 모든 지표가 더할 수 있는 카운트라서 성립한다 — COUNTIF 는 물론이고
    sessions/sessions_300s 도 session_key 가 하루에만 속하므로 날짜별 distinct 를
    더하면 기간 distinct 와 같다. 기간 고유 유저만은 날짜별로 더할 수 없어서,
    「유저-일」 행은 날짜별 고유 유저의 합으로 쓴다 — 추가 조회 없이 전 기간을 담는다.
    """
    out = {}
    for r in state["core"]:
        g = out.setdefault(r["ab_group"], {})
        for k, v in r.items():
            if k in ("ab_group", "d"):
                continue
            g[k] = g.get(k, 0) + int(v)
    # 「유저」 행은 두 군이 반반으로 서빙됐는지 확인하는 용도이고 어떤 비율의 분모도 아니다.
    # 예전에는 기간 고유 player_id 를 쓰려고 8/27~어제 전 구간을 주 1회 다시 읽었다(5.73 GiB/월 23 GiB).
    # 그 값은 날짜별로 더할 수 없어 증분이 불가능했기 때문이다.
    # 유저-일(날짜별 고유 유저의 합)로 바꾸면 이미 읽은 결손일 조회에서 나오므로 추가 조회가 0이고,
    # 전 기간을 쓰며, 배분 판정에는 같은 답을 준다(0.24% -> 0.36%).
    for g in out:
        out[g]["users"] = out[g].get("users_day", 0)
    return out


def build_js(state):
    c = sum_core(state)
    a, b = c["A"], c["B"]

    # 리텐션 코호트 크기 — NRU 코호트 행은 실험 첫 5일(8/27~8/31) 코호트의 합이다.
    NRU_TO = "2026-08-31"   # 연도 포함 — 키가 YYYY-MM-DD 라 "08-31" 로는 문자열 비교가 항상 거짓이 된다
    coh = {g: sum(int(r["cohort"]) for r in state["ret"]
                  if r["g"] == g and r["c"] <= NRU_TO) for g in ("A", "B")}

    def pair(fn):
        return [fn(a), fn(b)]

    V = [
        ("users",             pair(lambda x: x["users"]),                                  0),
        ("sessions",          pair(lambda x: x["sessions"]),                               0),
        ("nru_cohort",        [coh["A"], coh["B"]],                                        0),
        ("sc_rate",           pair(lambda x: pct(x["sc_success"], x["sc_try"])),           2),
        ("plays_per_user",    pair(lambda x: round(x["play_starts"] / x["users"], 2)),     2),
        ("plays_per_session", pair(lambda x: round(x["play_starts"] / x["sessions"], 2)),  2),
        ("finish_rate",       pair(lambda x: pct(x["play_finishes"], x["play_starts"])),   2),
        ("sess300_rate",      pair(lambda x: pct(x["sessions_300s"], x["sessions"])),      2),
        ("tc_try_pu",         pair(lambda x: round(x["tc_try"] / x["users"], 2)),          2),
        ("tc_sup_pu",         pair(lambda x: round(x["tc_suppressed"] / x["users"], 2)),   2),
        ("tc_rate",           pair(lambda x: pct(x["tc_success"], x["tc_try"])),           2),
        ("tc_ok_pu",          pair(lambda x: round(x["tc_success"] / x["users"], 3)),      3),
        ("ts_rate",           pair(lambda x: pct(x["ts_success"], x["ts_try"])),           2),
        ("p2p_try_pu",        pair(lambda x: round(x["p2p_try"] / x["users"], 2)),         2),
        ("p2p_rate",          pair(lambda x: pct(x["p2p_success"], x["p2p_try"])),         2),
        ("feed_try_pu",       pair(lambda x: round(x["feed_try"] / x["users"], 2)),        2),
        ("feed_rate",         pair(lambda x: pct(x["feed_success"], x["feed_try"])),       2),
    ]

    days   = sorted({r["c"] for r in state["ret"]})
    md     = lambda d: "%d/%d" % (int(d[5:7]), int(d[8:10]))  # "2026-09-06" -> "9/6"
    rng    = "%s~%s" % (md(days[0]), md(days[-1]))

    L = []
    L.append("      /* DATA:START */")
    L.append('      const PULLED = %s;' % j(state["pulled_kst"]))
    L.append('      const RANGE  = %s;' % j(rng))
    L.append("")
    L.append("      // V — 지표 키 → [A(3374), B(3375)]. 날짜별로 조회해 누적한 값을 기간 합산한 것이다.")
    L.append("      //     users 는 '유저-일'(날짜별 고유 유저의 합)이며 기간 고유 유저가 아니다 —")
    L.append("      //     기간 고유 player_id 는 날짜별로 더할 수 없어 증분 갱신과 양립하지 않는다.")
    L.append("      //     '/유저-일' 행들의 분모가 이 값이고, 비율 지표의 분모는 sessions 다.")
    L.append("      const V = {")
    w = max(len(k) for k, _, _ in V) + 1
    for k, (va, vb), dp in V:
        fmt = (lambda v: "%d" % v) if dp == 0 else (lambda v, d=dp: ("%%.%df" % d) % v)
        L.append("        %-*s [%s, %s]," % (w, k + ":", fmt(va), fmt(vb)))
    L.append("      };")
    L.append("")
    L.append("      // TRI — [코호트일, A코호트, B코호트, {D+n: [A 재접속수, B 재접속수]}]")
    L.append("      // 출처: stat.coin_match_prod_nru_retention3 (raw 스캔 0). d1~d14 비율 × nru_count 로 카운트 복원.")
    L.append("      // 코호트일 축이 있어 갱신 시 날짜 키로 병합된다.")
    L.append("      const TRI = [")

    for cday in days:
        rs = {r["g"]: r for r in state["ret"] if r["c"] == cday}
        if "A" not in rs or "B" not in rs:
            continue
        ca, cb = int(rs["A"]["cohort"]), int(rs["B"]["cohort"])
        # D+n 이 실제로 도래했는지는 코호트일 기준으로 판정한다.
        # stat 은 하루 지연이므로 관측 가능한 마지막 날은 last_day 다.
        cd   = datetime.date.fromisoformat(cday)
        last = datetime.date.fromisoformat(state["last_day"])
        obs  = (last - cd).days
        cells = {}
        for n in range(1, 15):
            if n > obs:
                continue
            cells[str(n)] = [int(rs["A"]["r%d" % n]), int(rs["B"]["r%d" % n])]
        L.append('        [%s,%d,%d,%s],' % (j(cday[5:]), ca, cb, j(cells)))
    L.append("      ];")
    L.append("      /* DATA:END */")
    return "\n".join(L), rng


def splice(block):
    s = open(HTML, encoding="utf-8").read()
    a = s.index("      /* DATA:START */")
    b = s.index("      /* DATA:END */") + len("      /* DATA:END */")
    return s, s[:a] + block + s[b:]


def main():
    a = C.parse_args()
    if not a.force and not C.enabled():
        log("건너뜀 — 제어판에서 꺼져 있다 (%s)" % JOB_ID)
        return 0

    try:
        state  = json.load(open(STATE, encoding="utf-8")) if os.path.exists(STATE) else {}
        days   = missing_days(state)
        log("읽을 날짜 %d일%s" % (len(days),
            (" (" + ", ".join(d.isoformat() for d in days) + ")") if days else " — raw 스캔 0"))
        blocks = run_query(days)
        state  = merge_state(state, blocks, days)
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

    return C.finish(a, state, rng, old, new, dry_dump=block)


if __name__ == "__main__":
    sys.exit(main())
