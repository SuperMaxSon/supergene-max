#!/usr/bin/env python3
"""클라 밸런스시트 → 초기 보드 문서용 데이터.

`rosewood-initial-board.html` 은 보드를 눌러 볼 수 있어야 해서 정적 표가 아니라
`docs/data/rosewood-board.json` 을 읽어 그린다. 이 스크립트가 그 파일을 만든다.

담는 것은 세 가지.
  board — initial_board 63행을 cell 번호로 접은 것 (코드 · 상자 · 거미줄)
  items — 보드 + 오더 요구 아이템 + main_task/level_curve 보상 아이템에서
          **머지·생산으로 도달할 수 있는** 코드 전부의 이름 · 체인 · 단계 ·
          다음 단계, 그리고 생성기면 산출 규격(`p`)까지
          (보드에 깔린 것만 담으면 오더·보상이 요구하는 코드를 모른다)
  bal   — 자동 플레이 엔진(§B2)이 쓰는 밸런스 원본 조각(심부름 · 레벨 곡선 ·
          보상 키 · 오더 룰 7종 · 아이템 스펙 · 상수). 열은 지우지 않고
          `main_task`/`item_spec` 에만 `name`(en 로컬라이즈)을 얹는다.

사용:  python3 scripts/board2web.py
"""
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME = os.path.expanduser("~/Projects/story-merge-proto-client")
BAL = os.path.join(GAME, "assets/bundle/data/rosewood-balance.json")
LOC = os.path.join(GAME, "assets/localization/en.json")
OUT = os.path.join(HERE, "docs", "data", "rosewood-board.json")
IMG = os.path.join(HERE, "docs", "img", "items")

COLS, ROWS = 7, 9

bal = json.load(open(BAL, encoding="utf-8"))
loc = json.load(open(LOC, encoding="utf-8"))
spec = {r["item_code"]: r for r in bal["item_spec"]}
disp = {r["item_code"]: r for r in bal["item_display"]}


PRODUCE_SLOT_MAX = 20


def produce_of(s):
    """생성기 산출 규격. `produce_weight_N` 은 확률이 아니라 **개수**다(정본 A1)."""
    slots = []
    for n in range(1, PRODUCE_SLOT_MAX + 1):
        code, cnt = s.get(f"produce_item_{n}"), s.get(f"produce_weight_{n}")
        if not isinstance(code, int) or code <= 0:
            continue
        if not isinstance(cnt, int) or cnt <= 0:
            continue
        slots.append([code, cnt])
    if not slots:
        return None
    return {
        "auto": bool(s.get("spread_auto")),        # 자동 산출은 탭을 받지 않는다(정본 1.1.1)
        "wt": s.get("spread_weight_type", 1),      # 1 = 비면 재충전 · 2 = 소모형(재충전 없음)
        "max": s.get("spread_item_max", 0),        # 재고 상한. 시작은 만땅
        "cost": s.get("spread_cost_energy", 0),
        "rec": s.get("spread_item_recovery_sec", 0),
        "slots": slots,
    }


def nxt(code):
    """시트는 빈 칸을 문자열 "none" 으로 내려보낸다 — 숫자일 때만 다음 단계로 본다."""
    raw = spec[code].get("merged_item_code")
    return raw if isinstance(raw, int) and raw > 0 else 0


def item_name(code):
    """`item_display.name_key` 를 en 로컬라이즈. 못 찾으면 키 그대로(정본 B1)."""
    d = disp.get(code, {})
    key = d.get("name_key", "")
    return loc.get(key, key or str(code))


# reward_key(문자열) → item_code. "머지 아이템" 분류만 실제 아이템이고
# 재화/부스터/이벤트 토큰은 item_code=0 이라 닫힘 대상이 아니다.
reward_key_to_item = {
    r["reward_key"]: r["item_code"]
    for r in bal["reward_key"]
    if r.get("category") == "머지 아이템" and isinstance(r.get("item_code"), int) and r["item_code"] > 0
}


