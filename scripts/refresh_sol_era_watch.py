#!/usr/bin/env python3
"""솔리테어 483 전후 — 벤치 대조 문서 자동 갱신.

흐름
    bq query (결손일만) -> docs/data/sol-era-watch.json 병합
      -> docs/sol-era-watch.html 의 DATA / SQL / WIN 세 블록 재생성
      -> 가드 통과 + 내용 변화 있을 때만 커밋/푸시

이 문서만의 규칙
    · DATA.bench(코지·마종·퍼블마 8/31~9/2)는 **고정 기준선이다.** 다시 조회하지 않고
      아래 BENCH 상수를 그대로 다시 쓴다. 목표선이 같이 흔들리면 "무엇이 움직였는지"가 사라진다.
    · ver 는 client_version >= 483 을 한 군으로 묶은 값이다. 지금은 485·486 슬롯 A/B 가
      그 안에 함께 들어 있다 — 그 사실을 lede(WIN 블록)에 스크립트가 직접 적는다.
    · DATA.updated 는 실행 시각이 아니라 데이터의 마지막 날이다. 실행 시각을 넣으면
      값이 그대로여도 매일 새 커밋이 쌓인다.

사용
    python3 scripts/refresh_sol_era_watch.py              # 조회 -> 갱신 -> 커밋/푸시
    python3 scripts/refresh_sol_era_watch.py --no-push    # 커밋만
    python3 scripts/refresh_sol_era_watch.py --dry-run    # 파일도 안 건드림
"""
import datetime
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refresh_common as C
from refresh_common import Guard, bq_query, j, log, merge_by_key

REPO     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML     = os.path.join(REPO, "docs", "sol-era-watch.html")
STATE    = os.path.join(REPO, "docs", "data", "sol-era-watch.json")
JOB_ID   = "sol-era-watch"

EXP_FROM = "2026-08-31"          # 문서가 다루는 첫 날
CUT      = 483                   # 이 빌드 이상이 '개편 후'

C.configure(job_id=JOB_ID, log_prefix="[era] ",
            notify_title="483 전후 대조 갱신 실패",
            html=HTML, state=STATE, doc_url="docs/sol-era-watch.html",
            commit_msg="[Max] 솔리테어 483 전후 대조 자동 갱신 — %s 까지 (%s)")

# 벤치 3사 8/31~9/2 3일 합산 — 2026-09-02 실행 결과를 고정한 기준선. 재조회하지 않는다.
BENCH = {
    "win": "8/31~9/2 고정",
    "cozy":    dict(days=3, ud=46124, fin=587976, rv_fin=90158, it_fin=340549,
                    msg_ok=78314, feed_ok=952,
                    cr_try=159214, cr_ok=30202, sh_try=120947, sh_ok=23569,
                    inv_try=0, inv_ok=0),
    "mahjong": dict(days=3, ud=87727, fin=658721, rv_fin=77109, it_fin=362056,
                    msg_ok=133148, feed_ok=6141,
                    cr_try=289336, cr_ok=86316, sh_try=111227, sh_ok=35780,
                    inv_try=0, inv_ok=0),
    "pubma":   dict(days=3, ud=34402, fin=264078, rv_fin=64133, it_fin=115497,
                    msg_ok=40851, feed_ok=847,
                    cr_try=86557, cr_ok=9082, sh_try=69711, sh_ok=9801,
                    inv_try=26583, inv_ok=25444),
}
BENCH_COLS = ["days", "ud", "fin", "rv_fin", "it_fin", "msg_ok", "feed_ok",
              "cr_try", "cr_ok", "sh_try", "sh_ok", "inv_try", "inv_ok"]

# daily 1행의 컬럼 순서. SQL 별칭 · state · JS 키가 전부 이 목록 하나를 따른다.
COLS = ["ud", "fin", "rv_fin", "it_fin", "irv_fin", "msg_ok", "feed_ok",
        "cr_try", "cr_ok", "sh_try", "sh_ok",
        "inv_try", "inv_ok", "inv_all_try", "inv_all_ok"]

