#!/usr/bin/env python3
"""CP 원격설정 3380 롤아웃 트래킹 문서 갱신 (수동/세션 루프 실행).

흐름
    bq query (블록당 1행 JSON)
      -> docs/data/coin-match-cp.json 에 날짜 키로 병합
      -> docs/coin-match-cp-3380.html 의 DATA:START~DATA:END 재생성
      -> 가드 통과 + 내용 변화 있을 때만 커밋/푸시

refresh_coin_match_ab.py 와 다른 점 — 이건 A/B 가 아니라 **롤아웃**이다
    · 두 군의 크기가 같을 이유가 없다. 신빌드는 0% 에서 시작해 100% 로 간다.
      따라서 '반반 서빙' 가드가 없고, 대신 신빌드가 사라졌는지만 본다.
    · 오늘(부분일)을 **일부러 읽는다**. 롤아웃 당일이 관측 대상이라 어제까지만 읽으면
      볼 것이 없다. 그래서 과거일은 state 에서 재사용하고 **오늘만 매번 다시 읽는다** —
      오늘 파티션 1회가 실행당 약 1.7 GiB 다. 매시 실행이면 하루 40 GiB 대이고,
      문서가 '부분일'임을 계속 표시하는 것으로 그 값을 정당화한다.
    · 문서는 지표마다 최소 분모를 들고 있어 표본 미달 행을 스스로 잠근다. 따라서
      스크립트는 '표본이 적다'를 가드로 막지 않는다 — 적은 채로 실어도 문서가 잠근다.

사용
    python3 scripts/refresh_coin_match_cp.py             # 조회 -> 갱신 -> 커밋/푸시
    python3 scripts/refresh_coin_match_cp.py --no-push   # 커밋만
    python3 scripts/refresh_coin_match_cp.py --dry-run   # 파일도 안 건드림
"""
import datetime
import json
import os
import sys

import refresh_common as C
from refresh_common import Guard, bq_query, j, log, merge_by_key, notify

REPO  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML  = os.path.join(REPO, "docs", "coin-match-cp-3380.html")
STATE = os.path.join(REPO, "docs", "data", "coin-match-cp.json")

FROM    = "2026-09-10"      # 3380 로그가 처음 보인 날(내부 QA 포함). 문서가 라이브 구간만 골라 쓴다.
OLD, NEW = "3375", "3380"
DOC_URL = "docs/coin-match-cp-3380.html"
JOB_ID  = "coin-match-cp"

C.configure(job_id=JOB_ID, log_prefix="[cp] ", notify_title="코인매치 CP 트래킹 갱신 실패",
            html=HTML, state=STATE, doc_url=DOC_URL,
            commit_msg="[Max] CP 3380 트래킹 갱신 — %s 까지 (%s)")

