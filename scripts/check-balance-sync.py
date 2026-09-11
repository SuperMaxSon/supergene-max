#!/usr/bin/env python3
"""Rosewood 신판 시트(2026-09-11) 동기화 검증.

exit 0 = 전부 통과, exit 1 = 실패 있음.
Python3 stdlib only.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BALANCE = ROOT / "docs" / "data" / "rosewood-balance.json"
JS_DIR = ROOT / "docs" / "js"
ENGINE = JS_DIR / "rosewood-order-engine.js"
MODEL = JS_DIR / "rosewood-model.js"

results = []  # (ok: bool, label: str, detail: str)


def check(ok, label, detail=""):
    results.append((bool(ok), label, detail))


# ---------------------------------------------------------------- 1. balance.json
def check_balance():
    try:
        data = json.loads(BALANCE.read_text(encoding="utf-8"))
    except Exception as e:
        check(False, "balance.json load", str(e))
        return None

    # order_rule: 5행 + order_type 집합
    rule = data.get("order_rule", [])
    types = {r.get("order_type") for r in rule}
    expected = {"normal", "special", "high", "random_3", "random_4"}
    check(
        len(rule) == 5 and types == expected,
        "order_rule 5행 + order_type 집합",
        f"rows={len(rule)}, types={sorted(str(t) for t in types)}",
    )

    # order_rule 전 행 item_slot_max == 2
    bad = [r.get("order_type") for r in rule if r.get("item_slot_max") != 2]
    check(not bad, "order_rule 전 행 item_slot_max == 2",
          f"위반: {bad}" if bad else "")

    # order_slot_band: 12행, 폐기 키 부재 + 필수 키 존재
    band = data.get("order_slot_band", [])
    gone = ("diff_sum_min", "diff_sum_max", "second_min", "third_min", "third_max")
    keep = ("first_min", "first_max", "second_max")
    issues = []
    if len(band) != 12:
        issues.append(f"rows={len(band)} (기대 12)")
    for i, row in enumerate(band):
        for k in gone:
            if k in row:
                issues.append(f"row{i}: 폐기 키 {k} 잔존")
        for k in keep:
            if k not in row:
                issues.append(f"row{i}: 필수 키 {k} 부재")
    check(not issues, "order_slot_band 12행 + 폐기/필수 키", "; ".join(issues))

    # order_fixed: requirement_3 부재
    fixed = data.get("order_fixed", [])
    bad = [i for i, row in enumerate(fixed) if "requirement_3" in row]
    check(not bad, "order_fixed requirement_3 키 없음",
          f"잔존 행 index: {bad}" if bad else "")

    # order_item_count: 8행, 전 행 item_count <= 2
    oic = data.get("order_item_count", [])
    issues = []
    if len(oic) != 8:
        issues.append(f"rows={len(oic)} (기대 8)")
    over = [i for i, row in enumerate(oic) if not (isinstance(row.get("item_count"), (int, float)) and row["item_count"] <= 2)]
    if over:
        issues.append(f"item_count>2 행 index: {over}")
    check(not issues, "order_item_count 8행 + item_count<=2", "; ".join(issues))

    # const 키 검사
    const = data.get("const", {})
    issues = []
    if const.get("order_repeat_reset_count") != 3:
        issues.append(f"order_repeat_reset_count={const.get('order_repeat_reset_count')!r} (기대 3)")
    for k in ("order_daily_diff_band_1", "order_daily_diff_band_2",
              "order_daily_diff_reset_utc_sec"):
        if k in const:
            issues.append(f"폐기 상수 {k} 잔존")
    check(not issues, "const order_repeat_reset_count(3) + daily_diff 부재",
          "; ".join(issues))

    # item_spec 행수 == _meta.tabs.item_spec.records
    spec_rows = len(data.get("item_spec", []))
    meta_rows = data.get("_meta", {}).get("tabs", {}).get("item_spec", {}).get("records")
    check(spec_rows == meta_rows, "item_spec 행수 == _meta.records",
          f"item_spec={spec_rows}, _meta={meta_rows}")

    return data


# ---------------------------------------------------------------- 2. 폐기 토큰
TOKENS = ("diff_sum", "dailyDiff", "SPEC_ITEM_SLOT_MAX", "third_min", "order_daily_diff")
EXEMPT_WORDS = ("삭제", "폐기", "없다", "신판", "걷었다")

# 코드 예외 — 구판 데이터도 읽어야 하는 정규화 레이어. 「오더 시뮬레이터」의
# 구판 번들 재투입 회귀가 이 함수에 걸려 있어서, 폐기 열 이름이 코드에 남는 게 맞다.
# (파일 이름, 블록 시작 문자열, 블록 끝 문자열) — 시작~끝 사이 줄은 코드 토큰도 통과.
CODE_EXEMPT_BLOCKS = (
    ("rosewood-order-engine.js", "function seatRange(", "const rangeText"),
)


def comment_ranges(line, in_block):
    """줄 안의 주석 구간 [(start,end)) 목록과, 줄 끝의 블록주석 상태를 반환."""
    ranges = []
    i, n = 0, len(line)
    start = 0 if in_block else None
    in_str = None
    while i < n:
        c = line[i]
        if in_block:
            if line.startswith("*/", i):
                ranges.append((start, i + 2))
                in_block = False
                start = None
                i += 2
                continue
            i += 1
            continue
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"', "`"):
            in_str = c
            i += 1
            continue
        if line.startswith("//", i):
            ranges.append((i, n))
            return ranges, False
        if line.startswith("/*", i):
            in_block = True
            start = i
            i += 2
            continue
        i += 1
    if in_block:
        ranges.append((start, n))
    return ranges, in_block


def check_tokens():
    violations = []
    for path in sorted(JS_DIR.glob("*.js")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception as e:
            violations.append(f"{path}: 읽기 실패 ({e})")
            continue
        in_block = False
        line_comments = []  # per-line comment ranges
        for line in lines:
            ranges, in_block = comment_ranges(line, in_block)
            line_comments.append(ranges)
        exempt_lines = set()
        for fname, start_pat, end_pat in CODE_EXEMPT_BLOCKS:
            if path.name != fname:
                continue
            begin = None
            for idx, line in enumerate(lines):
                if begin is None and start_pat in line:
                    begin = idx
                elif begin is not None and end_pat in line:
                    exempt_lines.update(range(begin, idx + 1))
                    begin = None
        for idx, line in enumerate(lines):
            for tok in TOKENS:
                for m in re.finditer(re.escape(tok), line):
                    pos = m.start()
                    in_comment = any(s <= pos < e for s, e in line_comments[idx])
                    if in_comment:
                        lo = max(0, idx - 2)
                        hi = min(len(lines), idx + 3)
                        ctx = "\n".join(lines[lo:hi])
                        if any(w in ctx for w in EXEMPT_WORDS):
                            continue  # 설명용 주석 → 통과
                        violations.append(
                            f"{path.relative_to(ROOT)}:{idx + 1} 주석 내 '{tok}' (면제어 없음)")
                    elif idx not in exempt_lines:
                        violations.append(
                            f"{path.relative_to(ROOT)}:{idx + 1} 코드에 '{tok}' 잔존")
    check(not violations, "docs/js 폐기 토큰 잔존 없음",
          "; ".join(violations))


# ---------------------------------------------------------------- 3. 내장 블록 행수
DB_MAP = [
    ("ITEM_DB", "item_spec"),
    ("ORDER_DB", "order_item"),
    ("RULE_DB", "order_rule"),
    ("BAND_DB", "order_slot_band"),
    ("COUNT_DB", "order_item_count"),
    ("FIXED_DB", "order_fixed"),
    ("AVATAR_DB", "order_avatar"),
    ("LEVEL_DB", "level_curve"),
]


def count_db_rows(src, name):
    """`const NAME = [` 부터 `\n];` 까지에서 최상위 `  [` 로 시작하는 줄 수."""
    m = re.search(rf"^const {re.escape(name)} = \[\s*$", src, re.M)
    if not m:
        return None
    rest = src[m.end():]
    end = re.search(r"^\];", rest, re.M)
    if not end:
        return None
    block = rest[: end.start()]
    return sum(1 for ln in block.splitlines() if ln.startswith("  ["))


def check_db_counts(data):
    if data is None:
        check(False, "engine DB 행수 대조", "balance.json 로드 실패로 생략")
        return
    try:
        src = ENGINE.read_text(encoding="utf-8")
    except Exception as e:
        check(False, "engine DB 행수 대조", f"engine.js 읽기 실패: {e}")
        return
    for db_name, tab in DB_MAP:
        n_js = count_db_rows(src, db_name)
        n_json = len(data.get(tab, []))
        check(n_js == n_json, f"{db_name} == {tab} 행수",
              f"js={n_js}, json={n_json}")


# ---------------------------------------------------------------- 4. node --check
def check_syntax():
    for path in (ENGINE, MODEL):
        label = f"node --check {path.name}"
        try:
            p = subprocess.run(["node", "--check", str(path)],
                               capture_output=True, text=True, timeout=30)
        except FileNotFoundError:
            check(False, label, "node 실행 파일 없음")
            continue
        except Exception as e:
            check(False, label, str(e))
            continue
        detail = (p.stderr or p.stdout).strip().splitlines()
        check(p.returncode == 0, label, detail[0] if detail else "")


# ---------------------------------------------------------------- main
def main():
    data = check_balance()
    check_tokens()
    check_db_counts(data)
    check_syntax()

    fails = 0
    for ok, label, detail in results:
        mark = "PASS" if ok else "FAIL"
        line = f"[{mark}] {label}"
        if detail and not ok:
            line += f" — {detail}"
        print(line)
        if not ok:
            fails += 1
    print(f"\n{len(results) - fails}/{len(results)} passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