SQL = r"""-- 이 문서를 채우는 쿼리다. scripts/refresh_sol_era_watch.py 가 매일 KST 09시에 이 문자열을
-- 그대로 실행하고, 같은 문자열을 문서의 SQL 폴드에 심는다 — 사본이 갈라질 수 없다.
--
-- 스캔 원칙
--  · 오늘은 절대 넣지 않는다. 마지막 날은 항상 어제다(log_date 는 KST 기준).
--  · 고정 창이 아니라 **결손일만** 읽는다. 평소에는 어제 하루뿐이라 스캔이 1일치로 고정된다.
--    (맥이 며칠 꺼져 있었으면 그 며칠이 한 번에 들어온다 — 공백이 영구 결손으로 남지 않는다.)
--  · 벤치 3사(코지·마종·퍼블마)는 이 쿼리에 없다. 8/31~9/2 고정 기준선이라 재조회하지 않는다.
--
-- 결과 1행 = 이 문서 DATA.sol.daily 1행. 별칭을 JS 키와 같게 둬서 옮겨 적을 때 매핑이 없다.
-- ★ver 는 client_version >= 483 을 한 군으로 묶은 값이다 — 485·486(슬롯 A/B)이 여기 섞인다.
--   2_VERSION 블록이 그날 실제로 뜬 빌드를 그대로 보여주므로 혼합 여부를 눈으로 확인할 수 있다.
-- DAU 는 세션이 아니라 1000_LOGIN_COMPLETE 가 있는 (날짜, 플레이어) 쌍이다.
-- RV 는 4210_RV_FINISH(일반 RV). 4110_INTERSTITIAL_RV_FINISH 는 IRV 로 다른 지면이라
-- 총광고에 넣지 않고 irv_fin 으로 누락 확인용으로만 센다.
-- 초대: inv_* = 토너 초대(position='tournament_invite'), inv_all_* = 지면 무관 전체.
WITH us AS (
    SELECT
        log_date, player_id, event, data, client_version,
        MAX(IF(event = '1000_LOGIN_COMPLETE', 1, 0))
            OVER (PARTITION BY log_date, player_id) AS has_login
    FROM `game-log-359704.raw.solitaire_city_journey`
    WHERE log_date IN ({DAYS})
        AND is_dev IS DISTINCT FROM TRUE
        AND player_id > 0
),
daily AS (
    SELECT
        CAST(log_date AS STRING) AS d,
        IF(client_version >= 483, '483', '482') AS ver,
        COUNT(DISTINCT IF(has_login = 1, player_id, NULL))                AS ud,
        COUNTIF(event = '2300_GAMEPLAY_FINISH')                           AS fin,
        COUNTIF(event = '4210_RV_FINISH')                                 AS rv_fin,
        COUNTIF(event = '4010_INTERSTITIAL_AD_FINISH')                    AS it_fin,
        COUNTIF(event = '4110_INTERSTITIAL_RV_FINISH')                    AS irv_fin,
        COUNTIF(event = '3410_MSG_P2P_SUCCESS')                           AS msg_ok,
        COUNTIF(event = '3510_FEED_SHARE_SUCCESS')                        AS feed_ok,
        COUNTIF(event = '3100_TOURNAMENT_CREATE')                         AS cr_try,
        COUNTIF(event = '3110_TOURNAMENT_CREATE_SUCCESS')                 AS cr_ok,
        COUNTIF(event = '3200_TOURNAMENT_SHARE')                          AS sh_try,
        COUNTIF(event = '3210_TOURNAMENT_SHARE_SUCCESS')                  AS sh_ok,
        COUNTIF(event = '3460_MSG_P2P_INVITE'
                AND JSON_VALUE(data, '$.position') = 'tournament_invite') AS inv_try,
        COUNTIF(event = '3470_MSG_P2P_INVITE_SUCCESS'
                AND JSON_VALUE(data, '$.position') = 'tournament_invite') AS inv_ok,
        COUNTIF(event = '3460_MSG_P2P_INVITE')                            AS inv_all_try,
        COUNTIF(event = '3470_MSG_P2P_INVITE_SUCCESS')                    AS inv_all_ok
    FROM us
    GROUP BY d, ver
),
vers AS (
    -- 483 이상 막대에 실제로 어떤 빌드가 섞여 있는지. 같은 us 를 다시 쓰므로 추가 스캔이 없다.
    SELECT
        CAST(log_date AS STRING) AS d,
        CAST(client_version AS STRING) AS ver,
        COUNT(DISTINCT IF(has_login = 1, player_id, NULL)) AS ud
    FROM us
    GROUP BY d, ver
)
SELECT '0_META' AS blk, TO_JSON_STRING(STRUCT(
    FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', CURRENT_TIMESTAMP(), 'Asia/Seoul') AS pulled_kst,
    CAST(DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AS STRING)              AS last_day)) AS payload
UNION ALL
SELECT '1_DAILY', TO_JSON_STRING(ARRAY_AGG(STRUCT(
    d, ver, ud, fin, rv_fin, it_fin, irv_fin, msg_ok, feed_ok,
    cr_try, cr_ok, sh_try, sh_ok, inv_try, inv_ok, inv_all_try, inv_all_ok)
    ORDER BY d, ver DESC)) FROM daily
UNION ALL
SELECT '2_VERSION', TO_JSON_STRING(ARRAY_AGG(STRUCT(d, ver, ud)
    ORDER BY d, ver)) FROM vers
ORDER BY blk
"""