SQL = r"""
WITH base AS (
    -- state 에 없는 과거일 + 오늘. 오늘은 계속 쌓이는 중이라 매 실행 다시 읽는다.
    SELECT
        CAST(client_version AS STRING) AS ver,
        FORMAT_DATE('%Y-%m-%d', log_date) AS d,
        log_time, player_id, event,
        CONCAT(CAST(player_id AS STRING), '_', CAST(logincount_total AS STRING)) AS session_key,
        JSON_VALUE(data, '$.game')       AS game,
        JSON_VALUE(data, '$.error_code') AS ec
    FROM `game-log-359704.raw.coin_match`
    WHERE log_date IN UNNEST([{DAYS}])
),
scoped AS (SELECT * FROM base WHERE ver IN ('{OLD}', '{NEW}')),
core AS (
    SELECT ver, d,
        COUNT(DISTINCT IF(event='1000_LOGIN_COMPLETE', player_id, NULL))   AS users_day,
        COUNT(DISTINCT IF(event='1000_LOGIN_COMPLETE', session_key, NULL)) AS sessions,
        COUNT(DISTINCT IF(event='1170_PLAYTIME_300S', session_key, NULL))  AS sessions_300s,
        COUNTIF(event='2100_GAMEPLAY_START')          AS play_starts,
        COUNTIF(event='2300_GAMEPLAY_FINISH')         AS play_finishes,
        COUNTIF(event='4010_INTERSTITIAL_AD_FINISH')  AS it_ok,
        COUNTIF(event='4210_RV_FINISH')               AS rv_ok,
        COUNTIF(event='8990_CROSS_PROMO')             AS cp_impr,
        COUNTIF(event='8990_CROSS_PROMO_PLAY')        AS cp_play,
        COUNTIF(event='8990_CROSS_PROMO_FAIL')        AS cp_fail,
        COUNTIF(event='8990_CROSS_PROMO_EXIT')        AS cp_exit,
        COUNT(DISTINCT IF(event='8990_CROSS_PROMO', player_id, NULL)) AS cp_users,
        COUNTIF(event='9200_CLIENT_ERROR')            AS client_err
    FROM scoped GROUP BY ver, d
),
gm AS (
    SELECT ver, d, game,
        COUNTIF(event='8990_CROSS_PROMO')      AS impr,
        COUNTIF(event='8990_CROSS_PROMO_PLAY') AS play,
        COUNTIF(event='8990_CROSS_PROMO_FAIL') AS fail
    FROM scoped
    WHERE game IS NOT NULL
      AND event IN ('8990_CROSS_PROMO','8990_CROSS_PROMO_PLAY','8990_CROSS_PROMO_FAIL')
    GROUP BY ver, d, game
),
fc AS (
    SELECT ver, d, ec, COUNT(*) AS n
    FROM scoped WHERE event='8990_CROSS_PROMO_FAIL' GROUP BY ver, d, ec
),
-- PLAY 한 건마다 20초 창을 연다. 전환에 성공하면 페이지가 언로드돼 성공 로그가 없으므로
-- FAIL 이 안 붙은 PLAY 를 성공의 대리 지표로 쓰고, 재로그인은 '대상 게임 대신 우리 게임이
-- 다시 뜬' 경우로 센다. 창을 넓히면 그냥 돌아온 유저까지 섞인다.
play AS (SELECT ver, d, player_id, log_time FROM scoped WHERE event='8990_CROSS_PROMO_PLAY'),
ev AS (
    SELECT p.ver, p.d, p.player_id, p.log_time,
        MAX(IF(o.event='8990_CROSS_PROMO_FAIL',1,0)) AS failed,
        MAX(IF(o.event='1000_LOGIN_COMPLETE',1,0))   AS restarted
    FROM play p LEFT JOIN scoped o
      ON o.player_id = p.player_id AND o.log_time > p.log_time
     AND o.log_time <= TIMESTAMP_ADD(p.log_time, INTERVAL 20 SECOND)
     AND o.event IN ('8990_CROSS_PROMO_FAIL','1000_LOGIN_COMPLETE')
    GROUP BY 1,2,3,4
),
pe AS (
    SELECT ver, d, COUNT(*) AS plays, SUM(failed) AS fail20, SUM(restarted) AS restart20
    FROM ev GROUP BY ver, d
),
-- 빌드 점유. 3381 이상이 뜨면 이 문서의 대조 자체가 낡은 것이다.
vers AS (
    SELECT d, ver, COUNT(DISTINCT player_id) AS dau
    FROM base WHERE event='1000_LOGIN_COMPLETE'
    GROUP BY d, ver HAVING dau >= 20
)
SELECT '0_META' AS blk, TO_JSON_STRING(STRUCT(
    FORMAT_DATETIME('%Y-%m-%d %H:%M', CURRENT_DATETIME('Asia/Seoul')) AS pulled_kst,
    FORMAT_DATE('%Y-%m-%d', CURRENT_DATE()) AS today)) AS payload
UNION ALL SELECT '1_CORE', TO_JSON_STRING(ARRAY_AGG(STRUCT(
    ver, d, users_day, sessions, sessions_300s, play_starts, play_finishes,
    it_ok, rv_ok, cp_impr, cp_play, cp_fail, cp_exit, cp_users, client_err)
    ORDER BY d, ver)) FROM core
UNION ALL SELECT '2_GAME', TO_JSON_STRING(ARRAY_AGG(STRUCT(ver, d, game, impr, play, fail)
    ORDER BY ver, d, impr DESC)) FROM gm
UNION ALL SELECT '3_FAILCODE', TO_JSON_STRING(ARRAY_AGG(STRUCT(ver, d, ec, n)
    ORDER BY ver, d, n DESC)) FROM fc
UNION ALL SELECT '4_PLAYEVAL', TO_JSON_STRING(ARRAY_AGG(STRUCT(ver, d, plays, fail20, restart20)
    ORDER BY ver, d)) FROM pe
UNION ALL SELECT '5_VERSION', TO_JSON_STRING(ARRAY_AGG(STRUCT(d, ver, dau)
    ORDER BY d, ver)) FROM vers
ORDER BY blk
"""


