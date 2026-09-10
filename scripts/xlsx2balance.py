#!/usr/bin/env python3
"""PMM 밸런스시트(xlsx) → 오더 추첨 테스트 페이지용 JSON.

오더 추첨 알고리즘(개발 기획서 1.2.1)이 실제로 읽는 9탭만 뽑는다.
xlsx 는 zip + XML 이라 외부 라이브러리가 필요 없다 — 허브에 의존을 늘리지 않으려고
openpyxl 대신 stdlib 로 직접 읽는다.

시트 규약
  1행 = 한글 설명 · 2행 = 컬럼명(key) · 3행부터 데이터
  「◻︎ 에디터 전용」 컬럼은 클라 JSON 에서 빠진다 — 화이트리스트로 걸러 낸다

사용
  python3 scripts/xlsx2balance.py                        # 기본 경로
  python3 scripts/xlsx2balance.py <xlsx> [out.json]
"""
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

DEFAULT_XLSX = os.path.expanduser("~/Downloads/[PMM] 밸런스시트.xlsx")
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "docs", "data", "rosewood-balance.json")

PRODUCE = [c for i in range(1, 21) for c in (f"produce_item_{i}", f"produce_weight_{i}")]

# 탭 → (키 컬럼, 남길 컬럼). 키 컬럼이 비면 패딩 행으로 보고 버린다.
TABS = {
    "order_rule": ("order_type", [
        "order_type", "slot_count", "item_slot_max", "refresh_sec", "unlock_level",
        "refill_max", "card_skin_key", "card_hilite_key", "in_use"]),
    "order_slot_band": ("order_type", [
        "order_type", "band_seq", "level_min", "level_max", "diff_sum_min", "diff_sum_max",
        "first_min", "first_max", "second_min", "second_max", "third_min", "third_max", "in_use"]),
    "order_item": ("item_code", [
        "item_code", "unlock_level", "order_price", "diff_score", "weight", "weight_multiple",
        "repeat_weight_decrease", "in_use", "name_ko", "chain_name_ko"]),
    "order_item_count": ("level", ["level", "item_count", "count_weight", "in_use"]),
    # 추첨 알고리즘은 안 읽지만 엔진의 reindex 가 인덱스를 만든다 — 30행이라 넣어 두는 편이 싸다
    "level_curve": ("level", [
        "level", "exp_cost", "cum_exp", "reward_item_key_1", "reward_amount_1", "in_use"]),
    "order_avatar": ("avatar_key", [
        "avatar_key", "portrait_key", "open_day", "unlock_level", "in_use", "name_ko"]),
    "order_fixed": ("fixed_seq", [
        "fixed_seq", "unlock_level", "slot_1", "slot_2", "slot_3",
        "requirement_1", "requirement_2", "requirement_3", "in_use"]),
    "event_order_score": ("event_id", [
        "event_id", "band_seq", "score_base", "score_min", "score_max",
        "token_pct", "token_fix", "in_use", "event_type"]),
    "item_spec": ("item_code", [
        "item_code", "merged_item_code", "chain_id", "step", "is_generator", "rare",
        "selling_price", "protect_level", "spread_auto", "spread_item_max", "spread_storage_max",
        "spread_cost_energy", "spread_item_recovery_sec", "shop_price", "merge_score_race",
        ] + PRODUCE + ["in_use", "name_ko", "chain_name_ko", "chain_key"]),
}
CONST_TAB = "const"
MANIFEST_TAB = "data_manifest"


class Book:
    """xlsx 최소 리더 — 값만 읽는다. 수식/서식은 보지 않는다."""

    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        rels = {r.get("Id"): r.get("Target")
                for r in ET.fromstring(self.z.read("xl/_rels/workbook.xml.rels"))}
        self.sheets = {}
        for s in ET.fromstring(self.z.read("xl/workbook.xml")).find(NS + "sheets"):
            t = rels[s.get(RNS + "id")]
            self.sheets[s.get("name")] = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
        self.sst = []
        if "xl/sharedStrings.xml" in self.z.namelist():
            for si in ET.fromstring(self.z.read("xl/sharedStrings.xml")):
                self.sst.append("".join(t.text or "" for t in si.iter(NS + "t")))

    def find_tab(self, name):
        """`작성중 event_order_score` 처럼 접두가 붙은 탭도 잡는다."""
        if name in self.sheets:
            return name
        for k in self.sheets:
            if k.strip().endswith(name):
                return k
        return None

    def rows(self, name):
        out = []
        for row in ET.fromstring(self.z.read(self.sheets[name])).iter(NS + "row"):
            cells = {}
            for c in row.iter(NS + "c"):
                col = re.match(r"[A-Z]+", c.get("r")).group(0)
                v, isv = c.find(NS + "v"), c.find(NS + "is")
                if c.get("t") == "s" and v is not None:
                    val = self.sst[int(v.text)]
                elif isv is not None:
                    val = "".join(t.text or "" for t in isv.iter(NS + "t"))
                else:
                    val = v.text if v is not None else None
                cells[col] = val
            out.append(cells)
        return out


