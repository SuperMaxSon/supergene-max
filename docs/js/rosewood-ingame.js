/* ==========================================================================
   Rosewood 코어루프 시뮬레이터 — 인게임 뷰 (ViewGame)
   --------------------------------------------------------------------------
   실제 클라 대응: `game/ingame/ViewGame extends ViewBase` 한 덩이.
   보드 · 레일 · 정보바 · 인벤토리 · 드래그 입력 · 그 위에 얹는 연출까지.

   이 파일이 지키는 계약
     · 판정은 `Rules` 에 묻는다 — 여기서 규칙을 다시 쓰지 않는다.
     · 상태 변경은 `Model` 로만 한다 — `S.cells[i] = ...` 를 여기서 하지 않는다.
     · 연출은 `rosewood-fx.js` 의 이름만 부른다.
     · 남은 일은 「무엇을 그리나 · 입력을 어떻게 규칙에 넘기나」뿐이다.

   의존: rosewood-order-engine.js · rosewood-rules.js · rosewood-model.js · rosewood-fx.js
   ========================================================================== */
"use strict";

/* ======================================================================
   6. 보드 조작
   ====================================================================== */
/* 거절 사유 코드 → 문구. 규칙은 사유만 돌려주고 말은 뷰가 만든다 —
   실제 클라에서 이 자리가 Localization.getString(key) 다. */
const DENY_TEXT = {
  recharging: (r) => [`충전중 ${fmtSec(r.wait)}`, "slide", undefined],
  stock_short: (r) => [`재고가 ${r.need}개 필요해요`, "punch", "warn"],
  board_full: () => ["보드가 꽉 찼어요", "punch", "warn"],
  energy_short: (r) => [`에너지가 ${r.need} 필요해요`, "punch", "warn"],
  bag_empty: () => ["주머니가 비었어요", "punch", "warn"],
};

async function tapGenerator(i) {
  if (S.busy) return;
  sealUndo();          // 다음 행동이 곧 앞 판매의 확정 신호다
  const cell = S.cells[i], sp = specOf(cell.code);
  // 판정은 Rules 가 한다 — 실패면 아무것도 차감하지 않고 거부 연출만.
  // 문서 B1·B2 — 잘못이 아니라 상태 고지라 흔들지 않는다. 눌림 + 떠오르는 문구로만 알린다
  const plan = Rules.produceCheck({
    cells: S.cells, cell, spec: sp, energy: S.energy, boost: S.boost || 1,
    now: Date.now() / 1000, cols: COLS, rows: ROWS, from: i,
  });
  if (!plan.ok) {
    const [msg, style, tone] = (DENY_TEXT[plan.reason] || (() => ["", "punch"]))(plan);
    useHost("#rwStage", "#rwFx");
    const chip = chipAt(i), box = cellBox(i);
    if (chip) await squash(chip, 1.05, 0.95, 0.12, FX.POP_IN);
    floatText(box, msg, style, tone);
    return;
  }

  const code = Rules.produceRoll(plan.bag, plan.bumps, specOf, (w) => RNG.pick(w));
  S.busy = true;
  const from = cellBox(i), to = cellBox(plan.dest);
  Model.payProduce(i, plan);
  renderStats(); renderBoard();
  await pressPop(chipAt(i));
  await flyBezier(code, from, to);            // A2
  Model.place(plan.dest, code);
  render();
  squash(chipAt(plan.dest), FX.SQUASH_SX, FX.SQUASH_SY, FX.SQUASH_IN, FX.SQUASH_OUT);
  S.busy = false;
}

/* ────────────────────────────────────────────────────────────────
   판매 / 치우기 / 되돌리기 — 기획서 「판매 / 치우기 / 되돌리기」
     selling_price > 0  → Sell + 코인 +n
     selling_price ≤ 0  → 빨간 휴지통만(라벨·금액 숨김)
     되돌리기는 시간이 아니라 「다음 행동 전까지」다. const.undo_valid_sec 은 쓰지 않는다.
     초 시계를 둘 이유가 없다 — 되돌리기가 들고 있는 건 {칸, 코드, 코인} 한 건이라
     보관 비용이 없고, 창을 닫아야 하는 진짜 이유는 「서버에 아직 안 보낸 변경을
     언제 확정하나」였다. 그 확정 시점을 시계 대신 다음 행동에 붙인다 —
     보드·코인을 건드리는 행동이 들어오는 순간 앞의 판매를 커밋한다(sealUndo).
     생성기·고가는 확인 팝업을 타고, 그 경로에는 되돌리기를 붙이지 않는다.
   ──────────────────────────────────────────────────────────────── */
/* 판매 확인창 — 시트 `show_sell_confirm`(기획이 2026-09-10 에 rare 에서 개명) 이 정본이다.
   다만 로컬 구판 xlsx 는 이 칸이 셀 메모대로 「미확정 — 0 패딩」이라 236행 전부 0 이다.
   그대로 쓰면 확인창이 한 번도 안 떠 그 경로를 아예 못 밟는다. 그래서 칸이 통째로
   비어 있을 때만 판매가 임계로 대신한다 — 신판이 와서 값이 하나라도 차면
   sheetHasConfirm() 이 참이 되고 이 임시 경로는 저절로 꺼진다. */
const HIGH_VALUE_COIN = 10;
let CONFIRM_CACHE = { ref: null, on: false };
function sheetHasConfirm() {
  if (CONFIRM_CACHE.ref !== DATA) CONFIRM_CACHE = { ref: DATA, on: DATA.item_spec.some((r) => r.show_sell_confirm) };
  return CONFIRM_CACHE.on;
}
let UNDO = null;

/* 되돌리기 창을 닫고 서버로 보낸다. 「다음 행동」이 곧 확정 신호다 */
function sealUndo() {
  if (!UNDO) return;
  UNDO.commit();
  UNDO = null;
  const el = $("#rwUndo"); if (el) el.remove();
}

function offerUndo(label, restore, commit) {
  sealUndo();                               // 앞의 것부터 확정 — 되돌리기는 늘 「마지막 한 번」이다
  UNDO = { restore, commit };
  const el = document.createElement("div");
  el.className = "rw-undo"; el.id = "rwUndo";
  el.innerHTML = `<b>${label}</b><i>다음 행동 전까지</i>`
    + `<button class="rw-btn" onclick="undoLast()">되돌리기</button>`;
  $("#rwFrame").appendChild(el);
}

function undoLast() {
  if (!UNDO) return;
  const back = UNDO.restore;
  UNDO = null;
  const el = $("#rwUndo"); if (el) el.remove();
  if (!back()) { toast("보드가 꽉 차서 되돌릴 자리가 없습니다"); render(); return; }
  render();
  toast("되돌렸습니다 — 서버로는 보내지 않았습니다");
}