# ── 조회 ────────────────────────────────────────────────────────────────────
def missing_days(state):
    """아직 state["daily"] 에 없는 날짜. 평소에는 [어제] 하나다.

    고정 창(최근 3일)이면 이미 가진 날을 매번 다시 읽어 낭비이고, 창보다 긴 공백
    (맥이 주말에 꺼져 있었다)은 영구 결손으로 남는다. 결손일만 읽으면 둘 다 해결된다.

    '가졌다'의 기준은 그날 행이 하나라도 있는 것이다. 482 는 이미 잔여 트래픽이라
    두 군을 모두 요구하면 482 가 0 이 되는 날부터 자동화가 영구히 멈춘다.

    empty_days 는 조회했지만 데이터가 없던 날이다. 다시 요청하지 않는다 —
    그러지 않으면 결손 목록이 줄지 않아 매일 같은 조회를 반복한다.
    """
    first = datetime.date.fromisoformat(EXP_FROM)
    last  = datetime.date.today() - datetime.timedelta(days=1)
    have  = {r["d"] for r in state.get("daily", [])}
    empty = set(state.get("empty_days") or [])
    out, d = [], first
    while d <= last:
        k = d.isoformat()
        if k not in have and k not in empty:
            out.append(d)
        d += datetime.timedelta(days=1)
    return out


def run_query(days):
    if not days:
        # 읽을 날이 없으면 raw 를 건드리지 않는다. 도래하지 않은 날짜로 스캔을 0 으로 만든다.
        days = [datetime.date(1970, 1, 1)]
    lst = ", ".join("DATE '%s'" % d.isoformat() for d in days)
    blocks = {}
    for r in bq_query(SQL.replace("{DAYS}", lst)):
        payload = r.get("payload")
        blocks[r["blk"]] = json.loads(payload) if payload else None
    if not blocks.get("0_META"):
        raise Guard("0_META 가 비었다 — 쿼리가 형태를 바꿨다")
    return blocks