def cast(v):
    """시트 값은 전부 문자열로 온다 — 숫자는 숫자로, 불린은 0/1 로 눕힌다."""
    if v is None or v == "":
        return None
    s = str(v).strip()
    low = s.lower()
    if low in ("true", "y", "yes"):
        return 1
    if low in ("false", "n", "no"):
        return 0
    try:
        f = float(s)
    except ValueError:
        return s
    return int(f) if f == int(f) else f


def table(book, tab, key_col, cols):
    rows = book.rows(tab)
    if len(rows) < 3:
        return []
    header = {k: v for k, v in rows[1].items() if v}
    keep = {k: v for k, v in header.items() if v in cols}
    missing = [c for c in cols if c not in header.values()]
    out = []
    for r in rows[2:]:
        rec = {keep[k]: cast(v) for k, v in r.items() if k in keep}
        if rec.get(key_col) in (None, ""):
            continue
        rec = {c: rec.get(c) for c in cols if c in keep.values()}
        # 빈 생성기 슬롯을 그대로 실으면 item_spec 이 319KB 가 된다 (236행 × 20슬롯,
        # 그중 185행이 전부 none). 채워진 슬롯만 남긴다 — 엔진은 없는 키를 안 읽는다.
        for i in range(1, 21):
            if rec.get(f"produce_item_{i}") in (None, "none", 0, ""):
                rec.pop(f"produce_item_{i}", None)
                rec.pop(f"produce_weight_{i}", None)
        out.append(rec)
    return out, missing


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XLSX
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    if not os.path.exists(src):
        sys.exit(f"xlsx 없음: {src}")
    book = Book(src)

    data, meta_tabs, warn = {}, {}, []

    # const 는 행 목록(const_name / const_value)이라 객체로 눕힌다 — 엔진은 C.key 로 읽는다
    ctab = book.find_tab(CONST_TAB)
    crows = book.rows(ctab)
    chdr = {k: v for k, v in crows[1].items() if v}
    inv = {v: k for k, v in chdr.items()}
    consts, const_off = {}, []
    for r in crows[2:]:
        name = r.get(inv.get("const_name", ""))
        if not name:
            continue
        if cast(r.get(inv.get("in_use", ""))) != 1:
            const_off.append(name)
            continue
        consts[name] = cast(r.get(inv.get("const_value", "")))
    data["const"] = consts
    if const_off:
        warn.append(f"const 비활성 {len(const_off)}개 제외: {', '.join(const_off[:6])}")

    for tab, (key_col, cols) in TABS.items():
        real = book.find_tab(tab)
        if not real:
            warn.append(f"탭 없음: {tab}")
            data[tab] = []
            continue
        rows, missing = table(book, real, key_col, cols)
        data[tab] = rows
        if real != tab:
            warn.append(f"탭 이름 접두: '{real}' → {tab} (아직 작성중)")
        if missing:
            warn.append(f"{tab} 컬럼 없음: {', '.join(missing)}")

    # data_manifest — 판본 확인용. 탭별 행 수/컬럼 수/스키마 해시가 정본이다
    mtab = book.find_tab(MANIFEST_TAB)
    if mtab:
        mrows = book.rows(mtab)
        mh = {k: v for k, v in mrows[1].items() if v}
        minv = {v: k for k, v in mh.items()}
        want = set(TABS) | {CONST_TAB}
        for r in mrows[2:]:
            t = r.get(minv.get("table", ""))
            if t not in want:
                continue
            meta_tabs[t] = {
                "records": cast(r.get(minv.get("records", ""))),
                "columns": cast(r.get(minv.get("columns", ""))),
                "schema_hash": r.get(minv.get("schema_hash", "")),
                "is_critical": cast(r.get(minv.get("is_critical", ""))),
                "in_use": cast(r.get(minv.get("in_use", ""))),
            }

    # 뽑아낸 행 수가 manifest 와 다르면 변환이 흘린 것이다 — 조용히 넘기지 않는다
    for t, m in meta_tabs.items():
        got = len(data[t]) if isinstance(data.get(t), list) else len(data.get(t, {}))
        if m.get("records") is not None and got != m["records"]:
            warn.append(f"{t} 행 수 불일치: 추출 {got} · manifest {m['records']}")

    st = os.stat(src)
    payload = {
        "_meta": {
            "source": os.path.basename(src),
            "source_mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc)
                .astimezone().isoformat(timespec="seconds"),
            "converted_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "converter": "scripts/xlsx2balance.py",
            "tabs": meta_tabs,
            "warnings": warn,
        },
    }
    payload.update(data)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    print(f"→ {out}  ({os.path.getsize(out) / 1024:.1f} KB)")
    for t in ["const"] + list(TABS):
        n = len(data[t]) if isinstance(data[t], list) else len(data[t])
        print(f"   {t:20s} {n:>4d}")
    if warn:
        print("\n경고:")
        for w in warn:
            print("   ·", w)


if __name__ == "__main__":
    main()
