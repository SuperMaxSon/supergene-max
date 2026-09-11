/* ==========================================================================
   Rosewood 코어루프 시뮬레이터 — 모델 / 뷰모델
   --------------------------------------------------------------------------
   실제 클라 대응: MVVM 의 ViewModel. 상태(Model)를 감싸고 **변경 API 와 변경 알림**만
   밖에 낸다.

   이 파일이 지키는 계약
     · **뷰는 상태를 직접 안 고친다.** `S.cells[i] = ...` 는 여기 안에서만 일어난다.
       뷰가 하는 일은 `Model.place(i, code)` 처럼 부르는 것뿐이다.
     · 변경마다 범위를 붙여 알린다 — `board` / `stats` / `rail` / `inv` / `all`.
       구독자(뷰)가 그 범위만 다시 그린다. Cocos 로 가면 이 자리가
       ViewModel 의 이벤트(EventTarget / 옵저버)가 된다.
     · 규칙 판정은 여기서 하지 않는다 — `Rules` 가 판정하고, 모델은 **적용**만 한다.
     · 연출도 하지 않는다 — 뷰가 알림을 받아 연출을 얹는다.

   의존: rosewood-order-engine.js (S · DATA · specOf · lvOf · generateOrder · openSlots)
        rosewood-rules.js (Rules)
   ========================================================================== */
"use strict";