# ── 조회 ────────────────────────────────────────────────────────────────────
def read_days(state):
    """읽을 날짜 = state 에 없는 과거일 + 오늘.

    오늘은 언제나 다시 읽는다 — 롤아웃 당일이 관측 대상이고, 그 파티션은 실행할 때마다
    자란다. 과거일은 불변이라 한 번 읽으면 끝이다(평소 실행은 오늘 하루뿐).
    """
    first = datetime.date.fromisoformat(FROM)
    today = datetime.date.today()
    have  = {r["d"] for r in state.get("core", [])}
    out, d = [], first
    while d < today:
        if d.isoformat() not in have:
            out.append(d)
        d += datetime.timedelta(days=1)
    out.append(today)
    return out


def run_query(days):
    sql = (SQL.replace("{DAYS}", ", ".join("DATE '%s'" % d.isoformat() for d in days))
              .replace("{OLD}", OLD).replace("{NEW}", NEW))
    blocks = {}
    for r in bq_query(sql):
        payload = r.get("payload")
        blocks[r["blk"]] = json.loads(payload) if payload else None
    if not blocks.get("0_META"):
        raise Guard("0_META 가 비었다 — 쿼리가 제대로 돌지 않았다")
    if not blocks.get("1_CORE"):
        raise Guard("1_CORE 가 비었다 — 두 빌드의 로그가 하나도 없다")
    return blocks


# ── 병합 ────────────────────────────────────────────────────────────────────
def merge_state(state, blocks):
    meta = blocks["0_META"]
    if isinstance(meta, list):
        meta = meta[0]
    state["pulled_kst"] = meta["pulled_kst"]
    state["last_day"]   = meta["today"]        # 오늘까지 읽는다 — 부분일임을 문서가 표시한다

    state["core"]     = merge_by_key(state.get("core", []),     blocks.get("1_CORE") or [],     ["ver", "d"])
    state["game"]     = merge_by_key(state.get("game", []),     blocks.get("2_GAME") or [],     ["ver", "d", "game"])
    state["failcode"] = merge_by_key(state.get("failcode", []), blocks.get("3_FAILCODE") or [], ["ver", "d", "ec"])
    state["playeval"] = merge_by_key(state.get("playeval", []), blocks.get("4_PLAYEVAL") or [], ["ver", "d"])
    state["version"]  = merge_by_key(state.get("version", []),  blocks.get("5_VERSION") or [],  ["d", "ver"])
    return state


# ── 가드 ────────────────────────────────────────────────────────────────────
def check(state):
    today = state["last_day"]
    rows  = {(r["ver"], r["d"]): r for r in state["core"]}

    if (NEW, today) not in rows:
        raise Guard("오늘(%s) %s 로그가 없다 — 롤아웃이 멈췄거나 적재가 안 됐다" % (today, NEW))
    if (OLD, today) not in rows:
        raise Guard("오늘(%s) %s 로그가 없다 — 대조군이 사라졌다" % (today, OLD))

    # 같은 날의 누적값은 줄어들 수 없다. 줄었다면 부분 적재를 덮어쓴 것이다.
    prev = state.get("prev_today") or {}
    if prev.get("d") == today:
        for ver in (OLD, NEW):
            was, now = int(prev.get(ver, 0)), int(rows[(ver, today)]["users_day"])
            if now < was * 0.98:
                raise Guard("%s 오늘 DAU 가 %d -> %d 로 줄었다 — 적재 이상" % (ver, was, now))
    state["prev_today"] = {"d": today,
                           OLD: int(rows[(OLD, today)]["users_day"]),
                           NEW: int(rows[(NEW, today)]["users_day"])}

    # 롤아웃은 균형을 맞추지 않는다. 다만 신빌드가 구버전을 이미 앞질렀으면
    # '대조군' 이라는 이름이 더는 맞지 않으므로 알린다(멈추지는 않는다).
    if int(rows[(NEW, today)]["users_day"]) > int(rows[(OLD, today)]["users_day"]):
        log("ℹ %s 가 %s 를 앞질렀다 — 곧 대조군이 사라진다. 판정 구간을 닫을 때다" % (NEW, OLD))

    newer = sorted({r["ver"] for r in state["version"]
                    if r["ver"].isdigit() and int(r["ver"]) > int(NEW)})
    if newer:
        log("⚠ 경고: %s 이상 빌드가 떴다 — 이 문서의 대조는 여기까지다" % newer)