def reward_item_codes(rows):
    """main_task/level_curve 의 reward_item_key_1~3 을 item_code 로 푼다."""
    out = set()
    for row in rows:
        for i in (1, 2, 3):
            code = reward_key_to_item.get(row.get(f"reward_item_key_{i}"))
            if code:
                out.add(code)
    return out


board = [None] * (COLS * ROWS)
for r in bal["initial_board"]:
    if not r.get("in_use", True):
        continue
    cell = (r["y"] - 1) * COLS + (r["x"] - 1)
    board[cell] = {"code": r["item_code"], "box": bool(r["paper_box"]), "web": bool(r["cobweb"])}

# 닫힘 시작점: 보드 + 오더가 요구하는 전 코드 + 심부름/레벨업 보상 아이템.
# 여기서 다시 merged_item_code · 생성기 산출로 닫는다(B1).
seed = {c["code"] for c in board if c}
seed |= {r["item_code"] for r in bal["order_item"]}
seed |= reward_item_codes(bal["main_task"])
seed |= reward_item_codes(bal["level_curve"])

codes, queue = set(), list(seed)
while queue:
    c = queue.pop()
    if c in codes or c not in spec:
        continue
    codes.add(c)
    n = nxt(c)
    if n:
        queue.append(n)
    p = produce_of(spec[c])
    if p:
        queue.extend(slot[0] for slot in p["slots"])

items = {}
for c in sorted(codes):
    s = spec[c]
    items[str(c)] = {
        "name": item_name(c),
        "chain": s.get("chain_id", 0),
        "step": s.get("step", 0),
        "next": nxt(c),
        "gen": bool(s.get("is_generator")),
        "img": os.path.exists(os.path.join(IMG, f"{c}.png")),
    }
    p = produce_of(s)
    if p:
        items[str(c)]["p"] = p

# bal — 자동 플레이 엔진(B2)이 그대로 읽는 원본 조각. 열은 지우지 않는다(B1).
const_dict = {r["const_name"]: r["const_value"] for r in bal["const"]}

main_task_out = [
    {**r, "name": loc.get(r["name_key"], r["name_key"])}
    for r in bal["main_task"] if r.get("in_use", True)
]
main_task_out.sort(key=lambda r: (r["day"], r["task_seq"]))

item_spec_out = [{**r, "name": item_name(r["item_code"])} for r in bal["item_spec"]]

bal_out = {
    "const": const_dict,
    "main_task": main_task_out,
    "item_spec": item_spec_out,
    "level_curve": bal["level_curve"],
    "reward_key": bal["reward_key"],
    "order_rule": bal["order_rule"],
    "order_slot_band": bal["order_slot_band"],
    "order_item": bal["order_item"],
    "order_item_count": bal["order_item_count"],
    "order_fixed": bal["order_fixed"],
    "order_avatar": bal["order_avatar"],
    "order_special": bal["order_special"],
    "event_order_score": bal["event_order_score"],
}

out = {
    "_meta": {
        "source": "story-merge-proto-client/assets/bundle/data/rosewood-balance.json",
        "sheet": bal.get("_meta", {}),
        "cols": COLS,
        "rows": ROWS,
        # 생산은 에너지를 쓴다. 시작값·회복 간격 모두 시트 const 를 그대로 읽는다
        # (정본 「에너지」: 상한 100 · 120초에 1칸 · 나머지 초는 이월).
        "energy": next((r["const_value"] for r in bal["const"]
                        if r.get("const_name") == "default_max_energy"), 100),
        "energyRec": next((r["const_value"] for r in bal["const"]
                           if r.get("const_name") == "default_recovery_duration_sec"), 120),
    },
    "board": board,
    "items": items,
    "bal": bal_out,
}
json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

missing = [c for c in sorted(codes) if not items[str(c)]["img"]]
print(f"wrote {OUT}")
print(f"  cells {sum(1 for c in board if c)} / {COLS * ROWS} · items {len(items)} · 이미지 없음 {len(missing)} {missing}")
print(f"  bal.main_task {len(main_task_out)} · bal.item_spec {len(item_spec_out)}")
