#!/usr/bin/env python3
"""클라 밸런스시트 → 초기 보드 문서용 데이터.

`rosewood-initial-board.html` 은 보드를 눌러 볼 수 있어야 해서 정적 표가 아니라
`docs/data/rosewood-board.json` 을 읽어 그린다. 이 스크립트가 그 파일을 만든다.

담는 것은 두 가지뿐이다.
  board — initial_board 63행을 cell 번호로 접은 것 (코드 · 상자 · 거미줄)
  items — 보드에서 **머지로 도달할 수 있는** 코드 전부의 이름 · 체인 · 단계 · 다음 단계
          (보드에 깔린 54종만 담으면 합친 결과의 이름·다음 단계를 모른다)

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


def nxt(code):
    """시트는 빈 칸을 문자열 "none" 으로 내려보낸다 — 숫자일 때만 다음 단계로 본다."""
    raw = spec[code].get("merged_item_code")
    return raw if isinstance(raw, int) and raw > 0 else 0


board = [None] * (COLS * ROWS)
for r in bal["initial_board"]:
    if not r.get("in_use", True):
        continue
    cell = (r["y"] - 1) * COLS + (r["x"] - 1)
    board[cell] = {"code": r["item_code"], "box": bool(r["paper_box"]), "web": bool(r["cobweb"])}

# 보드에 깔린 코드에서 merged_item_code 를 따라가며 닫는다.
codes, queue = set(), [c["code"] for c in board if c]
while queue:
    c = queue.pop()
    if c in codes or c not in spec:
        continue
    codes.add(c)
    n = nxt(c)
    if n:
        queue.append(n)

items = {}
for c in sorted(codes):
    s, d = spec[c], disp.get(c, {})
    items[str(c)] = {
        "name": loc.get(d.get("name_key", ""), d.get("name_key", str(c))),
        "chain": s.get("chain_id", 0),
        "step": s.get("step", 0),
        "next": nxt(c),
        "gen": bool(s.get("is_generator")),
        "img": os.path.exists(os.path.join(IMG, f"{c}.png")),
    }

out = {
    "_meta": {
        "source": "story-merge-proto-client/assets/bundle/data/rosewood-balance.json",
        "sheet": bal.get("_meta", {}),
        "cols": COLS,
        "rows": ROWS,
    },
    "board": board,
    "items": items,
}
json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

missing = [c for c in sorted(codes) if not items[str(c)]["img"]]
print(f"wrote {OUT}")
print(f"  cells {sum(1 for c in board if c)} / {COLS * ROWS} · items {len(items)} · 이미지 없음 {missing}")