function sellCell(i) {
  const c = S.cells[i]; if (!c) return;
  const plan = Rules.sellPlan(c, specOf(c.code), {
    sheetHasConfirm: sheetHasConfirm(), highValueCoin: HIGH_VALUE_COIN,
  });
  if (!plan.ok) { toast("생성기는 팔지 않습니다"); return; }
  const name = labelOf(c.code);
  if (plan.confirm && !confirm(`${name} 을(를) 팝니다. 되돌릴 수 없습니다. 계속할까요?`)) return;

  const snapshot = { i, cell: c };
  Model.clear(i);
  if (!plan.trash) Model.addCoin(plan.price);
  render();
  if (plan.confirm) { toast(`${name} is sold. +${plan.price}`); return; }   // 확인 팝업 경로엔 되돌리기 없음
  offerUndo(
    plan.trash ? `${name} is removed.` : `${name} is sold. +${plan.price}`,
    /* 시계가 없어졌으니 원래 칸이 막혀 있을 가능성을 열어 둔다. sealUndo 가 모든
       변경 지점에 붙어 있어 실제로는 안 나야 하지만, 한 군데 빠뜨렸을 때
       남의 칩을 덮어써서 조용히 사라지는 것보다 자리를 옮기는 게 낫다. */
    () => {
      let at = snapshot.i;
      if (S.cells[at]) at = spiralEmpty(snapshot.i);
      if (at < 0) return false;
      Model.place(at, snapshot.cell);
      if (!plan.trash) Model.addCoin(-plan.price);
      return true;
    },
    () => {},                                // 확정되면 여기서 /board/sell 을 보낸다
  );
}

// 납품 확정 — 모델이 코인·직전 요구품·하루 누적 난이도를 처리하고 다음 카드를 발급한다
function commitServe(n, card, reason) {
  sealUndo();          // 다음 행동이 곧 앞 판매의 확정 신호다
  Model.commitServe(n, card, reason);
  render();
  const el = $("#rwRail").querySelector(`[data-slot="${n}"]`);
  if (el && el.classList) el.classList.add("flash");
}

async function serve(n) {
  if (S.busy || RAIL_PANNED) return;                 // 레일을 민 손끝이 Serve 를 누르지 않게
  const card = S.slots[n]; if (!card) return;
  const plan = Rules.servePlan(S.cells, card, specOf, CELLS);
  if (!plan.ok) {
    if (!S.orderFree) { toast("보유 부족"); return; }
    // 오더 프리 — 보드에서 소모하지 않고 확정만 한다
    toast(`오더 프리 납품 +${card.coin} 코인 (보드 미소모)`);
    commitServe(n, card, `슬롯 ${n} 오더 프리 납품 · 보드 미소모`);
    const fr = $("#rwFrame").getBoundingClientRect();
    const rEl = $("#rwRail").querySelector(`[data-slot="${n}"]`);
    if (rEl) { const r = rEl.getBoundingClientRect();
      coinGather({ x: r.left - fr.left + r.width / 2, y: r.top - fr.top + r.height / 2 }); }
    return;
  }

  // 소모할 셀은 Rules.servePlan 이 이미 정했다 — 그 셀들이 보드 밖(레일)으로 날아간다 — C4
  const taken = plan.taken;
  S.busy = true;
  const stage = $("#rwStage").getBoundingClientRect();
  const slotEl = $("#rwRail").querySelector(`[data-slot="${n}"]`);
  const sr = slotEl ? slotEl.getBoundingClientRect() : stage;
  const to = { x: sr.left - stage.left + sr.width / 2, y: sr.top - stage.top + sr.height / 2 };
  const boxes = taken.map((q) => cellBox(q.i));
  taken.forEach((q) => Model.clear(q.i));
  renderBoard();
  await Promise.all(taken.map(async (q, idx) => {
    await wait(idx * FX.DELIVERY_STAGGER);
    await flyBezier(q.code, boxes[idx], to, { s0: 1, sPeak: FX.DELIVERY_PEAK, s1: FX.DELIVERY_END,
      upSec: FX.DELIVERY_UP, downSec: FX.DELIVERY_AWAY, dur: FX.DELIVERY_FLIGHT,
      liftRatio: FX.DELIVERY_LIFT_RATIO, liftMin: FX.DELIVERY_LIFT_MIN });
  }));
  useHost("#rwFrame", "#rwFrameFx");
  floatText({ x: to.x + stage.left - $("#rwFrame").getBoundingClientRect().left,
              y: to.y + stage.top - $("#rwFrame").getBoundingClientRect().top, h: 0 }, "납품 완료!", "wave", "good");
  commitServe(n, card, `슬롯 ${n} 납품 완료`);
  coinGather(boxes.length ? { x: boxes[0].x + stage.left - $("#rwFrame").getBoundingClientRect().left,
                              y: boxes[0].y + stage.top - $("#rwFrame").getBoundingClientRect().top } : { x: 200, y: 300 });
  S.busy = false;
}

function doChore() {
  sealUndo();          // 다음 행동이 곧 앞 판매의 확정 신호다
  const need = lvOf(S.level)?.exp_cost ?? 999;
  S.choreSeq++;
  const exp = Math.max(5, Math.round(need / 3)), coin = 16 + S.day * 4;
  if (S.choreSeq % 3 === 0) S.day++;
  const g = Model.gainExp(exp, coin);        // 레벨 판정은 Rules.levelGain
  toast(g.ups ? `레벨 업 → Lv${S.level}` : `심부름 완료 +${exp} exp / +${coin} 코인`);
  Model.fillEmptySlots(g.ups ? `레벨 업 Lv${S.level}` : "심부름 완료");
  render();
  if (g.ups) playLevelUp();
}

/* ======================================================================
   7. 렌더
   ====================================================================== */
/* 같은 마크업을 다시 쓰지 않는다. 1초 인터벌이 레일·로그·아웃게임을 통째로
   새로 만들면 초당 한 번씩 DOM 이 무너졌다 세워져 그게 그대로 버벅임이 된다. */
const HTML_LAST = new Map();
function setHTML(sel, html) {
  if (HTML_LAST.get(sel) === html) return false;
  HTML_LAST.set(sel, html);
  const el = $(sel); if (el) el.innerHTML = html;
  return true;
}

/* ────────────────────────────────────────────────────────────────
   보드가 바뀌는 순간에만 다시 그린다. 시계로 돌리지 않는다.
   머지 규칙상 보드 구성을 바꾸는 동작 — 이게 전부다.
     구현됨   병합 · 드래그 이동 · 생성기 생산 · 판매 · 납품(오더 클리어)
              · 재고 회복 · 예산 회복 재발급 · 레벨업 슬롯 개방 · 리롤
     미구현   상자 개봉 배출 · 오더 만료(order_expire)
              · 인벤토리 넣기/꺼내기(나선 첫 빈 칸) · 보상함 꺼내기
              · 상자 개봉 배출 · 오더 만료(order_expire)
   새 동작을 붙일 때는 반드시 render() 를 거치게 한다.
   ──────────────────────────────────────────────────────────────── */
