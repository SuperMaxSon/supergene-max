#!/usr/bin/env python3
"""
qa_export.py — QA 자동화 결과 → 허브 대시보드용 요약 JSON
==========================================================
프리플레이 결과(로컬 JSON) 또는 Supabase 과거 데이터를 읽어
`docs/data/qa-auto-{index,detail}.json` 두 파일로 요약한다.

사용법:
    python3 tools/qa_export.py                    # 오늘 로컬 결과
    python3 tools/qa_export.py --date 20260904    # 특정 날짜
    python3 tools/qa_export.py --all              # 로컬 전체 날짜
    python3 tools/qa_export.py --backfill         # Supabase 과거분 1회 백필
    python3 tools/qa_export.py --date 20260904 --dry-run

설계 근거는 _ignore/plan.md 참조. 요점:
  - 스크린샷(base64)은 절대 담지 않는다. 로컬 원본 JSON에는 그대로 남는다.
  - 원시 네트워크 로그(net_console_logs/net_api_calls)도 담지 않는다.
    스크린샷 없는 런에서 이 둘이 용량의 87%를 차지한다.
  - Health Check는 재계산하지 않고 QA 프로젝트의 health_checker를 그대로
    호출한다. 판정 로직을 두 벌 유지하지 않기 위해서다.

익스포터 자동 훅은 보류 상태다(plan.md 결정 4). run_freeplay.py는 수정하지
않으며, 이 스크립트는 수동 실행 전용이다.
"""

import argparse
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── 경로 ────────────────────────────────────────────────────
# QA 프로젝트는 읽기 대상일 뿐 수정하지 않는다. 기존 AUTO_TEST_HOME 관례를 따라
# 환경변수로 덮어쓸 수 있게 한다.
QA_HOME = Path(os.environ.get(
    "QA_RESULTS_HOME",
    Path.home() / "Projects" / "QA-Auto-test-main",
))
HUB_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = HUB_ROOT / "docs" / "data"

GAME_ID = "SCJ"          # plan.md 결정 7 — 당분간 SCJ만
PLATFORM = "pc"          # plan.md 결정 8 — pc 고정
SCHEMA_VERSION = 1

SUPABASE_URL = "https://lxkvjwnhrqbtaglwkgmf.supabase.co"
# 공개 대시보드 HTML에 이미 하드코딩된 publishable(anon) 읽기 키다.
# 백필(읽기)에만 쓴다. 쓰기 RPC는 절대 호출하지 않는다.
SUPABASE_ANON_KEY = "sb_publishable_d_sWb1OmWgs0oKrWPCxr5g_ARo_7kq7"


# ── QA 프로젝트 모듈 재사용 ──────────────────────────────────
def _load_qa_module(name: str, relpath: str):
    """QA 프로젝트의 모듈을 파일 경로로 직접 로드한다.

    패키지 __init__ 을 거치지 않으므로 QA 쪽 서드파티 의존성(supabase 등)을
    끌어오지 않는다. 시스템 python3 만으로 동작한다.
    """
    # supabase_loader 는 `from analysis import supabase_client` 를 하므로
    # QA 프로젝트 루트가 sys.path 에 있어야 한다.
    qa_root = str(QA_HOME)
    if qa_root not in sys.path:
        sys.path.insert(0, qa_root)

    path = QA_HOME / relpath
    if not path.exists():
        raise SystemExit(
            f"QA 프로젝트를 찾을 수 없다: {path}\n"
            f"QA_RESULTS_HOME 환경변수로 경로를 지정해라."
        )
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── 요약 변환 ────────────────────────────────────────────────
def _run_id(run_date: str, run_time: str, persona: str) -> str:
    """게임·날짜·시각·페르소나로 결정적 ID를 만든다.

    로컬 파일과 Supabase 백필이 같은 런을 가리키면 같은 ID가 나와야
    중복 없이 병합된다. Supabase 쪽은 source_path(로컬 파일명)에서
    같은 시각을 얻으므로 일치한다.
    """
    return f"{GAME_ID.lower()}-{run_date.replace('-', '')}-{run_time.replace(':', '')}-{persona}"


def _slim_stage(stage_row: dict, details: dict) -> dict:
    """스테이지 1건 → 요약. validation/clear_rewards/events/dda_context는 버린다."""
    return {
        "stage": stage_row.get("stage_number"),
        "level": stage_row.get("game_level"),
        "result": stage_row.get("result"),
        "time_sec": _round(stage_row.get("time_sec")),
        "difficulty": stage_row.get("difficulty"),
        "turns": details.get("turns"),
        "matches": details.get("matches"),
        "gold_pnl": details.get("gold_pnl"),
        "entry_fee": details.get("entry_fee"),
        "item_cost": details.get("item_cost"),
        "reward_gold": details.get("reward_gold"),
        "betting_multiplier": details.get("betting_multiplier"),
        "gimmicks": details.get("gimmicks"),
        "extra_decks": details.get("extra_decks"),
        "wild_card_count": details.get("wild_card_count"),
        "map_score": details.get("map_score"),
    }


