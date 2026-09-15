#!/usr/bin/env python3
"""PMM 밸런스시트 → 오더 추첨 테스트 페이지용 JSON.

오더 추첨 알고리즘(개발 기획서 1.2.1)이 실제로 읽는 탭만 뽑는다.

입력 두 가지
  1) **탭별 JSON 폴더** (현행) — 시트 export 가 탭마다 `<tab>.json` 을 떨군다.
     이미 에디터 전용 열이 빠진 「클라 JSON」이라 화이트리스트가 거의 그대로 통과한다.
  2) xlsx (구형) — 1행 한글 설명 · 2행 컬럼명 · 3행부터 데이터. stdlib 로 직접 읽는다.

이름 칸에 대하여
  신판 클라 JSON 에는 `name_ko` 가 없다(에디터 전용 열). 대신
    영문  item_display.name_key → string_code.en
    한글  직전 출력본에서 item_code 로 넘겨받는다(있으면). 없으면 영문으로 떨어진다.
  벤치·드로우 페이지가 사람 눈으로 읽는 표라서 이름을 버리지 않는다.

판본 판정
  `schema_hash` 는 **열 구조 해시**다. 행 내용이 바뀌어도 안 움직인다
  (신판 order_rule 5행과 구판 4행의 해시가 같다). 판본은 `records` 로 본다.

사용
  python3 scripts/xlsx2balance.py <탭별 JSON 폴더> [out.json]
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

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.expanduser(
    "~/Projects/story-merge-proto-client/_ignore/item-sheets/2026-09-11-export")
DEFAULT_OUT = os.path.join(HERE, "docs", "data", "rosewood-balance.json")

PRODUCE = [c for i in range(1, 21) for c in (f"produce_item_{i}", f"produce_weight_{i}")]

# 탭 → (키 컬럼, 남길 컬럼). 키 컬럼이 비면 패딩 행으로 보고 버린다.
# 2026-09-11 신판 스키마 — 폐기된 열은 여기서도 빠졌다:
#   order_slot_band  diff_sum_min/max · second_min · third_min/max
#   order_fixed      slot_3 · requirement_3
TABS = {
    "order_rule": ("order_type", [
        "order_type", "slot_count", "item_slot_max", "refresh_sec", "unlock_level",
        "refill_max", "card_skin_key", "card_hilite_key", "in_use"]),
    "order_slot_band": ("order_type", [
        "order_type", "band_seq", "level_min", "level_max",
        "first_min", "first_max", "second_max", "in_use"]),
    # progress_unlock·difficulty_level 은 2026-09-14 신판(정본 v1.4)이 원작에서 복원한 열이다.
    # 둘 다 추첨 절차가 직접 읽는다 — 화이트리스트에 없으면 조용히 빠져서
    # 「열이 없다」로 오진한다(2026-09-15 실제로 그랬다).
    #   progress_unlock  1 이면 바로 전 실제 단계의 영구 해금 이력이 필요하다
    #   difficulty_level 양수면 자리 단계 범위 비교에 step 대신 이 값을 쓴다
    "order_item": ("item_code", [
        "item_code", "unlock_level", "order_price", "diff_score", "weight", "weight_multiple",
        "repeat_weight_decrease", "progress_unlock", "difficulty_level", "in_use"]),
    "order_item_count": ("level", ["level", "item_count", "count_weight", "in_use"]),
    # 추첨 알고리즘은 안 읽지만 엔진의 reindex 가 인덱스를 만든다 — 30행이라 넣어 두는 편이 싸다
    "level_curve": ("level", [
        "level", "exp_cost", "reward_item_key_1", "reward_amount_1",
        "reward_item_key_2", "reward_amount_2", "reward_item_key_3", "reward_amount_3", "in_use"]),
    "order_avatar": ("avatar_key", [
        "avatar_key", "portrait_key", "open_day", "in_use"]),
    # 특별주문 — 신판에서 주기 발급이 아니라 trigger_task 로 뜨는 대본형이 됐다
    "order_special": ("special_no", [
        "special_no", "chain_key", "start_item_code", "avatar_key", "trigger_task",
        "name_key", "duration_sec", "in_use"]),
    "order_fixed": ("fixed_seq", [
        "fixed_seq", "unlock_level", "slot_1", "slot_2",
        "requirement_1", "requirement_2", "in_use"]),
    "event_order_score": ("event_id", [
        "event_id", "band_seq", "score_base", "score_min", "score_max",
        "token_pct", "token_fix", "in_use"]),
    "item_spec": ("item_code", [
        "item_code", "merged_item_code", "chain_id", "step", "is_generator", "rare",
        "selling_price", "protect_level", "spread_auto", "spread_weight_type",
        "spread_item_max", "spread_storage_max", "spread_cost_energy",
        "spread_item_recovery_sec", "spread_storage_recovery_sec",
        "shop_price", "merge_score_race",
        # 생성기 연결 예외 — 정본 v1.4 가 복원한 두 열. 0 이면 기본 연결(자기 체인)이고,
        # 양수면 그 체인에서 spread_weight_type != 0 인 코드를 생성기로 본다.
        # 현재 실물은 차 체인(501~510)만 예외다: first=6(찻잔) · second=4(찻주전자).
        "first_generator_chain_id", "second_generator_chain_id",
        ] + PRODUCE + ["in_use"]),
}
CONST_TAB = "const"
MANIFEST_TAB = "data_manifest"
# 이름 조립에만 쓰고 출력에는 통째로 싣지 않는 탭
NAME_TABS = ("item_display", "string_code")


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

    def raw_rows(self, name):
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

    def records(self, name):
        """2행(컬럼명) 기준으로 dict 리스트를 만든다 — JSON 폴더 모드와 같은 모양."""
        rows = self.raw_rows(name)
        if len(rows) < 3:
            return []
        header = {k: v for k, v in rows[1].items() if v}
        return [{header[k]: v for k, v in r.items() if k in header} for r in rows[2:]]


class Folder:
    """탭별 JSON 폴더 리더 — `<tab>.json` 하나가 탭 하나다."""

    def __init__(self, path):
        self.path = path
        self.sheets = {f[:-5]: os.path.join(path, f)
                       for f in os.listdir(path) if f.endswith(".json")}

    def find_tab(self, name):
        return name if name in self.sheets else None

    def records(self, name):
        with open(self.sheets[name], encoding="utf-8") as f:
            rows = json.load(f)
        return rows if isinstance(rows, list) else rows.get("rows", [])


def cast(v):
    """시트 값은 문자열로 오고 JSON 값은 이미 형이 있다 — 불린은 0/1 로 눕힌다."""
    if v is None or v == "":
        return None
    if v is True:
        return 1
    if v is False:
        return 0
    if isinstance(v, (int, float)):
        return int(v) if float(v) == int(v) else v
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
    rows = book.records(tab)
    if not rows:
        return [], list(cols)
    present = set()
    for r in rows[:5]:
        present |= set(r.keys())
    missing = [c for c in cols if c not in present]
    out = []
    for r in rows:
        rec = {c: cast(r.get(c)) for c in cols if c in present}
        if rec.get(key_col) in (None, ""):
            continue
        # 빈 생성기 슬롯을 그대로 실으면 item_spec 이 319KB 가 된다 (234행 × 20슬롯,
        # 그중 대부분이 전부 none). 채워진 슬롯만 남긴다 — 엔진은 없는 키를 안 읽는다.
        for i in range(1, 21):
            if rec.get(f"produce_item_{i}") in (None, "none", 0, ""):
                rec.pop(f"produce_item_{i}", None)
                rec.pop(f"produce_weight_{i}", None)
        out.append(rec)
    return out, missing


# 정본 v1.5 §13 「T14 이름 확정」이 직접 적어 준 10종. export 에는 name_ko 가
# 없고 직전 출력본에도 없던(= 신판에서 새로 생긴) 아이템이라 이월로는 못 채운다.
# 새 export 가 name_ko 를 싣고 오면 이 표는 지운다 — 그때는 시트가 정본이다.
SPEC_NAMES = {
    211: "정밀 공구 세트", 212: "전문가 공구 캐비닛", 213: "복원 장비 카트",
    214: "장인 공구 컬렉션", 813: "축하 케이크", 814: "디저트 카트",
    815: "연회 디저트 테이블", 1312: "로즈우드 리넨 컬렉션",
    3201: "심플 상자", 3202: "팬시 상자",
}

# 위 SPEC_NAMES 와 출처가 다르다 — 정본이 확정해 준 이름이 아니라, 09-15 export 에
# 새로 생긴 상자류(생성기 아님·order_item 후보 아님) 5종을 영문 name_key 뜻 그대로
# 옮긴 임시값이다. 정본이 이 코드들의 이름을 확정하면 이 표에서 지우고 SPEC_NAMES
# (또는 이월)로 옮긴다.
SPEC_NAMES_TRANSLATED = {
    3203: "대형 무료 선물 상자",  # Large Free Gift Chest (chain 32 step3)
    3301: "스타터 에너지 상자",   # Starter Energy Chest
    3401: "소형 에너지 상자",     # Small Energy Chest
    3501: "스타터 젬 상자",       # Starter Gem Chest
    3601: "스타터 보급 상자",     # Starter Supply Chest
}


def build_names(book, legacy_path):
    """item_code → {name_ko, name_en}.

    영문은 item_display.name_key → string_code.en 으로 조립한다.
    한글은 시트에 없다(에디터 전용) — 직전 출력본에서 넘겨받는다."""
    names = {}
    disp = book.find_tab("item_display")
    strs = book.find_tab("string_code")
    if disp and strs:
        en = {}
        for r in book.records(strs):
            k = r.get("Key") or r.get("key")
            if k:
                en[k] = r.get("en")
        for r in book.records(disp):
            code = cast(r.get("item_code"))
            key = r.get("name_key")
            if code is None:
                continue
            v = en.get(key)
            names[code] = {"name_en": v if v and v != "none" else None}
    legacy = {}
    if legacy_path and os.path.exists(legacy_path):
        try:
            with open(legacy_path, encoding="utf-8") as f:
                old = json.load(f)
            for r in old.get("item_spec", []):
                if r.get("name_ko") or r.get("name"):
                    legacy[r["item_code"]] = r.get("name_ko") or r.get("name")
        except (ValueError, KeyError):
            pass
    # 우선순위: 정본 확정 > 영문 임시 번역 > 직전 출력본 이월 > 영문 그대로. 정본/임시
    # 번역 두 표는 사람이 이번에 직접 적어 넣은 값이라 이월(직전 산출물을 그대로 베낀
    # 값, 지난 판이 정답이라는 보장이 없다)보다 세다. SPEC_NAMES_TRANSLATED 는 legacy_path
    # 가 곧 이번 출력 파일이라 직전 실행에서 새로 생긴 코드에 영문을 그대로 흘려보낸
    # 경우(이월 자체가 영문)를 다시 영문으로 확정해버리는 것을 막기 위해 이월보다 위에 둔다.
    for code, rec in names.items():
        rec["name_ko"] = (
            SPEC_NAMES.get(code)
            or SPEC_NAMES_TRANSLATED.get(code)
            or legacy.get(code)
            or rec.get("name_en")
        )
    for code, ko in legacy.items():
        names.setdefault(code, {"name_en": None, "name_ko": ko})
    for code, ko in SPEC_NAMES_TRANSLATED.items():
        names.setdefault(code, {"name_en": None, "name_ko": ko})
        names[code]["name_ko"] = ko
    for code, ko in SPEC_NAMES.items():
        names.setdefault(code, {"name_en": None, "name_ko": ko})
        names[code]["name_ko"] = ko
    return names, len(legacy)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    if not os.path.exists(src):
        sys.exit(f"입력 없음: {src}")
    book = Folder(src) if os.path.isdir(src) else Book(src)
    mode = "탭별 JSON 폴더" if isinstance(book, Folder) else "xlsx"

    data, meta_tabs, warn = {}, {}, []

    # const 는 행 목록(const_name / const_value)이라 객체로 눕힌다 — 엔진은 C.key 로 읽는다
    ctab = book.find_tab(CONST_TAB)
    consts, const_off = {}, []
    for r in book.records(ctab):
        name = r.get("const_name")
        if not name:
            continue
        if "in_use" in r and cast(r.get("in_use")) != 1:
            const_off.append(name)
            continue
        consts[name] = cast(r.get("const_value"))
    data["const"] = consts
    if const_off:
        warn.append(f"const 비활성 {len(const_off)}개 제외: {', '.join(const_off[:6])}")

    names, carried = build_names(book, out)

    for tab, (key_col, cols) in TABS.items():
        real = book.find_tab(tab)
        if not real:
            warn.append(f"탭 없음: {tab}")
            data[tab] = []
            continue
        rows, missing = table(book, real, key_col, cols)
        # 사람이 읽는 표라 이름을 붙여 둔다 — 시트 열이 아니라 조립값이다
        if tab in ("item_spec", "order_item"):
            for r in rows:
                nm = names.get(r.get("item_code"))
                if nm:
                    r["name_ko"] = nm.get("name_ko")
                    r["name_en"] = nm.get("name_en")
        # 판매 확인창 플래그 — 정본(시트·웹)의 열 이름은 `rare` 하나뿐이다.
        # `show_sell_confirm` 은 여기서 붙이는 별칭이고, 엔진 ITEM_DB 가 그 이름으로
        # 굳어 있어서 복사해 준다. 개명이 아니다 — 시트에서 찾으면 안 나온다
        # (2026-09-11 신판 36탭 전수 0건, 밸런스시트 웹도 `rare` 로 쓴다).
        if tab == "item_spec":
            # 시트가 진짜 그 열을 갖게 되는 날을 잡는 자리다. 화이트리스트(TABS)에
            # 없는 열은 table() 이 먼저 걷어내므로, 아래 별칭이 그 값을 조용히 덮는
            # 대신 원본 레코드를 직접 들여다본다. 이 경고가 뜨면 별칭을 걷고
            # `show_sell_confirm` 을 화이트리스트에 넣어 시트 값을 그대로 써야 한다.
            raw = book.records(real) or []
            if any("show_sell_confirm" in r for r in raw[:5]):
                warn.append("item_spec 에 실제 show_sell_confirm 열이 생겼다 — "
                            "별칭을 걷고 TABS 화이트리스트에 추가할 것")
            for r in rows:
                r["show_sell_confirm"] = r.get("rare") or 0
        data[tab] = rows
        if real != tab:
            warn.append(f"탭 이름 접두: '{real}' → {tab}")
        if missing:
            warn.append(f"{tab} 컬럼 없음: {', '.join(missing)}")
        meta_tabs[tab] = {"records": len(rows), "columns": len(cols)}
    meta_tabs[CONST_TAB] = {"records": len(consts), "columns": 3}

    # xlsx 에는 data_manifest 탭이 있다 — 있으면 행 수를 대조한다.
    mtab = book.find_tab(MANIFEST_TAB)
    if mtab:
        want = set(TABS) | {CONST_TAB}
        for r in book.records(mtab):
            t = r.get("table")
            if t not in want:
                continue
            m = meta_tabs.setdefault(t, {})
            m["manifest_records"] = cast(r.get("records"))
            m["schema_hash"] = r.get("schema_hash")
            if m.get("records") is not None and m["records"] != m["manifest_records"]:
                warn.append(f"{t} 행 수 불일치: 추출 {m['records']} · manifest {m['manifest_records']}")
    else:
        warn.append("data_manifest 없음 — 행 수는 추출값이 정본이다")

    st = os.stat(src)
    payload = {
        "_meta": {
            "source": os.path.basename(src.rstrip("/")),
            "source_mode": mode,
            "source_mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc)
                .astimezone().isoformat(timespec="seconds"),
            "converted_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "converter": "scripts/xlsx2balance.py",
            "name_ko_carried": carried,
            "name_source": "시트 export 엔 name_ko 가 없다(에디터 전용 열이라 클라 JSON 에서 빠진다). "
                "그래서 이름은 직전 출력본 이월 + SPEC_NAMES 로 채운다 — 정본이 "
                "「변환기는 이 이름을 item_code 로 연결한다」고 이 경로를 인정했다. "
                "SPEC_NAMES_TRANSLATED 5종(3203/3301/3401/3501/3601)은 정본 확정이 아니라 "
                "우리가 영문에서 옮긴 임시값이다.",
            "version_check": "판본은 tabs[].records 로 본다. schema_hash 는 열 구조라 내용 변화에 안 움직인다",
            "tabs": meta_tabs,
            "warnings": warn,
        },
    }
    payload.update(data)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    print(f"→ {out}  ({os.path.getsize(out) / 1024:.1f} KB)  · 입력 {mode}")
    for t in ["const"] + list(TABS):
        n = len(data[t]) if isinstance(data[t], list) else len(data[t])
        print(f"   {t:20s} {n:>4d}")
    print(f"   (한글 이름 {carried}종 이월)")
    if warn:
        print("\n경고:")
        for w in warn:
            print("   ·", w)


if __name__ == "__main__":
    main()