/* 인게임 화면 한 판 — ViewGame 이 자기 안에서 다시 그리는 범위다.
   아웃게임·프레임 높이·저장은 껍데기가 맡는다(아래 render). */
function renderGame() {
  syncSel();
  renderStats(); renderBoard(); renderInfo(); renderRail();
  scheduleWake();
}

/* 시계 텍스트만 만지는 초당 작업 — 텍스트 노드 몇 개가 전부다 */
function tickClocks() {
  const C = DATA.const, now = Date.now() / 1000;
  const el = $("#rwEnergyTm");
  if (el) {
    const txt = S.energy >= C.default_max_energy
      ? "" : fmtSec(C.default_recovery_duration_sec - ((now - S.energyLastAt) % C.default_recovery_duration_sec));
    if (el.textContent !== txt) el.textContent = txt;
  }
  tickRail();
}

/* 회복은 「다음에 무언가 일어나는 시각」을 잡아 두고 그때만 깨운다.
   에너지·생성기 재고·오더 예산 셋 중 가장 이른 시각이다. */
let WAKE_AT = 0;
function scheduleWake() {
  const C = DATA.const, now = Date.now() / 1000;
  let at = Infinity;
  if (S.energy < C.default_max_energy) at = Math.min(at, S.energyLastAt + C.default_recovery_duration_sec);
  for (const c of S.cells) {
    if (!c) continue;
    const sp = specOf(c.code);
    if (!sp || !sp.is_generator || !sp.spread_item_recovery_sec) continue;
    if (c.stock >= sp.spread_item_max) continue;
    at = Math.min(at, (c.lastAt || now) + sp.spread_item_recovery_sec);
  }
  for (const t of Object.values(S.orderGen.type_timers))
    if (t && t.next_refill_at > 0) at = Math.min(at, t.next_refill_at);
  WAKE_AT = Number.isFinite(at) ? at : 0;
}

function doWake() {
  const e = recoverEnergy();
  recoverStock();                                   // 바뀌었을 때만 안에서 보드를 다시 그린다
  if (retryEmptySlots()) render();
  else { if (e) { renderStats(); save(); } scheduleWake(); }
}

/* HUD 숫자는 바로 바꾸지 않고 굴린다 — 값이 변한 걸 눈이 잡게 */
const SHOWN = {};
function setNum(id, val, fmt) {
  const el = $(id); if (!el) return;
  const prev = SHOWN[id];
  SHOWN[id] = val;
  if (prev == null || prev === val || REDUCED) { el.textContent = fmt ? fmt(val) : val; return; }
  const s = { v: prev };
  tw(s, { v: val }, 0.34, "quadOut", () => {
    const n = Math.round(s.v);
    el.textContent = fmt ? fmt(n) : n;
  });
}
/* 눌림 피드백 — 문서 A1 을 HUD·카드에도 그대로 쓴다 */
function tapFeel(el) { if (el) pressPop(el); }