def _slim_metrics(metrics: dict) -> dict:
    """run metrics → 요약. perf.snapshots / security.checks / 원시 로그는 버린다."""
    perf = metrics.get("perf") or {}
    sec = metrics.get("security") or {}
    api = metrics.get("api_summary") or {}
    con = metrics.get("console_summary") or {}
    by_level = con.get("by_level") or {}
    return {
        "gold_pnl": metrics.get("gold_pnl"),
        "gold_start": metrics.get("gold_start"),
        "gold_end": metrics.get("gold_end"),
        "hammer_delta": metrics.get("hammer_delta"),
        "wild_count": metrics.get("wild_count"),
        "gimmick_count": metrics.get("gimmick_count"),
        "extra_decks": metrics.get("extra_decks"),
        "retry_total": metrics.get("retry_total"),
        "api_count": metrics.get("api_count"),
        "api_error_count": api.get("error_count", 0),
        "console_error_count": by_level.get("error", 0),
        "console_warn_count": by_level.get("warn", 0) or by_level.get("warning", 0),
        "perf": {
            "heap_max_mb": _mb(perf.get("heap_max")),
            "heap_avg_mb": _mb(perf.get("heap_avg")),
            "dom_max": perf.get("dom_max"),
            "dom_avg": perf.get("dom_avg"),
        },
        "security": {
            "grade": sec.get("grade"),
            "fail_count": sec.get("fail_count", 0),
        },
    }


def _slim_health(check_rows: list) -> list:
    """Health Check → 요약. PASS/SKIP은 상태만, FAIL/WARN은 message/value까지."""
    out = []
    for c in check_rows:
        item = {
            "check_id": c.get("check_id"),
            "status": c.get("status"),
            "severity": c.get("severity"),
        }
        if c.get("status") in ("FAIL", "WARN"):
            if c.get("message"):
                item["message"] = c["message"]
            if c.get("value"):
                item["value"] = c["value"]
        out.append(item)
    return out


def _slim_events(notable: list, limit: int = 5) -> list:
    """notable_events → 상위 N건. '반복로그'는 잡음이라 제외, detail은 버린다."""
    out = []
    for e in notable or []:
        if not isinstance(e, dict):
            continue
        if e.get("category") == "반복로그":
            continue
        out.append({
            "category": e.get("category"),
            "description": (e.get("description") or "")[:200],
        })
        if len(out) >= limit:
            break
    return out


def _mb(v):
    if not isinstance(v, (int, float)) or v <= 0:
        return None
    return round(v / 1024 / 1024, 1)


def _round(v, n=1):
    return round(v, n) if isinstance(v, (int, float)) else v


# ── 로컬 결과 읽기 ───────────────────────────────────────────
def collect_local(dates: list) -> list:
    """로컬 결과 JSON을 읽어 (index_row, detail_row) 리스트를 만든다."""
    sl = _load_qa_module("qa_supabase_loader", "analysis/supabase_loader.py")
    hc = _load_qa_module("qa_health_checker", "analysis/health_checker.py")

    results_root = QA_HOME / "games" / GAME_ID / "results"
    if not results_root.exists():
        raise SystemExit(f"결과 폴더가 없다: {results_root}")

    files = []
    for d in sorted(dates):
        for path in sorted((results_root / d / "freeplay").glob("*/freeplay_*.json")):
            files.append(path)

    rows = []
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        rows.append(_build_row(sl, hc, data, str(path)))
    return rows


def _build_row(sl, hc, data: dict, source_path: str):
    """결과 JSON 1건 → (index_row, detail_row).

    추출은 QA 프로젝트의 함수를 그대로 쓴다. 숫자가 Supabase·원본 대시보드와
    어긋나지 않게 하려는 것이다.
    """
    run = sl.extract_common_run(data, source_path, GAME_ID)
    metrics = sl.extract_scj_run_metrics(data)
    persona = run.get("persona") or "unknown"
    run_date = run.get("run_date") or ""

    m = re.search(r"freeplay_(\d{4})\.json$", source_path)
    run_time = f"{m.group(1)[:2]}:{m.group(1)[2:]}" if m else ""

    levels = data.get("level_results", []) or []
    stage_rows, stage_slim = [], []
    for lv in levels:
        srow = sl.extract_common_stage(lv, GAME_ID, persona)
        sdet = sl.extract_scj_stage_details(lv)
        stage_rows.append(srow)
        stage_slim.append(_slim_stage(srow, sdet))

    # Health Check — 재계산하지 않고 QA 판정 로직을 그대로 호출
    checks = hc.run_checks(run, metrics, levels, GAME_ID)
    check_rows = [c.to_row("", GAME_ID, run_date, persona) for c in checks]
    health = _slim_health(check_rows)

    played = run.get("levels_played", 0) or 0
    cleared = run.get("levels_cleared", 0) or 0
    rid = _run_id(run_date, run_time, persona)

    index_row = {
        "run_id": rid,
        "game_id": GAME_ID,
        "persona": persona,
        "run_date": run_date,
        "run_time": run_time,
        "client_ver": run.get("client_ver"),
        "uid": run.get("uid"),
        "platform": PLATFORM,
        "selection_mode": run.get("selection_mode", "manual"),
        "levels_played": played,
        "levels_cleared": cleared,
        "clear_rate": round(cleared / played, 4) if played else 0.0,
        "total_time_sec": _round(run.get("total_time_sec")),
        "stop_reason": data.get("stop_reason"),
        "health": _health_counts(health),
    }
    detail_row = {
        "run_id": rid,
        "stages": stage_slim,
        "health_checks": health,
        "metrics": _slim_metrics(metrics),
        "notable_events_top": _slim_events(data.get("notable_events")),
        "fail_tracking": data.get("fail_tracking") or {},
    }
    return index_row, detail_row


