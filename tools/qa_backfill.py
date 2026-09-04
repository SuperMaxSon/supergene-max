#!/usr/bin/env python3
"""
qa_backfill.py — Supabase 과거 데이터 → 허브 요약 (1회용)
==========================================================
`qa_export.py --backfill` 이 호출한다. 단독 실행도 가능하다.

읽기 전용이다. 쓰기 RPC(submit_command / delete_* 등)는 호출하지 않는다.
`screenshots` 컬럼은 select 목록에서 제외한다 — base64 원본이 런마다
수 MB씩 들어 있어 절대 가져오면 안 된다.

로컬 익스포터와 run_id 규칙이 같아야 중복 없이 병합된다. Supabase 쪽은
`source_path`(`games/SCJ/results/YYYYMMDD/freeplay/{persona}/freeplay_HHMM.json`)
에서 같은 시각을 얻는다. SCJ 184런 전부 source_path 가 채워져 있음을 확인했다.
"""

import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa_export as qx

PAGE = 1000

# screenshots 제외 — 이게 이 파일에서 가장 중요한 한 줄이다.
RUN_COLS = (
    "id,game_id,persona,run_date,client_ver,levels_played,levels_cleared,"
    "clear_rate,total_time_sec,metrics,uid,platform,selection_mode,"
    "source_path,created_at"
)
STAGE_COLS = (
    "run_id,game_id,persona,stage_number,game_level,result,time_sec,"
    "difficulty,details"
)
CHECK_COLS = "run_id,check_id,status,severity,message,value"


def _get(table: str, cols: str, extra: str = "") -> list:
    """PostgREST 페이지네이션 조회."""
    out, offset = [], 0
    while True:
        qs = f"select={urllib.parse.quote(cols)}&game_id=eq.{qx.GAME_ID}{extra}"
        url = f"{qx.SUPABASE_URL}/rest/v1/{table}?{qs}"
        req = urllib.request.Request(url, headers={
            "apikey": qx.SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {qx.SUPABASE_ANON_KEY}",
            "Range-Unit": "items",
            "Range": f"{offset}-{offset + PAGE - 1}",
        })
        with urllib.request.urlopen(req, timeout=60) as r:
            chunk = json.loads(r.read().decode("utf-8"))
        out.extend(chunk)
        if len(chunk) < PAGE:
            break
        offset += PAGE
    return out


def _run_time_from(run: dict) -> str:
    """source_path 의 freeplay_HHMM.json 에서 시각을 뽑는다."""
    m = re.search(r"freeplay_(\d{4})\.json$", run.get("source_path") or "")
    if m:
        return f"{m.group(1)[:2]}:{m.group(1)[2:]}"
    # 폴백: created_at(UTC)의 시각. 로컬 파일명과 어긋날 수 있어 최후 수단이다.
    ca = run.get("created_at") or ""
    return ca[11:16] if len(ca) >= 16 else ""


def collect_supabase() -> list:
    print("Supabase 조회 중 (읽기 전용, screenshots 제외)...")
    runs = _get("freeplay_runs", RUN_COLS)
    stages = _get("stage_results", STAGE_COLS)
    checks = _get("health_checks", CHECK_COLS)
    print(f"  freeplay_runs {len(runs)} / stage_results {len(stages)} / health_checks {len(checks)}")

    stages_by_run, checks_by_run = {}, {}
    for s in stages:
        stages_by_run.setdefault(s["run_id"], []).append(s)
    for c in checks:
        checks_by_run.setdefault(c["run_id"], []).append(c)

    rows = []
    for run in runs:
        persona = run.get("persona") or "unknown"
        run_date = run.get("run_date") or ""
        run_time = _run_time_from(run)
        rid = qx._run_id(run_date, run_time, persona)
        metrics = run.get("metrics") or {}

        stage_slim = [
            qx._slim_stage(s, s.get("details") or {})
            for s in stages_by_run.get(run["id"], [])
        ]
        health = qx._slim_health(checks_by_run.get(run["id"], []))

        played = run.get("levels_played") or 0
        cleared = run.get("levels_cleared") or 0

        index_row = {
            "run_id": rid,
            "game_id": qx.GAME_ID,
            "persona": persona,
            "run_date": run_date,
            "run_time": run_time,
            "client_ver": run.get("client_ver"),
            "uid": run.get("uid"),
            "platform": run.get("platform") or qx.PLATFORM,
            "selection_mode": run.get("selection_mode") or "manual",
            "levels_played": played,
            "levels_cleared": cleared,
            "clear_rate": round(cleared / played, 4) if played else 0.0,
            "total_time_sec": qx._round(run.get("total_time_sec")),
            "stop_reason": metrics.get("stop_reason"),
            "health": qx._health_counts(health),
        }
        detail_row = {
            "run_id": rid,
            "stages": stage_slim,
            "health_checks": health,
            "metrics": qx._slim_metrics(metrics),
            "notable_events_top": qx._slim_events(metrics.get("notable_events")),
            "fail_tracking": metrics.get("fail_tracking") or {},
        }
        rows.append((index_row, detail_row))

    print(f"  변환 완료 {len(rows)}런")
    return rows


if __name__ == "__main__":
    qx.merge_and_write(collect_supabase(), dry_run="--dry-run" in sys.argv)