const clock = (d) => { const p = (x) => String(x).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const fmtSec = (s) => {
  s = Math.max(0, Math.round(s));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function renderStats() {
  const need = lvOf(S.level)?.exp_cost ?? 0;
  $("#rwLv").textContent = S.level;
  setNum("#rwCoin", S.coin, (v) => v.toLocaleString());
  setNum("#rwEnergy", S.energy);
  setNum("#rwGem", S.gem);
  const full = S.energy >= DATA.const.default_max_energy;
  const rec = DATA.const.default_recovery_duration_sec;
  $("#rwEnergyTm").textContent = full ? "" : fmtSec(rec - ((Date.now() / 1000 - S.energyLastAt) % rec));
  const b = $("#rwBoost");
  b.textContent = "x" + (S.boost || 1);
  b.className = "rw-boost m" + (S.boost || 1);

  setHTML("#rwStats", [
    ["LV", S.level], ["EXP", `${S.exp}/${need}`], ["에너지", S.energy],
    ["코인", S.coin.toLocaleString()], ["DAY", S.day],
  ].map(([k, v]) => `<div class="rw-stat"><u>${k}</u><b>${v}</b></div>`).join(""));
}

/* 오더 충족 2단계 표시 (문서 확정 사항)
   체크만            = 이 아이템을 요구하는 카드가 있다 (다른 재료가 아직 미완)
   체크 + 노란 테두리 = 그 카드가 전부 채워져 지금 납품할 수 있다 */
let MARKS_CACHE = new Map();
function orderMarks() {
  const counts = boardCounts();
  const mark = new Map();
  for (const card of Object.values(S.slots)) {
    if (!card) continue;
    const ready = card.reqs.every((q) => (counts.get(q.code) || 0) >= q.count);
    card.reqs.forEach((q) => { if (ready || !mark.has(q.code)) mark.set(q.code, ready ? "ready" : "req"); });
  }
  return mark;
}

/* 보드는 한 번만 짓고 그 다음부터는 차등 갱신한다.
   매번 innerHTML 을 갈아엎으면 진행 중인 트윈이 끊기고 칩이 튄다. */
function buildBoard() {
  const b = $("#rwBoard"); b.innerHTML = "";
  for (let i = 0; i < CELLS; i++) {
    const el = document.createElement("button");
    el.className = "rw-cell"; el.type = "button";
    el.setAttribute("aria-label", `셀 ${i}`);
    el.innerHTML = '<span class="rw-chip"></span><span class="rw-bg a"></span><span class="rw-bg b"></span>'
                 + '<span class="rw-bg c"></span><span class="rw-selb"></span>';
    el.onclick = () => { if (SUPPRESS_CLICK) return; onCell(i); };
    el.addEventListener("pointerdown", (e) => beginDrag(e, i));
    b.appendChild(el);
  }
}

function renderBoard() {
  const mark = orderMarks();
  MARKS_CACHE = mark;
  const board = $("#rwBoard");
  if (board.children.length !== CELLS) buildBoard();
  const kids = board.children;
  const now = Date.now() / 1000;

  for (let i = 0; i < CELLS; i++) {
    const el = kids[i];
    const chip = el.children[0], ba = el.children[1], bb = el.children[2], bc = el.children[3];
    const c = S.cells[i];
    if (!c) {
      el.className = "rw-cell"; el.disabled = true;
      chip.style.display = "none"; chip.className = "rw-chip";
      ba.style.display = bb.style.display = bc.style.display = "none";
      continue;
    }
    const sp = specOf(c.code), m = mark.get(c.code);
    const gen = !!sp.is_generator;
    const maxed = !sp.merged_item_code && !gen;
    const ready = m === "ready";

    let cls = "rw-cell has";
    if (gen) cls += " gen m" + (S.boost || 1);
    if (ready) cls += " ready";
    if (S.sel === i) cls += " sel";
    if (el.className !== cls) el.className = cls;
    el.disabled = false;

    // 칩 — 라벨과 색만 바꾼다. 노드는 그대로 둬서 트윈이 안 끊긴다
    const lbl = labelOf(c.code);
    const spr = spriteOf(c.code);
    let art = chip.firstElementChild;
    if (spr) {
      if (!art || art.tagName !== "IMG") {
        art = document.createElement("img");
        art.className = "a"; art.loading = "lazy"; art.decoding = "async";
        chip.replaceChildren(art);
      }
      if (art.getAttribute("src") !== spr) { art.setAttribute("src", spr); art.alt = lbl; }
    } else {
      if (!art || art.tagName !== "SPAN") {
        art = document.createElement("span"); art.className = "t"; chip.replaceChildren(art);
      }
      if (art.textContent !== lbl) art.textContent = lbl;
    }
    const shp = "rw-chip " + shapeOf(c.code) + lenOf(c.code);
    if (chip.className !== shp) chip.className = shp;
    const ttl = titleOf(c.code);
    if (el.title !== ttl) el.title = ttl;
    const h = hueOf(c.code) + "deg";
    if (chip.style.getPropertyValue("--h") !== h) chip.style.setProperty("--h", h);
    chip.style.display = "";

    // A 우상단 — 생성기 시계. 은색 = 생산 대기(충전중) / 금색 = 수확 대기(가득)
    let aTxt = "", aCls = "rw-bg a";
    if (gen) {
      if (c.stock <= 0) { aTxt = "◷"; }
      else if (c.stock >= sp.spread_item_max) { aTxt = "◷"; aCls += " gold"; }
    }
    ba.style.display = aTxt ? "" : "none";
    if (aTxt) { ba.textContent = aTxt; ba.className = aCls;
      ba.title = c.stock <= 0
        ? `충전중 — ${fmtSec(Math.max(0, sp.spread_item_recovery_sec - (now - (c.lastAt || now))))} 남음`
        : `수확 대기 — 재고 ${c.stock}/${sp.spread_item_max}`; }

    // B 우하단 — 생성기 번개 또는 오더 체크. 둘은 절대 공존하지 않는다
    let bTxt = "", bCls = "rw-bg b";
    if (gen) bTxt = "⚡";
    else if (m) { bTxt = "✓"; bCls += " check"; }
    bb.style.display = bTxt ? "" : "none";
    if (bTxt) { bb.textContent = bTxt; bb.className = bCls;
      bb.title = gen ? "생성기 — 눌러서 생산" : ready ? "지금 납품할 수 있어요" : "오더가 요구하는 아이템"; }

    // C 좌하단 — 최고 단계 왕관
    bc.style.display = maxed ? "" : "none";
    if (maxed) { bc.textContent = "♛"; bc.title = "최고 단계"; }

  }
}

/* ────────────────────────────────────────────────────────────────
   A3 · 드래그 — 문서 「머지 피드백 애니메이션」 A3 그대로.
   손가락에 딱 붙이면 종이를 미는 느낌이 난다. 무게는 세 가지에서 나온다:
     ① 지연 추종(follow) ② 밑에 깔리는 그림자 ③ 원래 자리에 남는 고스트
   추종은 포인터 이벤트가 아니라 rAF 안에서 dt 기준으로 돈다 —
   이벤트 시점에 lerp 하면 프레임 레이트에 따라 무게가 달라진다.
   ──────────────────────────────────────────────────────────────── */
let DRAG = null, SUPPRESS_CLICK = false;

/* 포인터가 움직일 때마다 getBoundingClientRect / elementFromPoint 를 부르면
   이동 한 번에 강제 레이아웃이 두 번씩 난다. 드래그를 시작할 때 무대와 격자를
   한 번만 재 두고, 그 뒤로는 산술로만 셀을 찾는다. */
let GEO = null;
function measureGeo() {
  const st = $("#rwStage").getBoundingClientRect();
  const bd = $("#rwBoard").getBoundingClientRect();
  const c0 = $("#rwBoard").children[0].getBoundingClientRect();
  const c1 = $("#rwBoard").children[1].getBoundingClientRect();
  const c7 = $("#rwBoard").children[COLS].getBoundingClientRect();
  GEO = {
    sx: st.left, sy: st.top,
    x0: c0.left - st.left, y0: c0.top - st.top,
    w: c0.width, h: c0.height,
    stepX: c1.left - c0.left, stepY: c7.top - c0.top,
  };
  return GEO;
}
function stagePoint(e) {
  const g = GEO || measureGeo();
  return { x: e.clientX - g.sx, y: e.clientY - g.sy };
}
/* 무대 좌표 → 셀 번호. 칸 사이 틈에 떨어지면 -1 */
function cellAt(p) {
  const g = GEO || measureGeo();
  const col = Math.floor((p.x - g.x0) / g.stepX), row = Math.floor((p.y - g.y0) / g.stepY);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return -1;
  if (p.x - g.x0 - col * g.stepX > g.w || p.y - g.y0 - row * g.stepY > g.h) return -1;
  return row * COLS + col;
}

function beginDrag(e, i) {
  if (S.busy || DRAG || e.button > 0 || !S.cells[i]) return;
  measureGeo();                                        // 이번 드래그 동안 쓸 격자를 한 번만 잰다
  const p = stagePoint(e);
  DRAG = { i, id: e.pointerId, p0: p, p: { ...p }, live: false, cur: -1 };
  const move = (ev) => { if (ev.pointerId === DRAG.id) onDragMove(ev); };
  const up = (ev) => {
    if (ev.pointerId !== DRAG.id) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onDragEnd(ev);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function liftDrag() {
  const d = DRAG, i = d.i;
  useHost("#rwStage", "#rwFx");
  const box = cellBox(i);
  d.live = true; d.home = box;

  // 원래 자리 고스트 — 「여기서 들어 올렸다」
  const ghost = makeFly(S.cells[i].code, box, S.cells[i]);
  ghost.style.opacity = FX.DRAG_GHOST_A;
  ghost.style.transform = `translate(${box.x - box.w / 2}px, ${box.y - box.h / 2}px)`;
  d.ghost = ghost;

  // 그림자 — 타일 밑에 상시 붙는다. 놓는 순간 따로 놀면 한 박자 늦어 보인다
  const sh = document.createElement("div");
  sh.className = "rw-shadow";
  sh.style.cssText = `width:${box.w * 0.8}px;height:${box.h * 0.34}px;left:0;top:0`;
  FXROOT.fx.appendChild(sh);
  d.shadow = sh;

  // 드래그 프록시 — 실제 칩은 숨기고 fx 레이어에서 움직인다
  const proxy = makeFly(S.cells[i].code, box, S.cells[i]);
  proxy.style.zIndex = 6;
  d.proxy = proxy;
  d.st = { x: box.x, y: box.y, sx: 1, sy: 1, rot: 0 };
  d.draw = () => {
    proxy.style.transform =
      `translate(${d.st.x - box.w / 2}px, ${d.st.y - box.h / 2}px) rotate(${d.st.rot}deg) scale(${d.st.sx},${d.st.sy})`;
    sh.style.transform = `translate(${d.st.x - box.w * 0.4}px, ${d.st.y + box.h * 0.34}px) scale(${d.shs || 1})`;
  };
  d.draw();

  const chip = chipAt(i);
  if (chip) { chip.dataset.busy = "1"; chip.style.visibility = "hidden"; }
  highlightMergeTargets(i);                    // C2 — 짝 강조는 드래그 중에만 돈다

  const s = { v: 1 }, sh0 = { v: 1, a: 0.18 };
  tw(s, { v: FX.PICK_SCALE }, FX.PICK_SEC, FX.E_PICK, () => { d.st.sx = d.st.sy = s.v; d.draw(); });
  tw(sh0, { v: FX.DRAG_SHADOW_S, a: FX.DRAG_SHADOW_A }, FX.PICK_SEC, "quadOut", () => {
    d.shs = sh0.v; sh.style.opacity = sh0.a; d.draw();
  });

  // 지연 추종 — dt 기준. 손가락보다 살짝 늦게 따라와야 무게가 생긴다
  d.tick = (dt) => {
    const k = 1 - Math.pow(1 - FX.DRAG_FOLLOW, dt * 60);
    const tx = d.p.x, ty = d.p.y - FX.PICK_LIFT;
    d.st.rot += ((tx - d.st.x) * FX.DRAG_TILT - d.st.rot) * k;
    d.st.x += (tx - d.st.x) * k;
    d.st.y += (ty - d.st.y) * k;
    d.draw();
  };
  addDragTick();
}

let DRAG_RAF = 0, DRAG_LAST = 0;
function addDragTick() {
  if (DRAG_RAF) return;
  DRAG_LAST = performance.now();
  const loop = (t) => {
    const dt = Math.min(0.05, (t - DRAG_LAST) / 1000); DRAG_LAST = t;
    if (DRAG && DRAG.live && DRAG.tick) { DRAG.tick(dt); DRAG_RAF = requestAnimationFrame(loop); }
    else DRAG_RAF = 0;
  };
  DRAG_RAF = requestAnimationFrame(loop);
}

function onDragMove(e) {
  if (!DRAG) return;
  DRAG.p = stagePoint(e);
  if (!DRAG.live) {
    if (Math.hypot(DRAG.p.x - DRAG.p0.x, DRAG.p.y - DRAG.p0.y) < FX.DRAG_MOVE_PX) return;
    if (REDUCED) return;                              // 모션 축소 — 탭으로만 논다
    liftDrag();
  }
  e.preventDefault();
  // 지나가는 셀에 링을 켠다 — 합쳐질 짝일 때만 (C2 와 같은 규칙)
  const j = cellAt(DRAG.p);
  if (j !== DRAG.cur) {
    if (DRAG.over) { DRAG.over.classList.remove("over"); DRAG.over = null; }
    DRAG.cur = j;
    const src = S.cells[DRAG.i], dst = j >= 0 ? S.cells[j] : null;
    if (j >= 0 && j !== DRAG.i && src && (!dst || (dst.code === src.code && specOf(src.code).merged_item_code))) {
      DRAG.over = $("#rwBoard").children[j];
      DRAG.over.classList.add("over");
    }
  }
}

async function onDragEnd(e) {
  const d = DRAG;
  if (!d) return;
  if (!d.live) { DRAG = null; return; }               // 움직이지 않았다 — click 이 탭으로 받는다
  DRAG = null; SUPPRESS_CLICK = true;
  setTimeout(() => (SUPPRESS_CLICK = false), 0);
  clearHighlights();
  if (d.over) d.over.classList.remove("over");

  const a = d.i, b = cellAt(stagePoint(e));
  const A = S.cells[a];
  const restore = () => {
    const chip = chipAt(a);
    if (chip) { delete chip.dataset.busy; chip.style.visibility = ""; chip.style.transform = ""; }
  };
  const cleanup = () => { d.ghost.remove(); d.shadow.remove(); d.proxy.remove(); };
  const settle = async (box) => {                      // 셀 스냅 — 그림자도 같이 가라앉는다
    const s = { x: d.st.x, y: d.st.y, sx: d.st.sx, rot: d.st.rot }, sh = { v: d.shs || 1, a: FX.DRAG_SHADOW_A };
    tw(sh, { v: 1, a: 0.18 }, FX.DRAG_SNAP, "quadOut", () => { d.shs = sh.v; d.shadow.style.opacity = sh.a; });
    await tw(s, { x: box.x, y: box.y, sx: 1, rot: 0 }, FX.DRAG_SNAP, FX.E_SNAP, () => {
      d.st.x = s.x; d.st.y = s.y; d.st.sx = d.st.sy = s.sx; d.st.rot = s.rot; d.draw();
    });
  };
  const snapBack = async () => {                       // 못 놓는 자리 — 원래 칸으로 되돌린다
    await settleTo(d, d.home, FX.DRAG_BACK, FX.E_BACK);
    cleanup(); restore();
  };
  function settleTo(dd, box, dur, ease) {
    const s = { x: dd.st.x, y: dd.st.y, sx: dd.st.sx, rot: dd.st.rot };
    tw({ v: dd.shs || 1 }, { v: 1 }, dur, "quadOut", function () {});
    return tw(s, { x: box.x, y: box.y, sx: 1, rot: 0 }, dur, ease, () => {
      dd.st.x = s.x; dd.st.y = s.y; dd.st.sx = dd.st.sy = s.sx; dd.st.rot = s.rot; dd.draw();
    });
  }

  if (!A || b < 0 || b === a) { await snapBack(); return; }

  const B = S.cells[b];
  const verdict = Rules.mergeCheck(A, B, specOf);   // 판정은 순수 규칙이 한다

  // 빈 칸 — 옮긴다
  if (verdict.kind === "move") {
    sealUndo();
    useHost("#rwStage", "#rwFx");
    await settle(cellBox(b));
    cleanup();
    Model.move(a, b);
    render(); save();
    squash(chipAt(b), FX.DRAG_LAND_X, FX.DRAG_LAND_Y, FX.DRAG_LAND_IN, FX.DRAG_LAND_OUT);
    return;
  }

  // 같은 칩이 아니거나 생성기 — 거부(C1)
  // 거부·최고단계 고지는 보드를 안 바꾼다 — 앞 판매를 확정하지 않는다
  if (verdict.reason === "mismatch") {
    await snapBack();
    shake(chipAt(b));
    return;
  }

  // 최고 단계 — 부정이 아니라 상태 고지(C5)
  if (verdict.reason === "max_level") {
    await snapBack();
    useHost("#rwStage", "#rwFx");
    const box = cellBox(b), chip = chipAt(b);
    await squash(chip, FX.MAX_HIT_X, FX.MAX_HIT_Y, FX.MAX_HIT_IN, FX.MAX_HIT_OUT);
    shake(chip, FX.MAX_SHAKE_PX, FX.MAX_SHAKE);
    floatText(box, "최고 레벨이에요", "punch");
    return;
  }

  // 병합 — 스냅으로 얹은 다음 흡수 → 임팩트 → 팝
  sealUndo();
  S.busy = true;
  useHost("#rwStage", "#rwFx");
  const to = cellBox(b);
  await settle(to);
  d.ghost.remove(); d.shadow.remove();
  Model.clear(a); clearHighlights(); renderBoard(); restore();
  const st2 = { s: 1, o: 1 };
  await tw(st2, { s: FX.ABSORB_S, o: 0 }, FX.ABSORB, FX.E_ABSORB, () => {
    d.proxy.style.transform = `translate(${to.x - d.home.w / 2}px, ${to.y - d.home.h / 2}px) scale(${st2.s})`;
    d.proxy.style.opacity = st2.o;
  });
  d.proxy.remove();
  burst(to, verdict.code);
  Model.place(b, verdict.code);
  render(); save();
  await resultPop(chipAt(b));
  S.busy = false;
}

/* A4 꼬리 — 결과 칩이 작게 시작해 임팩트를 맞고 팝 한다 */
async function resultPop(chip) {
  if (!chip || REDUCED) return;
  chip.dataset.busy = "1";
  const s2 = { sx: FX.MERGE_START_S, sy: FX.MERGE_START_S };
  const d2 = () => (chip.style.transform = `scale(${s2.sx},${s2.sy})`);
  d2();
  await tw(s2, { sx: FX.IMPACT_SX, sy: FX.IMPACT_SY }, FX.IMPACT, "quadOut", d2);
  await tw(s2, { sx: 1, sy: 1 }, FX.MERGE_POP, FX.E_MERGE_POP, d2);
  delete chip.dataset.busy; chip.style.transform = "";
}

/* 탭은 「고르기」가 전부다. 합치기는 드래그로만 한다 —
   탭 두 번으로 합치거나, 같은 칸을 다시 눌러 선택이 풀리거나,
   고르기만 했는데 짝에 링이 도는 건 머지게임의 동작이 아니다.
   문서도 짝 강조를 「드래그 중 3요소」로 못 박는다. */
/* 선택은 「탭」 하나로만 잡힌다. 생산·병합·이동·꺼내기의 결과로 칸이 선택되면
   그 칸이 흰색(--surface)으로 남아 빈 흰 박스처럼 보인다 — 유저가 고른 적 없는
   표시라 머지게임 동작이 아니다. 결과는 팝·스쿼시 연출이 알린다.
   선택이 가리키던 칩이 사라졌으면(팔림·옮겨짐·납품됨) 선택도 같이 푼다. */
function syncSel() { if (S.sel != null && !S.cells[S.sel]) S.sel = null; }

function onCell(i) {
  if (S.busy) return;
  const c = S.cells[i]; if (!c) return;
  if (specOf(c.code).is_generator) { tapGenerator(i); return; }
  if (S.sel === i) return;                              // 같은 칸 재탭 — 아무 일도 없다
  S.sel = i;
  render();
}

/* 하단 정보바 — 문서 1.5 「선택한 셀이 지금 할 수 있는 일」 */
function renderInfo() {
  const el = $("#rwInfo");
  /* 좌하단 = 인벤토리 진입. Lv2 전에는 자물쇠를 그리지 않고 자리를 비워 둔다(문서 규칙). */
  const side = () => S.level >= 2
    ? `<button type="button" class="rw-sq" title="인벤토리" onclick="openInv('store')"><b>▤</b>
         ${S.inv.store.length ? `<span class="rw-dot">${S.inv.store.length}</span>` : ""}</button>`
    : `<div class="rw-sq" style="visibility:hidden"></div>`;
  if (S.sel == null || !S.cells[S.sel]) {
    el.innerHTML = side() +
      `<div class="body"><div class="txt"><span class="name">셀을 고르세요</span>
        <div class="d">칩을 <b>끌어다</b> 같은 칩에 놓으면 합쳐지고, 빈 칸에 놓으면 옮겨집니다. ⚡생성기는 눌러서 생산합니다.</div></div></div>`;
    return;
  }
  const c = S.cells[S.sel], sp = specOf(c.code), ch = chainOf(c.code);
  const chName = chainName(ch);
  const oi = oiOf(c.code);
  const line = sp.is_generator
    ? `TAP to produce. 재고 ${c.stock}/${sp.spread_item_max} · 탭 ${sp.spread_cost_energy} 에너지`
    : sp.merged_item_code
      ? `MERGE to reach its next level. → ${labelOf(sp.merged_item_code)}${oi ? ` · 오더가 ${oi.order_price} / 난이도 ${oi.diff_score}` : ""}`
      : `최고 단계입니다. 더 합칠 수 없습니다.${oi ? ` · 오더가 ${oi.order_price}` : ""}`;
  // selling_price 로 갈린다 — 0 이하면 금액을 숨기고 빨간 휴지통만 낸다
  const price = sp.selling_price || 0;
  const act = sp.is_generator
    ? `<button class="rw-btn" onclick="tapGenerator(${S.sel})">produce</button>`
    : `<button class="rw-btn" onclick="stashCell(${S.sel})" title="보관 창고에 넣습니다">보관</button>
       ${price > 0
         ? `<button class="rw-btn" onclick="sellCell(${S.sel})">sell +${price}</button>`
         : `<button class="rw-btn trash" onclick="sellCell(${S.sel})" title="판매할 수 없는 아이템입니다 — 치웁니다">🗑</button>`}`;
  el.innerHTML =
    side() +
    `<div class="body">
       ${chipTag(c.code)}
       <div class="txt">
         <span class="name">${chName} (Lvl ${stepOf(c.code)})</span>
         <div class="d">${line}</div>
       </div>
       <span class="act">${act}</span>
     </div>`;
}

/* ────────────────────────────────────────────────────────────────
   인벤토리 (기획서 2.6)
     보관 창고와 보상함은 다른 칸 — 보상함은 창고 칸 수를 쓰지 않는다.
     꺼내기 = 보드 나선 첫 빈 칸. 보드 가득이면 토스트만.
     창고 가득이면 넣기를 거절하고 아이템은 보드에 남는다 + [슬롯 사기].
     잠긴 칸은 회색 처리하지 않고 배지만 얹는다.
   ──────────────────────────────────────────────────────────────── */
const invSlots = () => (DATA.const.inventory_slot_default || 5) + (S.inv.bought || 0);
const invMax = () => DATA.const.inventory_slot_max || 32;

/* 보드 나선 순서 — 가운데에서 바깥으로. 꺼낸 아이템이 손 가까이 놓인다 */
/* 나선 순서는 Rules.spiralOrder — Model.spiralOrder() 가 캐시해 둔다 */
const firstSpiralEmpty = () => Model.spiralOrder().find((i) => !S.cells[i]) ?? -1;

function stashCell(i) {
  const c = S.cells[i]; if (!c) return;
  if (specOf(c.code).is_generator) { toast("생성기는 창고에 넣지 않습니다"); return; }
  if (S.inv.store.length >= invSlots()) {
    toast("Inventory is full. — [슬롯 사기] 로 늘리세요");   // 넣기 거절, 아이템은 보드에 남는다
    openInv("store");
    return;
  }
  sealUndo();
  Model.stash(i);
  render(); toast(`${labelOf(c.code)} 을(를) 보관했습니다`);
}

function takeOut(kind, idx) {
  const bag = S.inv[kind];
  const code = bag[idx]; if (code == null) return;
  const dest = firstSpiralEmpty();
  if (dest < 0) { toast("No space on the board"); return; }
  sealUndo();
  Model.unstash(kind, idx, dest);
  render(); renderInv();
  squash(chipAt(dest), FX.SQUASH_SX, FX.SQUASH_SY, FX.SQUASH_IN, FX.SQUASH_OUT);
}

function buyInvSlot() {
  const rows = (DATA.inventory_unlock || []).filter((r) => r.in_use);
  const next = rows[S.inv.bought || 0];
  if (!next) { toast("더 늘릴 칸이 없습니다"); return; }
  if (S.gem < next.unlock_cost) { toast(`젬이 ${next.unlock_cost - S.gem} 개 모자랍니다`); return; }
  // 확장은 서버 소유라 낙관적 처리를 하지 않는다(문서 오너십 표) — 벤치는 즉시 반영하고 표시만 남긴다
  Model.buySlot(next.unlock_cost);
  render(); renderInv();
  toast(`칸을 늘렸습니다 — 젬 ${next.unlock_cost} 소모 (실제로는 서버 확정 후 반영)`);
}

function openInv(tab) { S.inv.tab = tab || S.inv.tab || "store"; $("#rwInv").classList.remove("rw-hide"); renderInv(); }
function closeInv() { $("#rwInv").classList.add("rw-hide"); save(); }

function renderInv() {
  const el = $("#rwInv");
  if (el.classList.contains("rw-hide")) return;
  const tab = S.inv.tab || "store";
  const rows = (DATA.inventory_unlock || []).filter((r) => r.in_use);
  const next = rows[S.inv.bought || 0];
  const bag = S.inv[tab] || [];
  const cells = [];
  if (tab === "store") {
    const openN = invSlots(), all = invMax();
    for (let i = 0; i < all; i++) {
      const code = bag[i];
      const locked = i >= openN;
      cells.push(`<button class="s ${code != null && !locked ? "has" : ""}"
        ${code != null && !locked ? `onclick="takeOut('store',${i})" title="꺼내기 — 보드 나선 첫 빈 칸"` : "disabled"}>
        ${code != null ? chipTag(code) : ""}
        ${locked ? '<span class="lk">🔒</span>' : ""}</button>`);
    }
  } else {
    // 보상함은 창고 칸 수를 쓰지 않는다 — 있는 만큼만 그린다
    if (!bag.length) cells.push('<div style="grid-column:1/-1;font-size:11.5px;color:var(--text-faint);padding:10px 2px">받을 보상이 없습니다.</div>');
    bag.forEach((code, i) => cells.push(`<button class="s has" onclick="takeOut('box',${i})" title="꺼내기">
        ${chipTag(code)}</button>`));
  }
  el.innerHTML = `<div class="rw-sheet">
      <h4>인벤토리<button class="x" onclick="closeInv()" aria-label="닫기">✕</button></h4>
      <div class="rw-tabs">
        <button aria-selected="${tab === "store"}" onclick="S.inv.tab='store';renderInv()">보관 창고 ${bagCount("store")}/${invSlots()}</button>
        <button aria-selected="${tab === "box"}" onclick="S.inv.tab='box';renderInv()">보상함 ${bagCount("box")}</button>
      </div>
      <div class="rw-bag">${cells.join("")}</div>
      <div class="foot">
        ${tab === "store"
          ? `칸 ${invSlots()}/${invMax()} · 잠긴 칸은 순서대로만 열립니다
             ${next ? `<button class="rw-btn" onclick="buyInvSlot()">슬롯 사기 ◆${next.unlock_cost.toLocaleString()}</button>` : ""}`
          : "보상함은 창고 칸 수를 쓰지 않습니다."}
      </div>
    </div>`;
}
const bagCount = (k) => (S.inv[k] || []).length;

/* 오더 카드 마크업 — 레일과 뽑기 표본이 같은 그림을 쓴다.
   문서 「오더 카드 해부」: NPC 초상 · 접시 · A 상단 우측 · B 하단 좌 · C 하단 우 · Serve */
/* 오더 카드 — ◎ 코인(A 보상) · ◈ 난이도(하루 누적되어 다음 밴드를 고른다) ·
   ◆ 이벤트 재화(B 보상).
   C 보상(팩·카드) 자리는 비워 뒀다 — 시트에 오더별 팩 보상 칸이 없다. pack 은
   주간 태스크의 count_target 으로만 나온다. 데이터 없이 「★ 팩」을 박아 두면
   모든 오더가 팩을 준다고 읽혀서 뺐다. 값이 생기면 rw-bot 에 붙인다. */
function orderCardHTML(card, o = {}) {
  const counts = o.counts;
  const evt = card.evt ?? eventScore(card.diff || 0);
  return `<div class="rw-card"${o.slot ? ` data-slot="${o.slot}"` : ""}>
      <span class="rw-npc">${card.avatar.slice(0, 3)}</span>
      <div class="rw-top">
        <span class="rw-ra"><span title="A — 코인 보상">◎ ${card.coin}</span>${card.diff ? `<span title="난이도 점수 — 하루 누적되어 다음 오더의 밴드를 고른다">◈ ${card.diff}</span>` : ""}</span>
      </div>
      <div class="rw-dish">${card.reqs.map((q) => {
        const have = counts ? (counts.get(q.code) || 0) >= q.count : false;
        return chipTag(q.code, counts && !have ? "miss" : "", have ? '<span class="ck">✓</span>' : "");
      }).join("")}</div>
      <div class="rw-bot">
        <span class="rw-rb" title="B — 이벤트 재화">◆ ${evt}</span>
        ${(S.debug || o.debug) && card.type ? `<span class="rw-lbl">${TYPE_KO[card.type] || card.type}${card.band ? ` b${card.band}` : ""}</span>` : ""}
      </div>
      ${o.serve ? `<span class="rw-serve"><button class="rw-btn serve" onclick="event.stopPropagation();serve(${o.slot})">Serve</button></span>` : ""}
    </div>`;
}

function renderRail() {
  const counts = boardCounts();
  const now = Date.now() / 1000;

  // 레일 배치 순서 — 주간 태스크 → 패스 → 이벤트 A → 이벤트 B → 이벤트 게이지 → 오더 슬롯
  $("#rwRailMeta").innerHTML =
    `<b title="주간 태스크 — 마을 게시판에서 엽니다">주간 ${S.choreSeq % 7}/7</b>` +
    `<b title="시즌 패스">패스 Lv${Math.min(30, S.level)}</b>`;
  /* 순서는 슬롯 번호로 고정한다 — 실제 게임이 그렇다.
     아직 안 열린 슬롯도 자리만 비워서 보여 준다. 몇 칸짜리 레일인지가 보여야
     「3개뿐인가」 하고 헷갈리지 않는다. 칸 수는 1~5 로 변하고, 매번 다시 배치된다. */
  let html = "";
  for (const sl of allSlots()) {
    const n = sl.n;
    if (!sl.open) {
      html += `<div class="rw-card lock" data-slot="${n}" title="${sl.type} — Lv${sl.need} 에 열립니다">🔒<span>Lv${sl.need}</span></div>`;
      continue;
    }
    const card = S.slots[n];
    if (!card) {
      /* refill_max 가 0 인 타입(시트 실물의 avatar·special·event)은 이 경로로
         영영 안 채워진다. 대기 시계를 돌리면 곧 뜰 것처럼 보여 거짓말이 된다. */
      const rule = ruleOf(sl.type);
      if (rule && rule.refill_max <= 0) {
        html += `<div class="rw-card wait none" data-slot="${n}"`
              + ` title="${sl.type} — order_rule.refill_max 가 0 입니다. 랜덤 발급 경로가 없는 타입이라 다른 경로로 채워지는 자리로 보입니다 (확인 필요)">`
              + `<span>${TYPE_KO[sl.type] || sl.type}<br><i>랜덤 발급 없음</i><br><u>refill_max 0</u></span></div>`;
        continue;
      }
      const t = S.orderGen.type_timers[sl.type];
      const wait = t && t.next_refill_at > 0 ? fmtSec(t.next_refill_at - now) : "";
      html += `<div class="rw-card wait" data-slot="${n}"><span data-wait="${sl.type}">${wait ? `대기 ${wait}` : "발급 대기"}</span></div>`;
      continue;
    }
    const ok = S.orderFree || card.reqs.every((q) => (counts.get(q.code) || 0) >= q.count);
    html += orderCardHTML(card, { slot: n, counts, serve: ok });
  }
  setHTML("#rwRail", html);
  sizeRail();
}

/* 레일은 보드·슬롯이 바뀔 때만 다시 만든다(render 경유).
   초당 바뀌는 건 빈 슬롯의 대기 시계뿐이라 그 텍스트만 갈아 끼운다. */
function tickRail() {
  const now = Date.now() / 1000;
  $("#rwRail").querySelectorAll("[data-wait]").forEach((el) => {
    const t = S.orderGen.type_timers[el.dataset.wait];
    const txt = t && t.next_refill_at > 0 ? `대기 ${fmtSec(t.next_refill_at - now)}` : "발급 대기";
    if (el.textContent !== txt) el.textContent = txt;
  });
}

/* 예산이 회복됐는데 빈 슬롯이 남아 있으면 그때 한 번 다시 발급한다.
   타이머 상태가 바뀐 순간에만 두드려서 실패 로그가 초당 쌓이지 않게 한다. */
let retryMark = "";
function retryEmptySlots() {
  if (!openSlots().some((n) => !S.slots[n])) { retryMark = ""; return false; }
  const now = Date.now() / 1000;
  const mark = Object.entries(S.orderGen.type_timers)
    .map(([t, x]) => `${t}:${x.next_refill_at > now ? "w" : "r"}:${x.refill_left}`).join("|");
  if (mark === retryMark) return false;
  retryMark = mark;
  Model.fillEmptySlots("예산 회복 재시도");
  return true;
}

/* 레일 가로 드래그 — 스크롤바를 감췄으니 미는 것으로만 넘긴다.
   6px 넘게 움직여야 드래그로 보고, 그때만 Serve 클릭을 막는다. */
let RAIL_PANNED = false;
/* 클래스만 만진다 — 스크롤 중에 불려도 레이아웃을 강제하지 않게 값은 안 잰다 */
function markRailPan() {
  const sc = document.querySelector(".rw-scroll");
  if (!sc) return;
  const over = sc.scrollWidth > sc.clientWidth + 1;
  sc.classList.toggle("pan", over);
  sc.classList.toggle("end", over && sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 2);
}
/* 카드가 좁아지면 세로로 늘어난다 — 잘리지 않게 트랙 높이를 그대로 받는다 */
function sizeRail() {
  const sc = document.querySelector(".rw-scroll"), tr = $("#rwRail");
  if (!sc || !tr) return;
  const h = tr.offsetHeight + 13;
  const cur = parseFloat(sc.style.minHeight) || 0;
  if (Math.abs(cur - h) > 0.5) sc.style.minHeight = h + "px";
  markRailPan();
}
(function enableRailPan() {
  const sc = document.querySelector(".rw-scroll");
  if (!sc) return;
  let p = null;
  sc.addEventListener("pointerdown", (e) => {
    if (sc.scrollWidth <= sc.clientWidth + 1 || e.button > 0) return;
    p = { x: e.clientX, left: sc.scrollLeft, id: e.pointerId, moved: false };
  });
  const move = (e) => {
    if (!p || e.pointerId !== p.id) return;
    const dx = e.clientX - p.x;
    if (!p.moved) {
      if (Math.abs(dx) < 6) return;
      p.moved = true;
      sc.classList.add("grabbing");
      try { sc.setPointerCapture(p.id); } catch (err) {}
    }
    sc.scrollLeft = p.left - dx;
    markRailPan();
    e.preventDefault();
  };
  const up = () => {
    if (!p) return;
    if (p.moved) { RAIL_PANNED = true; setTimeout(() => (RAIL_PANNED = false), 0); }
    sc.classList.remove("grabbing");
    p = null;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  sc.addEventListener("scroll", markRailPan, { passive: true });
})();

      /* 레벨 업 — 코어루프에서 가장 큰 사건이라 배지가 한 번 크게 튄다 */
async function playLevelUp() {
  const el = $("#rwLv");
  if (!el || REDUCED) return;
  el.dataset.busy = "1";
  const s = { sc: 1 };
  const dr = () => (el.style.transform = `scale(${s.sc})`);
  await tw(s, { sc: 1.35 }, FX.CHARGE_IN, "quadOut", dr);
  await tw(s, { sc: 1 }, FX.CHARGE_OUT, FX.E_POP, dr);
  delete el.dataset.busy;
  el.style.transform = "";
}