def _health_counts(health: list) -> dict:
    """index에는 상태별 카운트만 둔다. 상세는 detail.json에 있다."""
    c = {"PASS": 0, "FAIL": 0, "WARN": 0, "SKIP": 0}
    for h in health:
        st = h.get("status")
        if st in c:
            c[st] += 1
    return c


# ── 병합 / 저장 ─────────────────────────────────────────────
def merge_and_write(rows: list, dry_run: bool = False):
    """기존 파일에 run_id 기준으로 upsert 한다."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    idx_path = OUT_DIR / "qa-auto-index.json"
    det_path = OUT_DIR / "qa-auto-detail.json"

    index = _read_json(idx_path, {"schema_version": SCHEMA_VERSION, "runs": []})
    detail = _read_json(det_path, {"schema_version": SCHEMA_VERSION, "runs": {}})

    by_id = {r["run_id"]: r for r in index.get("runs", [])}
    det_by_id = detail.get("runs", {})

    added, updated = 0, 0
    for irow, drow in rows:
        if irow["run_id"] in by_id:
            updated += 1
        else:
            added += 1
        by_id[irow["run_id"]] = irow
        det_by_id[irow["run_id"]] = drow

    runs = sorted(by_id.values(), key=lambda r: (r["run_date"], r["run_time"], r["persona"]))
    index["runs"] = runs
    index["schema_version"] = SCHEMA_VERSION
    index["game_id"] = GAME_ID
    index["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    index["run_count"] = len(runs)
    detail["runs"] = det_by_id
    detail["schema_version"] = SCHEMA_VERSION
    detail["generated_at"] = index["generated_at"]

    if dry_run:
        print(f"[dry-run] 저장 안 함 — 추가 {added} / 갱신 {updated} / 총 {len(runs)}")
        print(f"[dry-run] index 예상 {_size(index)}, detail 예상 {_size(detail)}")
        return

    idx_path.write_text(_dump(index), encoding="utf-8")
    det_path.write_text(_dump(detail), encoding="utf-8")
    print(f"추가 {added} / 갱신 {updated} / 총 {len(runs)}런")
    print(f"  {idx_path.relative_to(HUB_ROOT)}  {idx_path.stat().st_size/1024:.1f} KB")
    print(f"  {det_path.relative_to(HUB_ROOT)}  {det_path.stat().st_size/1024:.1f} KB")


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"


def _size(obj) -> str:
    return f"{len(_dump(obj).encode('utf-8'))/1024:.1f} KB"


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"경고: {path} 를 읽지 못했다 ({e}). 새로 만든다.")
        return default


def _local_dates() -> list:
    root = QA_HOME / "games" / GAME_ID / "results"
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir()
                  if p.is_dir() and re.fullmatch(r"\d{8}", p.name))


def main():
    ap = argparse.ArgumentParser(description="QA 자동화 결과 → 허브 요약 JSON")
    ap.add_argument("--date", help="YYYYMMDD (기본: 오늘)")
    ap.add_argument("--all", action="store_true", help="로컬 전체 날짜")
    ap.add_argument("--backfill", action="store_true", help="Supabase 과거분 백필")
    ap.add_argument("--dry-run", action="store_true", help="저장하지 않고 결과만 출력")
    args = ap.parse_args()

    if args.backfill:
        from qa_backfill import collect_supabase  # Phase 2에서 추가
        rows = collect_supabase()
    else:
        if args.all:
            dates = _local_dates()
        elif args.date:
            dates = [args.date]
        else:
            dates = [datetime.now().strftime("%Y%m%d")]
        if not dates:
            raise SystemExit("대상 날짜가 없다.")
        print(f"대상 날짜: {', '.join(dates)}")
        rows = collect_local(dates)

    if not rows:
        print("변환할 결과가 없다.")
        return
    merge_and_write(rows, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