# ── 병합 ────────────────────────────────────────────────────────────────────
def merge_state(state, blocks, days=()):
    meta = blocks["0_META"]
    if isinstance(meta, list):
        meta = meta[0]
    state["pulled_kst"] = meta["pulled_kst"]
    state["last_day"]   = meta["last_day"]

    fresh = blocks.get("1_DAILY") or []
    for r in fresh:                       # bq 는 숫자를 문자열로 준다
        for k in COLS:
            r[k] = int(r[k])

    # 요청했는데 아무 행도 안 온 날. 어제는 적재 지연일 수 있어 결손으로 남기고,
    # 그보다 과거는 정말로 빈 날이므로 empty_days 에 넣어 영구 재요청을 끊는다.
    got, marked, edrop = {r["d"] for r in fresh}, set(state.get("empty_days") or []), set()
    for d in days:
        k = d.isoformat()
        if k in got:
            continue
        edrop.add(k)
        if k == state["last_day"]:
            log("%s(어제): 데이터가 아직 안 찼다 — 다음 실행에서 다시 읽는다" % k)
        else:
            marked.add(k)
            log("%s: 데이터가 없다 — 빈 날로 기록하고 다시 요청하지 않는다" % k)
    if marked:
        state["empty_days"] = sorted(marked)

    fresh = drop_partial(state, [r for r in fresh if r["d"] not in edrop])
    state["daily"] = merge_by_key(state.get("daily", []), fresh, ["d", "ver"])
    state["version"] = merge_by_key(state.get("version", []),
                                    blocks.get("2_VERSION") or [], ["d", "ver"])
    return state


def drop_partial(state, fresh):
    """부분 적재로 보이는 날짜를 새 데이터에서 떨어낸다.

    한 번 저장된 날은 다시 읽지 않으므로, 적재 중인 파티션을 읽어 부분값이 박히면
    영구히 남는다. 여기서 떨어내면 결손으로 남아 다음 실행이 다시 읽는다.
    가드로 예외를 던지지 않는 이유: 같은 실행에서 받아온 정상 날짜까지 통째로 버려진다.

    기준은 이미 저장된 최근 7일 DAU 합의 중앙값이고, 0.75 미만만 부분일로 본다
    (급증은 부분 적재가 아니므로 상한은 두지 않는다). 저장된 날이 3일 미만이면 판정하지 않는다.
    """
    have = {}
    for r in state.get("daily", []):
        have[r["d"]] = have.get(r["d"], 0) + r["ud"]
    if len(have) < 3:
        return fresh
    base = statistics.median([have[d] for d in sorted(have)[-7:]])
    if not base:
        return fresh
    new = {}
    for r in fresh:
        new[r["d"]] = new.get(r["d"], 0) + r["ud"]
    drop = {d for d, u in new.items() if u < base * 0.75}
    for d in sorted(drop):
        log("%s: DAU %d 로 최근 중앙값 %d 의 75%% 미만 — 부분 적재로 보고 저장하지 않는다"
            % (d, new[d], base))
    return [r for r in fresh if r["d"] not in drop]


# ── 가드 ────────────────────────────────────────────────────────────────────
def check(state, prev_rows):
    y = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    if state["last_day"] != y:
        raise Guard("쿼리의 마지막 날(%s)이 어제(%s)가 아니다 — 시각이 어긋났다"
                    % (state["last_day"], y))
    if len(state["daily"]) < prev_rows:
        raise Guard("daily 행이 %d -> %d 로 줄었다 — 조회 실패를 데이터 감소로 덮어쓸 뻔했다"
                    % (prev_rows, len(state["daily"])))
    days = sorted({r["d"] for r in state["daily"]})
    if not days:
        raise Guard("daily 가 비었다")
    # 중간 결손은 합계를 조용히 틀리게 한다. 어제는 적재 지연일 수 있어 제외한다.
    gaps = [d.isoformat() for d in missing_days(state) if d.isoformat() != y]
    if gaps:
        raise Guard("중간 결손일 %d개 (%s) — 통산 합계가 틀린다"
                    % (len(gaps), ", ".join(gaps[:5])))
    if not any(r["ver"] == "483" for r in state["daily"] if r["d"] == days[-1]):
        raise Guard("%s 에 483 이상 행이 없다 — 개편 후 군이 사라졌다" % days[-1])


