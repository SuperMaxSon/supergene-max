#!/usr/bin/env python3
"""docs/data/rosewood-balance.json → 오더 엔진 내장 데이터 블록 갱신.

벤치(rosewood-order-bench.html)는 파일을 안 읽고 엔진에 박힌 `*_DB` 상수로 돈다.
드로우(rosewood-order-draw.html)는 balance.json 을 읽는다. 둘이 갈리면 「같은 코드를
검증한다」는 전제가 깨지므로, 시트가 바뀌면 이 스크립트로 블록을 통째로 갈아끼운다.

CHAIN_DB 의 클러스터·색·line_type 은 시트에 없는 우리 편성값이라 기존 행을 보존하고
데이터에 새로 생긴 체인만 뒤에 붙인다. INV_DB(inventory_unlock)는 추출 대상이 아니라 손대지 않는다.

사용:  python3 scripts/balance2engine.py
"""
import json
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAL = os.path.join(HERE, "docs", "data", "rosewood-balance.json")
ENG = os.path.join(HERE, "docs", "js", "rosewood-order-engine.js")


def js(v):
    if v is None:
        return "0"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool):
        return "1" if v else "0"
    return str(v)


def rows(items):
    return "\n".join("  [" + ",".join(js(c) for c in r) + "]," for r in items)


def splice(src, name, body, header=None):
    """`const NAME = [` … `\n];` 를 통째로 교체. header 를 주면 바로 위 주석도 바꾼다."""
    open_re = re.compile(r"(?m)^const %s = \[\n" % re.escape(name))
    m = open_re.search(src)
    if not m:
        raise SystemExit(f"블록 없음: {name}")
    # 닫는 줄은 「줄 맨 앞의 ];」다. 빈 블록이면 그게 여는 줄 바로 다음이라
    # "\n];" 로 찾으면 다음 블록의 닫는 줄까지 삼킨다 — 그 사고를 한 번 냈다.
    close = re.compile(r"(?m)^\];").search(src, m.end())
    if not close:
        raise SystemExit(f"블록 끝을 못 찾음: {name}")
    new = src[:m.start()] + f"const {name} = [\n" + (body + "\n" if body else "") + src[close.start():]
    if header is not None:
        # 블록 바로 앞 주석 한 줄(또는 여러 줄) 교체 — `/* … */` 한 덩어리만 본다
        i = new.index(f"const {name} = [")
        pre = new[:i]
        j = pre.rfind("/*")
        if j != -1 and pre[j:].rstrip().endswith("*/"):
            new = new[:j] + header + "\n" + new[i:]
    return new


