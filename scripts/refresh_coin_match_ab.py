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
    · 지표 정의를 바꾸지 않는다. 자동 갱신 값은 수동으로 뽑던 값과 같아야 한다.
      그래서 KPI 보드는 날짜 축 없이 기간 전체를 매 실행 재조회한다
      (기간 고유 유저·세션은 일별 합산으로 복원할 수 없다).

데이터 소스
    · KPI 보드  raw.coin_match          — base CTE 하나, 기간만큼 1회 스캔
    · 리텐션    stat.coin_match_prod_nru_retention3 — 사전집계, raw 스캔 0

사용
    python3 scripts/refresh_coin_match_ab.py             # 조회 -> 갱신 -> 커밋/푸시
    python3 scripts/refresh_coin_match_ab.py --no-push   # 커밋만
    python3 scripts/refresh_coin_match_ab.py --dry-run   # 파일도 안 건드림
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

REPO    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML    = os.path.join(REPO, "docs", "coin-match-tournament-reject-ab.html")
STATE   = os.path.join(REPO, "docs", "data", "coin-match-ab.json")
DATA_JS = os.path.join(REPO, "data.js")
INDEX   = os.path.join(REPO, "index.html")
LOG     = os.path.join(REPO, "scripts", "refresh.log")

BQ       = "/opt/homebrew/bin/bq"
PROJECT  = "game-log-359704"
EXP_FROM = "2026-08-27"      # 두 빌드가 함께 서빙되기 시작한 날
A, B     = "3374", "3375"
DOC_URL  = "docs/coin-match-tournament-reject-ab.html"

SQL = r"""
WITH base AS (
    SELECT
        CASE WHEN client_version = 3375 THEN 'B' ELSE 'A' END AS ab_group,
        player_id,
        CONCAT(CAST(player_id AS STRING), '_', CAST(logincount_total AS STRING)) AS session_key,
        event
    FROM `game-log-359704.raw.coin_match`
    WHERE log_date BETWEEN DATE '2026-08-27' AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
      AND client_version IN (3374, 3375)
),
core AS (
    SELECT
        ab_group,
        COUNT(DISTINCT CASE WHEN event = '1000_LOGIN_COMPLETE' THEN player_id END)   AS users,
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
    GROUP BY ab_group
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
    WHERE log_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
                       AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
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
    ab_group, users, sessions, play_starts, play_finishes, sessions_300s,
    tc_try, tc_success, tc_suppressed, ts_try, ts_success,
    p2p_try, p2p_success, feed_try, feed_success, sc_try, sc_success)
    ORDER BY ab_group)) FROM core
UNION ALL SELECT '2_RET', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    FORMAT_DATE('%m-%d', join_date) AS c, ab_group AS g, cohort,
    r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14)
    ORDER BY join_date, ab_group)) FROM ret
UNION ALL SELECT '3_VERSION', COUNT(*), TO_JSON_STRING(ARRAY_AGG(STRUCT(
    FORMAT_DATE('%m-%d', log_date) AS d, CAST(client_version AS STRING) AS ver, dau)
    ORDER BY log_date, client_version)) FROM vers
ORDER BY blk
"""


def notify(msg):
    """실패했을 때만 맥 알림을 띄운다. 로그만 남기면 아무도 안 본다."""
    try:
        subprocess.run(["/usr/bin/osascript", "-e",
                        'display notification %s with title "코인매치 A/B 갱신 실패"'
                        % json.dumps(msg[:200])], timeout=20)
    except Exception:
        pass


def log(msg):
    line = "%s  [cm] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
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
    missing = [b for b in ("0_META", "1_CORE", "2_RET") if not blocks.get(b)]
    if missing:
        raise Guard("필수 블록이 비었다: " + ", ".join(missing))
    return blocks


# ── 병합 ────────────────────────────────────────────────────────────────────
def merge_by_key(old, new, keys):
    """코호트 축이 있는 블록: 같은 키의 행은 덮어쓰고 새 키는 추가한다."""
    idx = {tuple(str(r[k]) for k in keys): r for r in old}
    for r in new:
        idx[tuple(str(r[k]) for k in keys)] = r
    return [idx[k] for k in sorted(idx)]


def merge_state(state, blocks):
    meta = blocks["0_META"]
    if isinstance(meta, list):
        meta = meta[0]
    state["pulled_kst"] = meta["pulled_kst"]
    state["last_day"]   = meta["last_day"]
    # core / version 은 날짜 축이 없거나 최근 3일 롤링이라 통째로 갈아끼운다.
    state["core"]    = blocks["1_CORE"]
    state["version"] = blocks.get("3_VERSION") or []
    # 리텐션은 코호트일 × 군 키로 병합한다. 지난 코호트의 D+n 은 나중에 채워진다.
    state["ret"] = merge_by_key(state.get("ret", []), blocks["2_RET"], ["c", "g"])
    return state