const Model = (() => {
  const subs = [];

  /* 구독 — 뷰가 「어느 범위가 바뀌었나」를 받아 그 부분만 다시 그린다 */
  function subscribe(fn) { subs.push(fn); return fn; }
  function changed(scope) { for (const fn of subs) fn(scope || "all"); }

  /* ── 저장 ────────────────────────────────────────────────────────────
     localStorage 는 막혀 있을 수 있어(시크릿 · 사이트 데이터 차단) 전부 try 로 감싼다.
     저장 실패는 조용히 넘어가고 페이지는 그대로 돈다.
     시트 실물이 들어오면서 DATA 가 120KB 를 넘는다 — 한 글자도 안 고쳤으면 싣지 않고,
     불러올 때 DEFAULTS() 로 다시 만든다.                                        */
  let saveTimer = 0;
  let cache = { ref: null, json: "" };

  function saveNow() {
    try {
      const st = {
        cells: S.cells, level: S.level, exp: S.exp, coin: S.coin, energy: S.energy,
        day: S.day, choreSeq: S.choreSeq, sel: S.sel, orderGen: S.orderGen, orderFree: S.orderFree,
        gem: S.gem, debug: S.debug, serveCount: S.serveCount, energyLastAt: S.energyLastAt,
        boost: S.boost, out: S.out, inv: S.inv, outFold: S.outFold,
        slots: S.slots, prevOfSlot: S.prevOfSlot,
        log: S.log.slice(0, 20).map((e) => ({ ...e, t: e.t.toISOString() })),
      };
      if (DATA !== cache.ref) cache = { ref: DATA, json: JSON.stringify(DATA) };
      localStorage.setItem(SAVE_KEY,
        `{"v":${SAVE_VER},"at":${Date.now()},"data":${Model.dataEdited ? cache.json : "null"},`
        + `"fx":${JSON.stringify(FX)},"state":${JSON.stringify(st)}}`);
      const d = new Date();
      const hh = (x) => String(x).padStart(2, "0");
      const el = $("#rwSaved"); if (el) el.textContent = `저장 ${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())}`;
    } catch (e) {
      const el = $("#rwSaved"); if (el) el.textContent = "저장 불가";
    }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // 쓰기는 26KB 동기 작업이다 — 한가할 때로 미룬다
      if (window.requestIdleCallback) requestIdleCallback(saveNow, { timeout: 2000 });
      else saveNow();
    }, 900);
  }

  /* ── 보드 ──────────────────────────────────────────────────────────── */
  const cellAt = (i) => S.cells[i];
  function place(i, cell) { S.cells[i] = typeof cell === "number" ? { code: cell } : cell; changed("board"); }
  function clear(i) { S.cells[i] = null; if (S.sel === i) S.sel = null; changed("board"); }
  function move(from, to) { S.cells[to] = S.cells[from]; S.cells[from] = null; if (S.sel === from) S.sel = null; changed("board"); }
  function select(i) { S.sel = i; changed("sel"); }

  /* 생산 — 판정은 Rules.produceCheck 가 이미 했다. 여기서는 대가를 치르고 결과를 놓는다.
     연출이 중간에 끼기 때문에 「소모」와 「배치」가 두 번에 나뉜다. */
  function payProduce(i, plan) {
    const cell = S.cells[i];
    cell.stock -= plan.mult;
    if (cell.stock <= 0) { cell.stock = 0; cell.lastAt = Date.now() / 1000; }
    S.energy -= plan.cost;
    changed("board");
  }

  /* ── 재화 ──────────────────────────────────────────────────────────── */
  function addCoin(n) { S.coin += n; changed("stats"); }
  function addGem(n) { S.gem += n; changed("stats"); }
  function addEnergy(n) { S.energy += n; changed("stats"); }

  /* 경험치 — 레벨업 판정은 Rules.levelGain. 오른 만큼 오더 슬롯이 열린다. */
  function gainExp(exp, coin) {
    const g = Rules.levelGain(S.level, S.exp, exp, lvOf, 30);
    S.level = g.level; S.exp = g.exp;
    S.coin += coin + g.coin;
    changed("stats");
    return g;
  }

  /* ── 보상함 ──────────────────────────────────────────────────────────
     「보드로 못 받는 보상」이 여기로 간다 — 보드가 꽉 찼거나, 애초에 보드 밖에서
     주어지는 보상. 화면 기획서 §8 보상 지급 3분기의 세 번째 갈래다. */
  function toBox(code, why) {
    S.inv.box = S.inv.box || [];
    S.inv.box.push(code);
    changed("inv");
    return why || "board_full";
  }
  /* 아이템 보상 지급 — 보드에 자리가 있으면 보드로, 없으면 보상함으로.
     돌려주는 값이 「어디로 갔는지」라 뷰가 그에 맞는 연출을 고른다. */
  let spiral = null;
  const spiralOrder = () => (spiral ||= Rules.spiralOrder(COLS, ROWS));
  function grantItem(code, nearIdx) {
    const at = nearIdx == null
      ? spiralOrder().find((i) => !S.cells[i]) ?? -1
      : Rules.spiralEmpty(S.cells, nearIdx, COLS, ROWS);
    if (at < 0) return { where: "box", code, why: toBox(code) };
    S.cells[at] = { code };
    changed("board");
    return { where: "board", code, at };
  }

  /* ── 창고 ──────────────────────────────────────────────────────────── */
  function stash(i) { const c = S.cells[i]; S.inv.store.push(c.code); clear(i); changed("inv"); }
  function unstash(kind, idx, dest) {
    const code = S.inv[kind][idx];
    S.inv[kind].splice(idx, 1);
    S.cells[dest] = { code };
    changed("board"); changed("inv");
    return code;
  }
  function buySlot(cost) { S.gem -= cost; S.inv.bought = (S.inv.bought || 0) + 1; changed("inv"); changed("stats"); }


  /* ── 슬롯 채우기 ──────────────────────────────────────────────────────
     번호순으로 돈다. 앞 카드를 확정한 다음 뒤 슬롯의 후보를 다시 계산해야
     「같은 요구가 두 슬롯에 겹치는」 일이 안 생긴다(기획서 1.2.1 [2]).
     발급 로그는 40건까지만 들고 있는다 — 디버그 표가 읽는다. */
  function fillEmptySlots(reason) {
    for (const n of openSlots()) {
      if (S.slots[n]) continue;
      const r = generateOrder(n);
      S.log.unshift({ slot: n, type: r.card ? r.card.type : slotType(n), ok: !!r.card, reason, lines: r.log, t: new Date() });
      if (r.card) S.slots[n] = r.card;
    }
    S.log = S.log.slice(0, 40);
    changed("rail");
  }

  /* ── 오더 ────────────────────────────────────────────────────────────
     납품 확정 — 코인과 직전 요구품을 갈무리하고 다음 카드를 발급한다.
     `prevOfSlot` 은 다음 추첨의 **후보 제외** 목록이다(제외 단위는 아이템 코드).
     반복 감쇠 카운터는 엔진이 체인 단위로 따로 들고 있다 — 여기서 만지지 않는다.
     하루 누적 난이도 축은 신판 시트에서 폐기됐다(`order_slot_band` 는 종류+레벨 두 축). */
  function commitServe(n, card, reason) {
    S.coin += card.coin;
    S.serveCount = (S.serveCount || 0) + 1;
    const reqCodes = card.reqs.map((q) => q.code);
    S.prevOfSlot[n] = reqCodes;
    /* 반복 감쇠 카운터가 **켜지는** 자리다 — 발급 쪽(RepeatDecay.commit)은 이미 걸린 체인만
       손대므로, 납품에서 걸어 주지 않으면 표가 영원히 비어 감쇠가 한 번도 작동하지 않는다.
       카드를 비우기 전에 부른다 — fillEmptySlots 가 곧바로 다음 카드를 뽑는데,
       그 추첨이 방금 납품한 체인의 눌린 비중을 봐야 한다. */
    /* 세이브를 거쳐 온 상태에는 이 칸이 없을 수 있다 — 없으면 만들고 넘긴다(엔진이 표를 직접 쓴다) */
    S.orderGen.chain_repeat ||= {};
    RepeatDecay.onServe(S.orderGen.chain_repeat, reqCodes, RepeatDecay.resetOf(DATA.const));
    S.slots[n] = null;
    fillEmptySlots(reason);
    changed("all");
  }
  function dropOrder(n, reason) {
    S.slots[n] = null;
    fillEmptySlots(reason);
    changed("rail");
  }

  return {
    dataEdited: false,
    subscribe, changed, save, saveNow,
    cellAt, place, clear, move, select, payProduce,
    addCoin, addGem, addEnergy, gainExp,
    spiralOrder,
    toBox, grantItem,
    stash, unstash, buySlot,
    commitServe, dropOrder, fillEmptySlots,
  };
})();
