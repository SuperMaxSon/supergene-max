#!/usr/bin/env python3
"""클라 아이템 스프라이트 → 허브 웹 문서용 축소본.

`story-merge-proto-client/assets/bundle/board/items/<item_code>.png` 원본은
100~150px · 20~40KB 라 페이지에 200장 넘게 깔면 무겁다. 웹 문서는
**긴 변 128px · 256색 양자화** 사본을 쓴다(`docs/img/items/`).

이 변환은 원래 손으로 하던 것이라 새 스프라이트가 들어올 때마다 누락됐다.
스크립트로 박아 두고 시트/아트가 갱신되면 다시 돌린다.

사용
  python3 scripts/items2web.py            # 없는 것만 변환
  python3 scripts/items2web.py --all      # 전부 다시 변환
  python3 scripts/items2web.py 211 813    # 지정 코드만
변환 뒤 엔진의 `SPRITE_CODES` 집합도 폴더 실측으로 다시 쓴다 — 손으로 유지하던 목록이라
새 스프라이트가 들어와도 코드가 모르고 이름 글자로만 그리던 문제가 있었다.
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.expanduser(
    "~/Projects/story-merge-proto-client/assets/bundle/board/items")
DST = os.path.join(HERE, "docs", "img", "items")
LONG_EDGE = 128
QUALITY = "40-90"   # 하한을 65 로 두면 색이 많은 몇 장이 양자화를 건너뛰어 3배 무거워진다


def convert(code):
    src = os.path.join(SRC, f"{code}.png")
    dst = os.path.join(DST, f"{code}.png")
    if not os.path.exists(src):
        return None, "원본 없음"
    # sips -Z 는 종횡비를 지키며 긴 변을 맞춘다 — 허브 기존본과 같은 규약
    r = subprocess.run(["sips", "-Z", str(LONG_EDGE), src, "--out", dst],
                       capture_output=True)
    if r.returncode != 0:
        return None, r.stderr.decode()[:80]
    # pngquant 가 있으면 256색으로 눕힌다(기존본이 그 크기다). 없으면 원본 PNG 그대로 둔다.
    q = subprocess.run(["pngquant", "--force", "--skip-if-larger", "--quality", QUALITY,
                        "--output", dst, "--", dst], capture_output=True)
    if q.returncode in (98, 99):   # 품질 미달 — 양자화 없이 두면 3배 무겁다. 하한 없이 한 번 더.
        q = subprocess.run(["pngquant", "--force", "--quality", "0-90",
                            "--output", dst, "--", dst], capture_output=True)
    if q.returncode not in (0, 98, 99):   # 98/99 = 품질 미달로 건너뜀
        return None, q.stderr.decode()[:80]
    return os.path.getsize(dst), None


ENGINE = os.path.join(HERE, "docs", "js", "rosewood-order-engine.js")


def sync_engine():
    """엔진 SPRITE_CODES 를 docs/img/items 실측으로 교체. 목록과 개수 주석 둘 다."""
    codes = sorted(int(f[:-4]) for f in os.listdir(DST)
                   if f.endswith(".png") and f[:-4].isdigit())
    src = open(ENGINE, encoding="utf-8").read()
    line = "const SPRITE_CODES = new Set([%s]);" % ",".join(str(c) for c in codes)
    new = re.sub(r"const SPRITE_CODES = new Set\(\[[^\]]*\]\);", line, src, count=1)
    new = re.sub(r"   \d+종 중 \d+장이 왔다 — 아직 없는 \d+:[^\n]*\n",
                 "   폴더 실측 %d장(scripts/items2web.py 가 이 목록을 쓴다).\n" % len(codes),
                 new, count=1)
    if new != src:
        open(ENGINE, "w", encoding="utf-8").write(new)
    return len(codes)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    do_all = "--all" in sys.argv
    have = {f[:-4] for f in os.listdir(DST) if f.endswith(".png")}
    src = sorted(f[:-4] for f in os.listdir(SRC) if f.endswith(".png"))
    if args:
        todo = args
    elif do_all:
        todo = src
    else:
        todo = [c for c in src if c not in have]
    if not todo:
        print(f"변환할 것 없음 — 허브 {len(have)}장 · 클라 {len(src)}장")
        print(f"   엔진 SPRITE_CODES {sync_engine()}종 동기화")
        return
    ok = 0
    for code in todo:
        size, err = convert(code)
        if err:
            print(f"   FAIL {code}: {err}")
            continue
        ok += 1
        print(f"   {code}.png  {size / 1024:.1f} KB")
    total = len([f for f in os.listdir(DST) if f.endswith(".png")])
    print(f"→ {ok}/{len(todo)} 변환 · 허브 총 {total}장 · 엔진 SPRITE_CODES {sync_engine()}종")


if __name__ == "__main__":
    main()
