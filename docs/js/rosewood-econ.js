/* ============================================================================
   rosewood-econ.js — 계정 축(레벨 · 경험치 · 코인 · 젬 · 심부름 · 보상 보관함 · 오더 레일).

   DOM 을 만지지 않는다. 판정·지급은 클라 규칙을 그대로 옮겼고, 옮긴 함수마다
   원본 `파일:줄` 을 위에 적었다. 클라 경로 기준은 story-merge-proto-client/assets/script/game/.

   클라와 **다르게** 한 것은 승인된 셋뿐이다(_ignore/plan-rosewood-autoplay.md §0).
     D1  그날 심부름을 다 하면 자동으로 다음 날 (lastDay = main_task 최대 day 까지)
     D2  심부름 비용 = 시트 `cost_coin`. 클라의 `const cost = 1; // TEST` 는 옮기지 않는다
     D3  레벨업 때 `level_curve.reward_item_key_1~3` 을 지급한다 → 보상 보관함
   오더 추첨은 허브 엔진(`rosewood-order-engine.js`)의 `generateOrder` 를 그대로 부른다(D5 A안).
   엔진은 고치지 않는다 — 엔진 타이머가 읽는 `Date.now()` 만 호출 동안 가상 시계로 바꿔 끼운다.

   엔진이 top-level `let/const`(S · DATA · COLS · $ …)를 선언하므로 이 파일은 반드시 IIFE 다.
   ========================================================================== */