def main():
    d = json.load(open(BAL, encoding="utf-8"))
    src = open(ENG, encoding="utf-8").read()

    # ── CHAIN_DB — 기존 편성값 보존 + 신규 체인만 추가
    cur = {}
    body = src[src.index("const CHAIN_DB = ["):]
    for cid, key, name, cl, sq, ln in re.findall(
            r"\[(\d+),\"([^\"]*)\",\"([^\"]*)\",(\d+),(\d+),\"([^\"]*)\"\]", body[:body.index("\n];")]):
        cur[int(cid)] = [int(cid), key, name, int(cl), int(sq), ln]
    have = {r["chain_id"] for r in d["item_spec"]}
    added = []
    for cid in sorted(have - set(cur)):
        first = min((r for r in d["item_spec"] if r["chain_id"] == cid), key=lambda r: r["step"])
        nm = first.get("name_ko") or first.get("name_en") or f"체인 {cid}"
        cur[cid] = [cid, f"X_CH{cid}", nm, 9, 5, "res"]
        added.append(cid)
    chain_key = {c[0]: c[1] for c in cur.values()}
    src = splice(src, "CHAIN_DB", rows([cur[k] for k in sorted(cur)]))

    # ── ITEM_DB
    items = []
    for r in sorted(d["item_spec"], key=lambda r: r["item_code"]):
        prod = []
        for i in range(1, 21):
            c = r.get(f"produce_item_{i}")
            if isinstance(c, int) and c:
                prod.append([c, r.get(f"produce_weight_{i}") or 0])
        merged = r["merged_item_code"]
        items.append([
            r["item_code"], merged if isinstance(merged, int) else 0,
            r.get("selling_price") or 0, r.get("show_sell_confirm") or 0,
            r.get("is_generator") or 0,
            r.get("name_ko") or "", r.get("name_en") or "",
            chain_key.get(r["chain_id"], "?"),
            r.get("spread_item_max") or 0, r.get("spread_cost_energy") or 0,
            r.get("spread_item_recovery_sec") or 0,
        ])
        items[-1].append("[" + ",".join("[%d,%d]" % (a, b) for a, b in prod) + "]")
    body = "\n".join(
        "  [" + ",".join(js(c) for c in r[:-1]) + "," + r[-1] + "]," for r in items)
    src = splice(src, "ITEM_DB", body)

    # ── ORDER_DB — A5 계약 컬럼. weight·weight_multiple 은 계약에 없다
    src = splice(src, "ORDER_DB", rows([
        [r["item_code"], r["unlock_level"], r["order_price"], r["diff_score"],
         r.get("weight") if r.get("weight") is not None else 100,
         r.get("weight_multiple") if r.get("weight_multiple") is not None else 1,
         r.get("repeat_weight_decrease") or 0]
        for r in d["order_item"]]),
        "/* [item_code, unlock_level, order_price, diff_score, weight, weight_multiple, repeat_weight_decrease]\n"
        "   weight  = 기본 추첨 비중 (현재 604 꽃무늬 찻잔만 0, 나머지 101행 100)\n"
        "   weight_multiple = <b>보드 상황 집계 대상 플래그</b>(1=포함)다. 곱하는 배수가 아니다 — 30행이 0.\n"
        "   한때 「A5 계약에 없다」고 빼 두었는데, 밸런스시트 v1.1(2026-09-11 12:14)이 둘 다\n"
        "   「데이터·명세 확정」으로 못 박았다. 빼 두면 벤치만 기본값으로 떨어져 두 페이지가 갈린다. */")

    src = splice(src, "RULE_DB", rows([
        [r["order_type"], r["slot_count"], r["item_slot_max"], r["refresh_sec"],
         r["unlock_level"], r["refill_max"]] for r in d["order_rule"]]),
        "/* [order_type, slot_count, item_slot_max, refresh_sec, unlock_level, refill_max] */")

    src = splice(src, "BAND_DB", rows([
        [r["order_type"], r["band_seq"], r["level_min"], r["level_max"],
         r["first_min"], r["first_max"], r["second_max"]] for r in d["order_slot_band"]]),
        "/* [order_type, band_seq, level_min, level_max, first_min, first_max, second_max]\n"
        "   둘째 자리는 하한이 없다. diff_sum_*·third_* 는 신판에서 삭제된 열이다 */")

    src = splice(src, "COUNT_DB", rows([
        [r["level"], r["item_count"], r["count_weight"]] for r in d["order_item_count"]]),
        "/* [level, item_count, count_weight] — 종수는 1·2 뿐이다 */")

    src = splice(src, "FIXED_DB", rows([
        [r["fixed_seq"], r["unlock_level"], r["slot_1"], r["slot_2"],
         r["requirement_1"], r.get("requirement_2") or 0] for r in d["order_fixed"]]),
        "/* [fixed_seq, unlock_level, slot_1, slot_2, requirement_1, requirement_2]\n"
        "   slot_3 · requirement_3 은 신판에서 삭제됐다 */")

    src = splice(src, "AVATAR_DB", rows([
        [r["avatar_key"], r["open_day"]] for r in d["order_avatar"]]),
        "/* [avatar_key, open_day] — unlock_level 은 에디터 전용 열이 됐다.\n"
        "   신판에서 order_avatar 는 오더 타입이 아니라 「손님 초상 테이블」이다 */")

    # 이벤트 점수·특별주문 대본 — 예전엔 DEFAULTS 안에 임시값으로 박혀 있어서
    # 벤치와 「오더 추첨 분석」의 이벤트 점수가 갈렸다. 같은 표를 보게 한다.
    src = splice(src, "EVENT_DB", rows([
        [r["event_id"], r["band_seq"], r["score_base"], r["score_min"], r["score_max"],
         r["token_pct"], r["token_fix"]] for r in d["event_order_score"]]))

    src = splice(src, "SPECIAL_DB", rows([
        [r["special_no"], r["chain_key"], r["start_item_code"], r["avatar_key"],
         r["trigger_task"], r["duration_sec"], r["in_use"]] for r in d["order_special"]]))

    src = splice(src, "LEVEL_DB", rows([
        [r["level"], r["exp_cost"]] for r in d["level_curve"]]))

    # ── CONST_DB — 객체
    ob = "\n".join('  "%s": %s,' % (k, js(v)) for k, v in d["const"].items())
    ob = ob.rstrip(",")
    i = src.index("const CONST_DB = {")
    j = src.index("\n};", i)
    src = src[:i] + "const CONST_DB = {\n" + ob + src[j:]

    open(ENG, "w", encoding="utf-8").write(src)
    print(f"→ {ENG}")
    print(f"   CHAIN_DB {len(cur)}  (신규 {added or '없음'})")
    for k, t in (("ITEM_DB", "item_spec"), ("ORDER_DB", "order_item"), ("RULE_DB", "order_rule"),
                 ("BAND_DB", "order_slot_band"), ("COUNT_DB", "order_item_count"),
                 ("FIXED_DB", "order_fixed"), ("AVATAR_DB", "order_avatar"),
                 ("EVENT_DB", "event_order_score"), ("SPECIAL_DB", "order_special"),
                 ("LEVEL_DB", "level_curve")):
        print(f"   {k:10s} {len(d[t])}")
    print(f"   CONST_DB   {len(d['const'])}")


if __name__ == "__main__":
    main()