# ── 가드 ────────────────────────────────────────────────────────────────────
def check(state):
    y = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    if state["last_day"] != y:
        raise Guard("마지막 날(%s)이 어제(%s)가 아니다 — 적재가 안 끝났거나 시각이 어긋났다"
                    % (state["last_day"], y))

    core = {r["ab_group"]: r for r in state["core"]}
    for g in ("A", "B"):
        if g not in core:
            raise Guard("core 에 %s 군이 없다 — 대조군이 사라졌다" % g)
        if int(core[g]["users"]) < 1000:
            raise Guard("%s 군 유저가 %s명뿐이다" % (g, core[g]["users"]))

    ua, ub = int(core["A"]["users"]), int(core["B"]["users"])
    if not (0.8 <= ub / ua <= 1.25):
        raise Guard("두 군 크기가 %.2f 배로 벌어졌다 (A %d / B %d) — 반반 서빙이 깨졌다"
                    % (ub / ua, ua, ub))

    # 유저 수는 기간 누적이라 줄어들 수 없다. 줄었다면 적재 이상이다.
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
def j(v):
    return json.dumps(v, ensure_ascii=False)


def pct(num, den):
    return round(num / den * 100, 2) if den else 0.0


def build_js(state):
    c = {r["ab_group"]: {k: int(v) for k, v in r.items() if k != "ab_group"}
         for r in state["core"]}
    a, b = c["A"], c["B"]

    # 리텐션 코호트 크기 — NRU 코호트 행은 실험 첫 5일(8/27~8/31) 코호트의 합이다.
    NRU_TO = "08-31"
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
    md     = lambda d: "%d/%d" % (int(d[:2]), int(d[3:]))   # "09-06" -> "9/6"
    rng    = "%s~%s" % (md(days[0]), md(days[-1]))

    L = []
    L.append("      /* DATA:START */")
    L.append('      const PULLED = %s;' % j(state["pulled_kst"]))
    L.append('      const RANGE  = %s;' % j(rng))
    L.append("")
    L.append("      // V — 지표 키 → [A(3374), B(3375)]. 기간 전체를 매 실행 재조회하므로")
    L.append("      //     날짜 축이 없다. 값의 정의는 지금 문서와 동일하게 유지한다.")
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

    today = datetime.date.today()
    year  = today.year
    for cday in days:
        rs = {r["g"]: r for r in state["ret"] if r["c"] == cday}
        if "A" not in rs or "B" not in rs:
            continue
        ca, cb = int(rs["A"]["cohort"]), int(rs["B"]["cohort"])
        # D+n 이 실제로 도래했는지는 코호트일 기준으로 판정한다.
        # stat 은 하루 지연이므로 관측 가능한 마지막 날은 last_day 다.
        cd   = datetime.date(year, int(cday[:2]), int(cday[3:]))
        last = datetime.date.fromisoformat(state["last_day"])
        obs  = (last - cd).days
        cells = {}
        for n in range(1, 15):
            if n > obs:
                continue
            cells[str(n)] = [int(rs["A"]["r%d" % n]), int(rs["B"]["r%d" % n])]
        L.append('        [%s,%d,%d,%s],' % (j(cday), ca, cb, j(cells)))
    L.append("      ];")
    L.append("      /* DATA:END */")
    return "\n".join(L), rng


def splice(block):
    s = open(HTML, encoding="utf-8").read()
    a = s.index("      /* DATA:START */")
    b = s.index("      /* DATA:END */") + len("      /* DATA:END */")
    return s, s[:a] + block + s[b:]


def stamp(now, bust, rng):
    s = open(HTML, encoding="utf-8").read()
    s = re.sub(r"문서 갱신 <b>[^<]*</b> KST", "문서 갱신 <b>%s</b> KST" % now, s, count=1)
    s = re.sub(r"데이터 <b>[^<]*</b>", "데이터 <b>%s</b>" % rng, s, count=1)
    open(HTML, "w", encoding="utf-8").write(s)

    d = open(DATA_JS, encoding="utf-8").read()
    m = re.search(r'(url: "%s".*?)version: "v(\d+)\.(\d+)"' % re.escape(DOC_URL), d, re.S)
    if m:
        ver = 'version: "v%s.%d"' % (m.group(2), int(m.group(3)) + 1)
        d = d[:m.start()] + m.group(1) + ver + d[m.end():]
    d = re.sub(r'(url: "%s".*?updated: ")[^"]*(")' % re.escape(DOC_URL),
               r"\g<1>%s\g<2>" % now, d, count=1, flags=re.S)
    open(DATA_JS, "w", encoding="utf-8").write(d)

    i = open(INDEX, encoding="utf-8").read()
    i = re.sub(r"data\.js\?v=\d{12}", "data.js?v=" + bust, i)
    open(INDEX, "w", encoding="utf-8").write(i)


def git(*args):
    return subprocess.run(["git", "-C", REPO] + list(args),
                          capture_output=True, text=True, timeout=300)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

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
        sys.stdout.write(block + "\n")
        return 0

    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(state, open(STATE, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1, sort_keys=True)
    open(HTML, "w", encoding="utf-8").write(new)
    now = datetime.datetime.now()
    stamp(now.strftime("%Y-%m-%d %H:%M"), now.strftime("%Y%m%d%H%M"), rng)

    git("add", "-A")
    msg = "[Max] 코인매치 연속거절 A/B 자동 갱신 — %s 까지 (%s)" % (state["last_day"], rng)
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
        notify("푸시 실패")
        return 1
    log("갱신 완료: %s" % msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