# ── 블록 생성 ───────────────────────────────────────────────────────────────
def md(iso):
    return "%d/%d" % (int(iso[5:7]), int(iso[8:10]))


def win_of(daily, ver):
    """그 군이 실제로 유저를 가졌던 창. ud=0 인 날은 세지 않는다.

    482 는 강제 업데이트 뒤 로그인 유저가 0 이면서 자정을 넘긴 세션의 이벤트만 몇 건 남는다.
    그 행까지 창에 넣으면 "482 이하 8/31~9/6" 처럼 죽은 군이 아직 살아 있는 것처럼 읽힌다.
    """
    ds = sorted(r["d"] for r in daily if r["ver"] == ver and r["ud"] > 0)
    return ("%s~%s" % (md(ds[0]), md(ds[-1]))) if ds else "—"


def build_js(state):
    daily = sorted(state["daily"], key=lambda r: (r["d"], r["ver"]), reverse=False)
    days  = sorted({r["d"] for r in daily})
    rng   = "%s~%s" % (md(days[0]), md(days[-1]))

    L = ["      /* DATA:START */",
         "      /* ── DATA — scripts/refresh_sol_era_watch.py 가 생성한다. 손으로 고치면 사라진다.",
         "         bench : 목표선. 8/31~9/2 고정 기준선이라 자동화가 재조회하지 않는다(스크립트 상수).",
         "         sol   : 날짜 × 빌드군 실측. 막대 값은 손으로 더하지 않는다 — 코드가 daily 를 합산한다.",
         "         updated 는 실행 시각이 아니라 데이터의 마지막 날이다. */",
         "      const DATA = {",
         "        updated: %s," % j(state["last_day"]),
         "        // 벤치 3일치 — 8/31~9/2 실측. ★고정 기준선이다: 솔 창이 바뀌어도 다시 뽑지 않는다.",
         "        // 매번 같이 굴리면 목표선이 함께 흔들려 \"무엇이 움직였는지\"가 사라진다.",
         "        bench: {",
         "          win: %s," % j(BENCH["win"])]
    for k in ("cozy", "mahjong", "pubma"):
        b = BENCH[k]
        L.append("          %-9s { %s }," % (k + ":",
                 ", ".join("%s:%d" % (c, b[c]) for c in BENCH_COLS)))
    # ★조회 시각을 이 블록에 적지 않는다. 매 실행마다 바뀌므로 데이터가 그대로여도
    #   HTML 이 달라져 C.finish 의 멱등 검사를 통과해 버린다 — 값이 안 변한 날에도
    #   커밋·푸시가 하루 한 번씩 쌓인다. 조회 시각은 상태 파일과 refresh.log 에 남는다.
    L += ["        },",
          "        // 솔리테어 — 날짜 × client_version 실측. daily 를 코드가 버전별로 합산한다.",
          "        sol: {",
          "          arms: [",
          '            { key:"pre", ver:"482", label:"482 이하", win:%s, color:"#9AA0B8" },'
          % j(win_of(daily, "482")),
          '            { key:"cur", ver:"483", label:"483 이상", win:%s, color:"#15803D" },'
          % j(win_of(daily, "483")),
          "          ],",
          "          daily: ["]
    for r in daily:
        L.append("            { d:%s, ver:%s, %s }," % (
            j(r["d"]), j(r["ver"]), ", ".join("%s:%d" % (c, r[c]) for c in COLS)))
    L += ["          ],", "        },", "      };", "      /* DATA:END */"]
    return "\n".join(L), rng