# ── JS 블록 생성 ────────────────────────────────────────────────────────────
def build_js(state):
    L = ["      /* DATA:START */"]
    L.append('      const PULLED = %s;' % j(state["pulled_kst"]))
    L.append("")
    L.append("      // 일자 × 빌드. 보드는 여기서 기간을 합산해 만든다 — 모든 행이 더할 수 있는 카운트다.")
    L.append("      const DAILY = [")
    for r in sorted(state["core"], key=lambda r: (r["d"], r["ver"])):
        if not int(r["users_day"]):
            continue
        L.append('        { ver:"%s", d:"%s", ud:%d, ses:%d, s300:%d, ps:%d, pf:%d, it:%d, rv:%d,'
                 ' impr:%d, play:%d, fail:%d, ex:%d, cu:%d, err:%d },'
                 % (r["ver"], r["d"], int(r["users_day"]), int(r["sessions"]), int(r["sessions_300s"]),
                    int(r["play_starts"]), int(r["play_finishes"]), int(r["it_ok"]), int(r["rv_ok"]),
                    int(r["cp_impr"]), int(r["cp_play"]), int(r["cp_fail"]), int(r["cp_exit"]),
                    int(r["cp_users"]), int(r["client_err"])))
    L.append("      ];")
    L.append("")
    L.append("      // PLAY 한 건마다 20초 창을 열어 FAIL·재로그인을 붙인 결과. 창을 넘기면 다른 세션이 섞인다.")
    L.append("      const PLAYEVAL = [")
    for r in sorted(state["playeval"], key=lambda r: (r["ver"], r["d"])):
        L.append('        { ver:"%s", d:"%s", plays:%d, fail20:%d, restart20:%d },'
                 % (r["ver"], r["d"], int(r["plays"]), int(r["fail20"]), int(r["restart20"])))
    L.append("      ];")
    L.append("")
    L.append("      const GAME = [")
    for r in sorted(state["game"], key=lambda r: (r["ver"], r["d"], -int(r["impr"]))):
        L.append('        { ver:"%s", d:"%s", game:"%s", impr:%d, play:%d, fail:%d },'
                 % (r["ver"], r["d"], r["game"], int(r["impr"]), int(r["play"]), int(r["fail"])))
    L.append("      ];")
    L.append("")
    L.append("      const FAILCODE = [")
    for r in sorted(state["failcode"], key=lambda r: (r["ver"], r["d"], -int(r["n"]))):
        L.append('        { ver:"%s", d:"%s", ec:"%s", n:%d },' % (r["ver"], r["d"], r["ec"], int(r["n"])))
    L.append("      ];")
    L.append("")
    L.append("      const VERSION = [")
    for r in sorted(state["version"], key=lambda r: (r["d"], r["ver"])):
        L.append('        { d:"%s", ver:"%s", dau:%d },' % (r["d"], r["ver"], int(r["dau"])))
    L.append("      ];")
    L.append("      /* DATA:END */")

    days = sorted({r["d"] for r in state["core"]})
    md   = lambda d: "%d/%d" % (int(d[5:7]), int(d[8:10]))
    return "\n".join(L), "%s~%s" % (md(days[0]), md(days[-1]))


def splice(block):
    s = open(HTML, encoding="utf-8").read()
    a = s.index("      /* DATA:START */")
    b = s.index("      /* DATA:END */") + len("      /* DATA:END */")
    return s, s[:a] + block + s[b:]


def load_state():
    return json.load(open(STATE, encoding="utf-8")) if os.path.exists(STATE) else {}


def rebuild(state):
    block, rng = build_js(state)
    return rng, splice(block)[1]


def main():
    a = C.parse_args()
    try:
        state = load_state()
        days  = read_days(state)
        log("읽을 날짜 %d일 (%s)" % (len(days), ", ".join(d.isoformat() for d in days)))
        blocks = run_query(days)
    except Guard as e:
        log("중단(가드): %s" % e); notify(str(e)); return 1
    except Exception as e:
        log("중단(예외): %s: %s" % (type(e).__name__, e)); notify("%s: %s" % (type(e).__name__, e)); return 1

    published = load_state()
    try:
        state = merge_state(state, blocks)
        check(state)
        block, rng = build_js(state)
        old, new   = splice(block)
    except Guard as e:
        log("중단(가드): %s" % e); notify(str(e))
        published["pulled_kst"] = C.meta_pulled(blocks)
        C.guard_stamp(a, published, rebuild)
        return 1
    except Exception as e:
        log("중단(예외): %s: %s" % (type(e).__name__, e)); notify("%s: %s" % (type(e).__name__, e)); return 1

    return C.finish(a, state, rng, old, new, dry_dump=block)


if __name__ == "__main__":
    sys.exit(main())