(function () {
  "use strict";

  var SLOTS = 6;                                   // const.rail_visible_max
  var SPECIAL_SLOT = 6;                            // 클라 미구현 — 늘 잠김
  var REWARD_SLOTS = 3;                            // popup/PopupChore.ts:33
  var RNG_SEED = 20260910;                         // 엔진 RNG 초기값과 같다

  var KEY_COIN = "currency_coin", KEY_GEM = "currency_gem",
      KEY_ENERGY = "currency_energy", KEY_EXP = "currency_exp";   // player/RewardGrant.ts:34-37
  var KIND_OF = {};
  KIND_OF[KEY_COIN] = "coin"; KIND_OF[KEY_GEM] = "gem";
  KIND_OF[KEY_ENERGY] = "energy"; KIND_OF[KEY_EXP] = "exp";

  var BAL = null, C = {};
  var TASKS = [], BY_DAY = new Map(), LAST_DAY = 0;
  var REWARD = new Map(), LEVEL = new Map(), OITEM = new Map(), SPEC = new Map();

  function engineReady() { return typeof generateOrder === "function" && typeof freshState === "function"; }

  /* data/BalanceTypes.ts:29-43 — 빈 칸은 null · "" · "none" 전부다. */
  function isEmpty(v) { return v == null || v === "" || v === "none"; }
  function sheetText(v) { return isEmpty(v) ? "" : String(v); }
  function sheetNumber(v) {
    if (isEmpty(v)) return 0;
    var n = typeof v === "number" ? v : Number(v);
    return isFinite(n) ? n : 0;
  }

  /* ── 초기화 ─────────────────────────────────────────────────────────── */
  function init(bal) {
    BAL = bal;
    C = bal.const || {};
    TASKS = (bal.main_task || []).filter(function (t) { return t.in_use !== false; })
      .slice().sort(function (a, b) { return a.day - b.day || a.task_seq - b.task_seq; });
    BY_DAY = new Map(); LAST_DAY = 0;
    TASKS.forEach(function (t) {
      if (!BY_DAY.has(t.day)) BY_DAY.set(t.day, []);
      BY_DAY.get(t.day).push(t);
      if (t.day > LAST_DAY) LAST_DAY = t.day;
    });
    REWARD = new Map((bal.reward_key || []).filter(function (r) { return r.in_use !== false; })
      .map(function (r) { return [r.reward_key, r]; }));
    LEVEL = new Map((bal.level_curve || []).map(function (r) { return [r.level, r]; }));
    OITEM = new Map((bal.order_item || []).map(function (r) { return [r.item_code, r]; }));
    SPEC = new Map((bal.item_spec || []).map(function (r) { return [r.item_code, r]; }));

    if (!engineReady()) return;
    /* 엔진 DATA 를 이 판본(09-21)으로 통째로 갈아 끼운다 — 엔진이 읽는 탭만. */
    DATA = {
      const: C,
      item_spec: bal.item_spec || [],
      order_item: bal.order_item || [],
      order_rule: bal.order_rule || [],
      order_slot_band: bal.order_slot_band || [],
      order_item_count: bal.order_item_count || [],
      order_fixed: bal.order_fixed || [],
      order_avatar: bal.order_avatar || [],
      order_special: bal.order_special || [],
      event_order_score: bal.event_order_score || [],
      level_curve: bal.level_curve || [],
      inventory_unlock: [],
    };
    reindex();
    resetEngine();
  }

  /* 엔진 상태를 새 계정으로 — 레일 카드 · 고정 오더 순번 · 예산 타이머 · 반복 카운터 · 난수. */
  function resetEngine() {
    if (!engineReady()) return;
    RNG.load(RNG_SEED);
    S = freshState();
    S.orderGen.rng_state = RNG.save();
  }

  /* player/PlayerState.ts 의 NRU 시작값 = const.nru_* */
  function newAccount() {
    resetEngine();
    return {
      level: 1, exp: 0,
      coin: Number(C.nru_start_coin) || 0,
      gem: Number(C.nru_start_gem) || 0,
      day: 1, doneKeys: [], rewardBox: [],
      stats: { merges: 0, energySpent: 0, orders: 0, chores: 0, recharges: 0, sells: 0, collects: 0,
               gemRecharges: 0, gemSpent: 0, chestsEmptied: 0,
               chestOpens: 0, waitSec: 0 },
    };
  }

  /* ── 레벨 · 경험치 ──────────────────────────────────────────────────── */
  /* data/BalanceProvider.ts:123-131 — 그 레벨에서 다음 레벨까지. 없으면 0. */
  function expNeed(level) {
    var r = LEVEL.get(level);
    return r ? r.exp_cost : 0;
  }

  /* player/PlayerVM.ts:613-633 — while 루프. 비용이 0 이하면 곡선 끝이라 멈추고 경험치만 쌓는다.
     D3: 오를 때마다 **떠나는 레벨** 행의 reward_item_key_1~3 을 지급한다
     (「지나친 각 레벨의 아이템 보상 행」 — 클라 _ignore/plan-wallet-energy.md). */
  function addExp(acc, amount) {
    var ups = [];
    if (amount <= 0) return ups;
    acc.exp += amount;
    var passed = [];
    for (;;) {
      var cost = expNeed(acc.level);
      if (cost <= 0) break;
      if (acc.exp < cost) break;
      acc.exp -= cost;
      passed.push(acc.level);
      acc.level++;
    }
    passed.forEach(function (from) {
      var up = { from: from, to: from + 1, rewards: [] };
      ups.push(up);
      readRewardSlots(LEVEL.get(from), REWARD_SLOTS).forEach(function (e) {
        var g = grant(acc, e.key, e.amount);
        if (!g) return;
        up.rewards.push(stripUps(g));
        if (g.levelUps) ups.push.apply(ups, g.levelUps);   // 보상이 경험치면 연쇄 레벨업
      });
    });
    return ups;
  }

  function stripUps(g) {
    var o = { kind: g.kind, amount: g.amount };
    if (g.code != null) o.code = g.code;
    return o;
  }

  /* ── 보상 ──────────────────────────────────────────────────────────── */
  /* player/RewardGrant.ts:66-80 — 빈 칸("none")과 수량 0 이하는 뺀다. */
  function readRewardSlots(row, count) {
    var out = [];
    if (row == null) return out;
    for (var i = 1; i <= count; i++) {
      var key = sheetText(row["reward_item_key_" + i]);
      if (key === "") continue;
      var amount = sheetNumber(row["reward_amount_" + i]);
      if (amount <= 0) continue;
      out.push({ key: key, amount: amount });
    }
    return out;
  }

  /* player/RewardGrant.ts:52-54 — item_code 0 은 「머지 아이템이 아님」이다. */
  function isItemReward(row) { return row != null && row.item_code > 0; }

  /* player/RewardGrant.ts:92-111 — 대가를 치르기 전에 해석 안 되는 키를 골라낸다. */
  function unresolvedRewards(entries) {
    var bad = [];
    entries.forEach(function (e) {
      if (isEmpty(e.key) || e.amount <= 0) return;
      var row = REWARD.get(e.key);
      if (row == null) { bad.push(e.key); return; }
      if (!Object.prototype.hasOwnProperty.call(KIND_OF, e.key) && !isItemReward(row)) bad.push(e.key);
    });
    return bad;
  }

  /* player/RewardGrant.ts:125-190 (grantRewards · payOne) — 재화는 계정으로, 머지 아이템은
     보상 보관함 대기열(PlayerVM.ts:477 pushReward)로 amount 개. 에너지는 계정 밖(보드)이라
     `{kind:"energy"}` 로 돌려주고 호출부가 더한다. */
  function grant(acc, rewardKey, amount) {
    if (isEmpty(rewardKey) || amount <= 0) return null;
    var row = REWARD.get(rewardKey);
    if (row == null) return null;
    var kind = Object.prototype.hasOwnProperty.call(KIND_OF, rewardKey) ? KIND_OF[rewardKey] : null;
    if (kind === "coin") { acc.coin += amount; return { kind: kind, amount: amount }; }
    if (kind === "gem") { acc.gem += amount; return { kind: kind, amount: amount }; }
    if (kind === "energy") return { kind: kind, amount: amount };
    if (kind === "exp") return { kind: kind, amount: amount, levelUps: addExp(acc, amount) };
    if (isItemReward(row)) {
      for (var i = 0; i < amount; i++) acc.rewardBox.push(row.item_code);
      return { kind: "item", code: row.item_code, amount: amount };
    }
    return null;
  }

  /* 표시용 — 지급하지 않고 모양만 편다. */
  function rewardsOf(row) {
    return readRewardSlots(row, REWARD_SLOTS).map(function (e) {
      var r = REWARD.get(e.key);
      if (Object.prototype.hasOwnProperty.call(KIND_OF, e.key)) return { kind: KIND_OF[e.key], amount: e.amount };
      if (isItemReward(r)) return { kind: "item", code: r.item_code, amount: e.amount };
      return { kind: "unknown", key: e.key, amount: e.amount };
    });
  }

  /* ── 심부름 ────────────────────────────────────────────────────────── */
  /* player/ChoreRules.ts:21-23 — 완료 기록 키 "{day}:{taskSeq}" */
  function choreKey(day, seq) { return day + ":" + seq; }

  function dayRows(day) { return BY_DAY.get(day) || []; }
  function lastDay() { return LAST_DAY; }
  function choreTotal() { return TASKS.length; }

  function dayDone(acc, day) {
    var done = new Set(acc.doneKeys), n = 0;
    dayRows(day).forEach(function (t) { if (done.has(choreKey(t.day, t.task_seq))) n++; });
    return n;
  }

  /* player/ChoreRules.ts:94-123 — 그날 목록에서 첫 미완료 건. */
  function nextChore(acc) {
    var done = new Set(acc.doneKeys);
    var rows = dayRows(acc.day);
    for (var i = 0; i < rows.length; i++) {
      if (!done.has(choreKey(rows[i].day, rows[i].task_seq))) return rows[i];
    }
    return null;
  }

  /* player/ChoreRules.ts:131-146 — 「없다 → 이미 했다 → 돈이 없다」 순서.
     D2: 비용은 시트 cost_coin 이다(클라 142줄의 TEST 1코인이 아니다). */
  function choreCheck(acc) {
    var row = nextChore(acc);
    if (row == null) return { ok: false, reason: "AllCleared", row: null, cost: 0 };
    var cost = Number(row.cost_coin) || 0;
    if (acc.coin < cost) return { ok: false, reason: "CoinShort", row: row, cost: cost, need: cost - acc.coin };
    if (unresolvedRewards(readRewardSlots(row, REWARD_SLOTS)).length)   // popup/PopupChore.ts:555-561
      return { ok: false, reason: "Ungrantable", row: row, cost: cost };
    return { ok: true, reason: "Ok", row: row, cost: cost };
  }

  /* popup/PopupChore.ts:549-588 — 판정 → 지급 가능 확인 → 코인 차감(PlayerVM.ts:426 startChore)
     → 보상 지급(584) → 완료 기록(588 · PlayerVM.ts:452 completeChore). 그날이 끝났으면 D1 로 다음 날. */
  function doChore(acc) {
    var chk = choreCheck(acc);
    if (!chk.ok) return { ok: false, reason: chk.reason, row: chk.row, spent: 0, grants: [], levelUps: [], dayAdvanced: false, day: acc.day };
    var row = chk.row, cost = chk.cost;
    acc.coin -= cost;                              // PlayerVM.ts:539-546 spendCoin
    var grants = [], levelUps = [];
    readRewardSlots(row, REWARD_SLOTS).forEach(function (e) {
      var g = grant(acc, e.key, e.amount);
      if (!g) return;
      grants.push(stripUps(g));
      if (g.levelUps) levelUps.push.apply(levelUps, g.levelUps);
    });
    var key = choreKey(row.day, row.task_seq);
    if (acc.doneKeys.indexOf(key) < 0) acc.doneKeys.push(key);
    acc.stats.chores++;
    var advanced = false;
    if (nextChore(acc) == null && acc.day < LAST_DAY) { acc.day++; advanced = true; }   // D1
    if (engineReady()) S.day = acc.day;
    return { ok: true, row: row, spent: cost, grants: grants, levelUps: levelUps, dayAdvanced: advanced, day: acc.day };
  }

  /* ── 오더 — 판정 · 보상 ────────────────────────────────────────────── */
  function reqCodes(card) {
    var out = [];
    (card && card.reqs || []).forEach(function (q) {
      for (var i = 0; i < (q.count || 1); i++) out.push(q.code);
    });
    return out;
  }

  function countOf(counts, code) {
    if (!counts) return 0;
    var n = typeof counts.get === "function" ? counts.get(code) : counts[code];   // 다른 realm 의 Map 도 받는다
    return n != null ? n : 0;
  }

  /* ingame/rules/OrderRules.ts:179-213 (serveCheck · slotNeedAt 155 · needByCode 131) —
     칸 i 는 0..i 구간의 누적 개수로 판정한다. 같은 코드 두 칸이면 2개가 있어야 한다(O1). */
  function serveCheck(card, boardCounts) {
    var req = reqCodes(card);
    var short = new Map();
    if (!req.length) return { ok: false, reason: "NoRequirement", consume: [], short: short, have: [] };
    if (req.length > 2) return { ok: false, reason: "OverSlotMax", consume: [], short: short, have: [] };   // SPEC_REQ_SLOT_MAX
    var seen = new Map(), have = [];
    req.forEach(function (code) {
      var nth = (seen.get(code) || 0) + 1;
      seen.set(code, nth);
      have.push(countOf(boardCounts, code) >= nth);
    });
    seen.forEach(function (need, code) {
      var lack = need - countOf(boardCounts, code);
      if (lack > 0) short.set(code, lack);
    });
    return { ok: short.size === 0, reason: short.size ? "ItemShort" : "Ok", consume: req.slice(), short: short, have: have };
  }

  /* ingame/rules/OrderRules.ts:221-232 — 같은 코드 두 칸이면 두 번 합산 · exp 는 늘 0(O2). */
  function serveReward(card) {
    var coin = 0, diff = 0;
    reqCodes(card).forEach(function (code) {
      var r = OITEM.get(code);
      if (r == null) return;
      coin += r.order_price || 0;
      diff += r.diff_score || 0;
    });
    return { coin: coin, diff: diff, exp: 0 };
  }

  /* ── 오더 — 레일 ──────────────────────────────────────────────────── */
  function makeRail() {
    var rail = [];
    for (var n = 1; n <= SLOTS; n++) {
      rail.push({ slot: n, type: engineReady() ? slotType(n) : "normal", card: null,
                  unlockLevel: engineReady() ? slotNeed(n) : 1 });
    }
    return rail;
  }

  /* 칸 타입·해금 레벨은 엔진이 정한다(slotType · slotNeed — 고정 오더가 노리는 칸은 그 최저 레벨부터 열린다).
     호출부가 다른 값을 들고 와도 여기서 엔진 값으로 맞춘다. */
  function normalizeSlot(s) {
    if (!engineReady()) return s;
    s.type = slotType(s.slot);
    s.unlockLevel = slotNeed(s.slot);
    return s;
  }

  function slotOpen(acc, s) { return s.slot !== SPECIAL_SLOT && acc.level >= s.unlockLevel; }

  /* 엔진 S 를 레일에 맞춘다 — pickAvatar · otherOrderCount · refillBase · requiredElsewhere 가
     S.slots · S.day · S.level 을 읽는다. */
  function syncEngine(acc, rail) {
    S.level = acc.level;
    S.day = acc.day;
    S.slots = {};
    rail.forEach(function (s) { S.slots[s.slot] = s.card || null; });
  }

  /* 엔진 타이머는 Date.now()/1000 을 읽는다 — 호출 동안만 가상 시계로 대체한다. */
  function withClock(nowSec, fn) {
    var real = Date.now;
    Date.now = function () { return nowSec * 1000; };
    try { return fn(); } finally { Date.now = real; }
  }

  /* 빈 칸만 채운다(O3). 슬롯 번호순 — 앞 카드를 확정한 다음 뒤 슬롯의 othersReq 를 다시 센다
     (허브 rosewood-model.js:136-145 fillEmptySlots 와 같은 순서). counts = 보드만(정본 §6② —
     보상 보관함 제외). 반환: 새로 뜬 카드 목록. */
  function fillRail(acc, rail, boardCounts, nowSec) {
    var made = [];
    if (!engineReady()) return made;
    syncEngine(acc, rail);
    var counts = boardCounts && typeof boardCounts.get === "function" ? new Map(boardCounts) : new Map(Object.keys(boardCounts || {})
      .map(function (k) { return [Number(k), boardCounts[k]]; }));
    rail.forEach(normalizeSlot);
    rail.forEach(function (s) {
      if (s.card || !slotOpen(acc, s)) return;
      var others = new Set(), qty = new Map();
      rail.forEach(function (o) {
        if (o.slot === s.slot || !o.card) return;
        reqCodes(o.card).forEach(function (c) { others.add(c); qty.set(c, (qty.get(c) || 0) + 1); });
      });
      var r = withClock(nowSec, function () {
        return generateOrder(s.slot, { level: acc.level, counts: counts, othersReq: others, reqQty: qty,
                                       prev: S.prevOfSlot[s.slot] || null });
      });
      if (!r.card) return;
      s.card = r.card;
      S.slots[s.slot] = r.card;
      made.push(r.card);
    });
    return made;
  }

  /* 납품 뒤 레일 정리 — 허브 rosewood-model.js:153-165 commitServe 와 같은 축.
     코인 지급 · 직전 요구(prevOfSlot) 기록 · 반복 감쇠 설정(OrderRules.ts:480-495
     repeatSetOnServe = 엔진 RepeatDecay.onServe) · 칸 비우기. 보드에서 빼는 건 호출부 몫이다. */
  function onServed(acc, rail, slotNo) {
    var s = rail[slotNo - 1];
    if (!s || !s.card) return null;
    var card = s.card, reward = serveReward(card), codes = reqCodes(card);
    if (reward.coin > 0) acc.coin += reward.coin;
    acc.stats.orders++;
    if (engineReady()) {
      S.prevOfSlot[slotNo] = codes;
      RepeatDecay.onServe(S.orderGen.chain_repeat, codes, RepeatDecay.resetOf(DATA.const));
      S.slots[slotNo] = null;
    }
    s.card = null;
    return { card: card, reward: reward, consume: codes };
  }

  /* 비어 있는 열린 칸의 타입 중 예산 대기가 끝난 것이 있나 / 가장 이른 대기 종료 시각. */
  function railTimers(acc, rail) {
    var out = [];
    if (!engineReady()) return out;
    var seen = {};
    rail.forEach(function (s) {
      if (s.card || !slotOpen(acc, s) || seen[s.type]) return;
      seen[s.type] = 1;
      var t = S.orderGen.type_timers[s.type];
      if (t && t.next_refill_at > 0) out.push({ type: s.type, at: t.next_refill_at });
    });
    return out;
  }
  function railDue(acc, rail, nowSec) {
    return railTimers(acc, rail).some(function (t) { return nowSec >= t.at; });
  }
  function railNextAt(acc, rail) {
    var ts = railTimers(acc, rail);
    if (!ts.length) return 0;
    return Math.min.apply(null, ts.map(function (t) { return t.at; }));
  }

  /* ── 수확(collect) ─────────────────────────────────────────────────── */
  /* 탭하면 칸을 비우고 재화를 준다 — item_spec.collect_reward_key / collect_reward_amount.
     ⚠ **정본 데이터 열이지만 클라에는 아직 구현이 없다**(data/BalanceTypes.ts:70-84 에 열 정의만 있다 ·
     정본 v1.6 「누락된 코인·젬·에너지 수확 보상 복원」). 실측 14행(2701~2705 · 2801~2804 · 2901~2905),
     전부 selling_price -1 이라 판매로는 못 치운다. 지급은 grant() 한 길로 — 재화 해석이 두 벌이 되지 않게. */
  function collectOf(code) {
    var r = SPEC.get(Number(code));
    if (!r) return null;
    var key = sheetText(r.collect_reward_key), amount = sheetNumber(r.collect_reward_amount);
    if (key === "" || amount <= 0 || !REWARD.has(key)) return null;
    return { key: key, amount: amount };
  }

  /* 수확 한 건 — 지급과 기록을 한 번에(정본: 재화 지급과 아이템 제거는 한 거래). 칸 비우기는 호출부 몫. */
  function collect(acc, code) {
    var c = collectOf(code);
    if (!c) return null;
    var g = grant(acc, c.key, c.amount);
    if (!g) return null;
    acc.stats.collects = (acc.stats.collects || 0) + 1;
    return stripUps(g);
  }

  /* ── 조회 ─────────────────────────────────────────────────────────── */
  function spec(code) { return SPEC.get(Number(code)) || null; }
  function orderItem(code) { return OITEM.get(Number(code)) || null; }

  window.RwEcon = {
    init: init,
    newAccount: newAccount,
    expNeed: expNeed,
    nextChore: nextChore,
    dayRows: dayRows,
    dayDone: dayDone,
    lastDay: lastDay,
    choreTotal: choreTotal,
    choreCheck: choreCheck,
    doChore: doChore,
    addExp: addExp,
    grant: grant,
    rewardsOf: rewardsOf,
    collectOf: collectOf,
    collect: collect,
    serveCheck: serveCheck,
    serveReward: serveReward,
    makeRail: makeRail,
    slotOpen: slotOpen,
    fillRail: fillRail,
    onServed: onServed,
    railDue: railDue,
    railNextAt: railNextAt,
    reqCodes: reqCodes,
    spec: spec,
    orderItem: orderItem,
    SPECIAL_SLOT: SPECIAL_SLOT,
  };
})();