def build_win(state):
    """lede 의 휘발 문구. 창·유저-일·483 이상에 섞인 빌드 목록을 값에서 다시 만든다."""
    daily = state["daily"]
    ud    = lambda v: sum(r["ud"] for r in daily if r["ver"] == v)
    nf    = lambda n: "{:,}".format(n)
    mixed = sorted({r["ver"] for r in state.get("version", [])
                    if r["ver"].isdigit() and int(r["ver"]) >= CUT},
                   key=int)
    mixtxt = (" · ".join(mixed) or "483")
    return "\n".join([
        "          <!-- WIN:START -->",
        "          <b>482 이하</b>(%s · %s 유저-일)와 <b>483 이상</b>(%s · %s 유저-일)을"
        % (win_of(daily, "482"), nf(ud("482")), win_of(daily, "483"), nf(ud("483"))),
        "          빌드별로 합산해 DAU당 지표 9개로 나란히 놓았습니다. 🎯 목표선은 <b>8/31~9/2 벤치 고정 기준선</b>",
        "          (마종 · 초대만 퍼블마)이라 솔리테어 창이 바뀌어도 움직이지 않습니다.",
        "          483 이상 막대에는 <b>%s</b> 빌드가 함께 들어 있고, 배포 당일과 조회 당일은 하루가 잘려 있어"
        % mixtxt,
        "          DAU를 분모로 쓰는 행이 구조적으로 눌립니다 — 방향 판단은 비율 2행(생성률·공유율)부터 보세요.",
        "          <!-- WIN:END -->"])


# ── 파일 반영 ───────────────────────────────────────────────────────────────
def splice(state, block):
    """DATA · SQL · WIN 세 블록을 재생성한다.

    SQL 을 문서에 심는 이유: 손으로 유지하는 사본은 반드시 갈라진다.
    WIN 을 심는 이유: lede 의 창·모수가 daily 와 어긋나면 본문이 값과 다른 말을 한다.
    """
    s = open(HTML, encoding="utf-8").read()
    new = s

    a = new.index("      /* DATA:START */")
    b = new.index("      /* DATA:END */") + len("      /* DATA:END */")
    new = new[:a] + block + new[b:]

    days = sorted({r["d"] for r in state["daily"]})
    lst  = ", ".join("DATE '%s'" % d for d in days[-3:])
    esc  = (SQL.replace("{DAYS}", lst).strip()
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    a = new.index("            <!-- SQL:START -->")
    b = new.index("            <!-- SQL:END -->") + len("            <!-- SQL:END -->")
    new = (new[:a] + "            <!-- SQL:START -->\n"
           + '            <div class="table-scroll"><pre>' + esc + "</pre></div>\n"
           + "            <!-- SQL:END -->" + new[b:])

    a = new.index("          <!-- WIN:START -->")
    b = new.index("          <!-- WIN:END -->") + len("          <!-- WIN:END -->")
    new = new[:a] + build_win(state) + new[b:]
    return s, new


def main():
    a = C.parse_args()
    if not a.force and not C.enabled():
        log("건너뜀 — 제어판에서 꺼져 있다 (%s)" % JOB_ID)
        return 0

    try:
        state = json.load(open(STATE, encoding="utf-8")) if os.path.exists(STATE) else {}
        prev  = len(state.get("daily", []))
        days  = missing_days(state)
        log("읽을 날짜 %d일%s" % (len(days),
            (" (" + ", ".join(d.isoformat() for d in days) + ")") if days else " — raw 스캔 0"))
        blocks = run_query(days)
        state  = merge_state(state, blocks, days)
        check(state, prev)
        block, rng = build_js(state)
        old, new   = splice(state, block)
    except Guard as e:
        log("중단(가드): %s" % e)
        C.notify(str(e))
        return 1
    except Exception as e:
        log("중단(예외): %s: %s" % (type(e).__name__, e))
        C.notify("%s: %s" % (type(e).__name__, e))
        return 1

    return C.finish(a, state, rng, old, new)


if __name__ == "__main__":
    sys.exit(main())
