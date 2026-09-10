/* ==========================================================================
   Rosewood 오더 생성 엔진 — 개발 기획서 1.2.1 의 구현 정본
   ==========================================================================
   두 페이지가 이 파일 하나를 읽는다.

     docs/rosewood-order-bench.html   시뮬레이터 — 사람이 눌러 본다
     docs/rosewood-order-draw.html    테스트    — 연산이 맞는지 본다

   사본을 두지 않는 이유: 테스트 페이지가 자기 사본을 돌리면 시뮬레이터가 쓰는
   코드와 다른 코드를 검증하게 되어, 검증 자체가 성립하지 않는다.

   여기 있는 것 — DOM 을 만지지 않고 localStorage 에 쓰지 않는 것만 온다.
     상수·유틸 · 난수(xorshift32) · 밸런스 데이터 · 세이브 읽기 ·
     유저 상태 · 오더 생성 8단계 · 오더 카드 마크업

   여기 없는 것 — 벤치에 남는다.
     연출 엔진 · 보드 조작 · 렌더 · 아웃게임 · toast · 세이브 쓰기

   벤치에서 옮길 때 로직은 바꾸지 않았다. 방어 목적의 세 곳만 손봤다.
     · hueOf 에 +120  — 시트 실물은 chain_id 가 1 부터라 (c-2)%12 가 -1 이 되어
                        색이 undefined 로 나갔다. c>=2 결과는 그대로다.
     · labelOf 를 let — 페이지가 표시용 라벨을 갈아끼울 수 있게. 기본 동작 동일.
     · reindex 의 level_curve 에 || [] — 시트 JSON 에 그 탭이 없어도 죽지 않게.

   로드 순서: 이 파일이 페이지 스크립트보다 먼저 와야 한다(DATA · S 를 여기서 선언).
   ========================================================================== */

/* ======================================================================
   0. 상수 · 유틸
   ====================================================================== */
const COLS = 7, ROWS = 9, CELLS = COLS * ROWS;

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const letterOf = (c) => String.fromCharCode(65 + (c - 2)); // chain_id 2 → A
// +120 은 chain_id 1 에서 인덱스가 -1 이 되는 것을 막는다 — c>=2 결과는 그대로다
const hueOf = (c) => [12, 150, 262, 38, 196, 320, 92, 228, 352, 176, 58, 282][(c - 2 + 120) % 12];
const codeOf = (chain, step) => chain * 100 + step;
const chainOf = (code) => Math.floor(code / 100);
const stepOf = (code) => code % 100;
// 표시용 — 페이지가 갈아끼울 수 있게 let 이다(시트 실물은 chain 이 31 종이라 한 글자로 안 된다)
let labelOf = (code) => letterOf(chainOf(code)) + stepOf(code);
// 체인마다 다른 실루엣 — 색이 비슷해도 모양으로 갈린다
const shapeOf = (code) => `rw-shape sh${(chainOf(code) - 2 + 12) % 12}`;

/* ======================================================================
   1. 난수 — xorshift32. 상태를 문자열로 직렬화해 카드와 함께 저장한다.
   ====================================================================== */
const RNG = {
  s: 20260910 >>> 0,
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x || 1; return this.s; },
  int(n) { if (n <= 1) return 0; const lim = Math.floor(4294967296 / n) * n; let r; do { r = this.next(); } while (r >= lim); return r % n; },
  pick(weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return 0;
    const r = (this.next() / 4294967296) * sum;
    let acc = 0;
    for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r < acc) return i; }
    return weights.length - 1;
  },
  save() { return String(this.s); },
  load(v) { this.s = Number(v) >>> 0 || 1; },
};

/* ======================================================================
   2. 데이터 — 확인값 + 시드값(근거 섹션 참조)
   ====================================================================== */
const CHAINS = [
  { id: 2, name: "반죽·빵", len: 9 },
  { id: 3, name: "목재", len: 8 },
  { id: 4, name: "천·직물", len: 7 },
  { id: 5, name: "화분·식물", len: 8 },
  { id: 6, name: "공구", len: 7 },
  { id: 7, name: "유리·병", len: 6 },
  { id: 8, name: "종이·편지", len: 7 },
  { id: 9, name: "금속·못", len: 8 },
];

function buildItemSpec() {
  const rows = [];
  for (const ch of CHAINS) {
    rows.push({
      item_code: codeOf(ch.id, 1), merged_item_code: 0, selling_price: 0,
      is_generator: 1, spread_cost_energy: 1, spread_item_max: 30, spread_item_recovery_sec: 120,
      p1: codeOf(ch.id, 2), w1: 60, p2: codeOf(ch.id, 3), w2: 28, p3: codeOf(ch.id, 4), w3: 12,
    });
    for (let s = 2; s <= ch.len; s++) {
      rows.push({
        item_code: codeOf(ch.id, s),
        merged_item_code: s < ch.len ? codeOf(ch.id, s + 1) : 0,
        // 시트 계약: selling_price 는 0~12, 0 이면 판매 불가(치우기만). 값은 시트가 정본이다.
        selling_price: s === 2 ? 0 : Math.min(12, s - 1),
        is_generator: 0, spread_cost_energy: 0, spread_item_max: 0, spread_item_recovery_sec: 0,
        p1: 0, w1: 0, p2: 0, w2: 0, p3: 0, w3: 0,
      });
    }
  }
  return rows;
}
const priceAt = (s) => [0, 0, 0, 3, 5, 8, 12, 20, 34, 58, 96, 160, 260, 406][s] ?? 406;
const diffAt = (s) => [0, 0, 0, 3, 6, 10, 19, 35, 68, 132, 250, 470, 900, 1700][s] ?? 2500;

function buildOrderItem() {
  const rows = [];
  for (const ch of CHAINS)
    for (let s = 3; s <= ch.len; s++)
      rows.push({
        item_code: codeOf(ch.id, s),
        unlock_level: clamp(1 + (s - 3) * 2 + Math.floor((ch.id - 2) / 3), 1, 24),
        order_price: priceAt(s), diff_score: diffAt(s),
        repeat_weight_decrease: s >= 6 ? 50 : 0, in_use: 1,
      });
  return rows;
}

const DEFAULTS = () => ({
  const: {
    order_weight_mult_required_enough: 100,
    order_weight_mult_not_required: 1000,
    order_weight_mult_higher_level: 10000,
    order_repeat_reset_count: 3,
    default_max_energy: 100,
    default_recovery_duration_sec: 120,
    nru_start_coin: 100,
    undo_valid_sec: 5,
    inventory_slot_default: 5,
    inventory_slot_max: 32,
  },
  /* 인벤토리 확장 27행 (6칸 → 32칸). 컬럼은 시트 계약대로 slot_index · cost_type · unlock_cost.
     값은 시트가 정본이고 여기 숫자는 문서에 남은 양끝(6칸 50젬 · 마지막 3칸 69950 고정)에
     맞춘 임시값이다 — 실물 시트로 갈아끼운다. 코드에서 등비수열을 다시 만들지 않는다. */
  inventory_unlock: (() => {
    const cost = [50, 55, 78, 110, 156, 220, 312, 441, 624, 882, 1247, 1764, 2494, 3527,
                  4988, 7054, 9975, 14108, 19950, 28216, 39900, 49470, 56000, 63000,
                  69950, 69950, 69950];
    return cost.map((c, i) => ({ slot_index: i + 6, cost_type: "gem", unlock_cost: c, in_use: 1 }));
  })(),
  order_rule: [
    { order_type: "normal", slot_count: 2, unlock_level: 3, item_slot_max: 2, refill_max: 5, refresh_sec: 3600, in_use: 1 },
    { order_type: "high", slot_count: 1, unlock_level: 3, item_slot_max: 2, refill_max: 1, refresh_sec: 1800, in_use: 1 },
    { order_type: "random_3", slot_count: 1, unlock_level: 4, item_slot_max: 2, refill_max: 1, refresh_sec: 900, in_use: 1 },
    { order_type: "random_4", slot_count: 1, unlock_level: 5, item_slot_max: 2, refill_max: 1, refresh_sec: 300, in_use: 1 },
    { order_type: "special", slot_count: 1, unlock_level: 4, item_slot_max: 2, refill_max: 0, refresh_sec: 0, in_use: 1 },
  ],
  order_slot_band: [
    { order_type: "normal", band_seq: 1, level_min: 0, level_max: 15, first_min: 0, first_max: 6, second_max: 4, in_use: 1 },
    { order_type: "normal", band_seq: 2, level_min: 16, level_max: 24, first_min: 2, first_max: 8, second_max: 5, in_use: 1 },
    { order_type: "normal", band_seq: 3, level_min: 25, level_max: 30, first_min: 3, first_max: 9, second_max: 6, in_use: 1 },
    { order_type: "high", band_seq: 1, level_min: 0, level_max: 15, first_min: 2, first_max: 7, second_max: 5, in_use: 1 },
    { order_type: "high", band_seq: 2, level_min: 16, level_max: 24, first_min: 4, first_max: 9, second_max: 6, in_use: 1 },
    { order_type: "high", band_seq: 3, level_min: 25, level_max: 30, first_min: 5, first_max: 11, second_max: 7, in_use: 1 },
    { order_type: "random_3", band_seq: 1, level_min: 0, level_max: 15, first_min: 0, first_max: 6, second_max: 4, in_use: 1 },
    { order_type: "random_3", band_seq: 2, level_min: 16, level_max: 24, first_min: 2, first_max: 8, second_max: 5, in_use: 1 },
    { order_type: "random_3", band_seq: 3, level_min: 25, level_max: 30, first_min: 3, first_max: 9, second_max: 6, in_use: 1 },
    { order_type: "random_4", band_seq: 1, level_min: 0, level_max: 15, first_min: 1, first_max: 7, second_max: 4, in_use: 1 },
    { order_type: "random_4", band_seq: 2, level_min: 16, level_max: 24, first_min: 3, first_max: 8, second_max: 5, in_use: 1 },
    { order_type: "random_4", band_seq: 3, level_min: 25, level_max: 30, first_min: 4, first_max: 10, second_max: 6, in_use: 1 },
  ],
  /* 이벤트 점수 — 규칙은 기획서 1.2.1 [5] 그대로. 값은 시트가 정본이라
     여기 5행은 자리를 채우는 임시값이다(실물 시트로 갈아끼워야 한다).
     기준값이 무엇인지 기획서에 안 적혀 있어 난이도(diff)로 두었다 — 확인 필요. */
  event_order_score: [
    { score_min: 0, score_max: 4, token_pct: 0, token_fix: 1, in_use: 1 },
    { score_min: 5, score_max: 14, token_pct: 0, token_fix: 2, in_use: 1 },
    { score_min: 15, score_max: 29, token_pct: 2000, token_fix: 0, in_use: 1 },
    { score_min: 30, score_max: 59, token_pct: 2500, token_fix: 0, in_use: 1 },
    { score_min: 60, score_max: 9999, token_pct: 3000, token_fix: 0, in_use: 1 },
  ],
  order_item_count: [
    { level: 1, item_count: 1, count_weight: 7500, in_use: 1 },
    { level: 1, item_count: 2, count_weight: 2500, in_use: 1 },
    { level: 4, item_count: 1, count_weight: 5714, in_use: 1 },
    { level: 4, item_count: 2, count_weight: 4286, in_use: 1 },
    { level: 8, item_count: 1, count_weight: 5000, in_use: 1 },
    { level: 8, item_count: 2, count_weight: 5000, in_use: 1 },
    { level: 11, item_count: 1, count_weight: 5000, in_use: 1 },
    { level: 11, item_count: 2, count_weight: 5000, in_use: 1 },
  ],
  order_fixed: (() => {
    const seq = [[204,0],[204,0],[205,0],[303,0],[205,304],[206,0],[404,0],[305,405],
                 [207,0],[306,0],[505,0],[406,506],[208,0],[307,0],[605,0],[407,607]];
    return seq.map((q, i) => ({
      fixed_seq: i + 1, unlock_level: i < 4 ? 1 : i < 8 ? 2 : i < 12 ? 3 : 4,
      slot_1: (i % 3) + 1, slot_2: i % 2 ? 0 : 2, slot_3: 0,
      requirement_1: q[0], requirement_2: q[1], in_use: 1,
    }));
  })(),
  order_avatar: [
    { avatar_key: "Maggie", open_day: 1, in_use: 1 }, { avatar_key: "Ida", open_day: 1, in_use: 1 },
    { avatar_key: "Rosa", open_day: 1, in_use: 1 }, { avatar_key: "Bram", open_day: 2, in_use: 1 },
    { avatar_key: "Nell", open_day: 3, in_use: 1 }, { avatar_key: "Otto", open_day: 4, in_use: 1 },
    { avatar_key: "Clara", open_day: 6, in_use: 1 }, { avatar_key: "Wren", open_day: 8, in_use: 1 },
    { avatar_key: "Silas", open_day: 11, in_use: 1 }, { avatar_key: "June", open_day: 14, in_use: 1 },
    { avatar_key: "Poppy", open_day: 999, in_use: 1 }, { avatar_key: "Hazel", open_day: 999, in_use: 1 },
    { avatar_key: "Tess", open_day: 999, in_use: 1 },
  ],
  level_curve: [15,30,45,60,60,75,75,75,75,75,90,90,90,105,105,105,120,120,120,120,120,120,120,120,135,135,135,135,150,150]
    .map((e, i) => ({ level: i + 1, exp_cost: e, reward_coin: 40 + i * 12 })),
  item_spec: buildItemSpec(),
  order_item: buildOrderItem(),
});

let DATA = DEFAULTS();
/* 조회는 인덱스로 — 보드 한 번 그릴 때 specOf 가 수백 번 불린다.
   DATA 를 통째로 갈아끼울 때만 인덱스를 버린다(reindex). */
let IDX = null;
function reindex() {
  IDX = {
    spec: new Map(DATA.item_spec.map((r) => [r.item_code, r])),
    oi: new Map(DATA.order_item.map((o) => [o.item_code, o])),
    rule: new Map(DATA.order_rule.filter((r) => r.in_use).map((r) => [r.order_type, r])),
    lv: new Map((DATA.level_curve || []).map((l) => [l.level, l])),
  };
  return IDX;
}
const idx = () => IDX || reindex();
const specOf = (code) => idx().spec.get(code);
const oiOf = (code) => idx().oi.get(code);
const lvOf = (level) => idx().lv.get(level);

/* ======================================================================
   2b. 저장 — 읽기만. 쓰기(saveNow/save)는 벤치에 남는다.
   ====================================================================== */
const BUILD = "v3.3 · 2026-09-11";
const SAVE_KEY = "rw.orderBench";
const SAVE_VER = 3;

function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || o.v !== SAVE_VER || !o.data || !o.state) return null;
    if (!Array.isArray(o.state.cells) || o.state.cells.length !== CELLS) return null;
    if (!Array.isArray(o.data.order_rule) || !Array.isArray(o.data.item_spec)) return null;
    o.state.log = (o.state.log || []).map((e) => ({ ...e, t: new Date(e.t) }));
    return o;
  } catch (e) { return null; }
}
function clearSaved() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

/* ======================================================================
   3. 유저 상태
   ====================================================================== */
let S;
function freshState() {
  const cells = new Array(CELLS).fill(null);
  const seed = [[1,1],[1,5],[3,3],[5,1],[5,5],[7,3]];
  CHAINS.slice(0, 6).forEach((ch, i) => {
    const [r, c] = seed[i];
    cells[r * COLS + c] = { code: codeOf(ch.id, 1), stock: 30, lastAt: Date.now() / 1000 };
  });
  return {
    cells, level: 1, exp: 0, coin: DATA.const.nru_start_coin, gem: 0, debug: false,
    inv: { store: [], box: [], bought: 0, tab: "store" },
    energy: DATA.const.default_max_energy, energyLastAt: Date.now() / 1000, serveCount: 0, boost: 1,
    day: 1, choreSeq: 0, sel: null, busy: false, orderFree: false, out: null,
    orderGen: { rng_state: RNG.save(), fixed_next_seq: 1, chain_repeat: {}, type_timers: {} },
    slots: {}, prevOfSlot: {}, log: [],
  };
}

const slotType = (n) => (n === 1 || n === 2 ? "normal" : n === 3 ? "high" : n === 4 ? "random_3" : n === 5 ? "random_4" : "special");
const ruleOf = (type) => idx().rule.get(type);

/* 레일에 그릴 다섯 칸 전부 — 열림/잠김과 필요한 레벨까지 함께 준다.
   openSlots() 와 같은 기준을 쓴다(슬롯 1~3 은 Lv1 부터, 4·5 는 order_rule.unlock_level). */
function allSlots() {
  return [1, 2, 3, 4, 5].map((n) => {
    const type = slotType(n);
    const r = ruleOf(type);
    const need = n >= 4 && r ? r.unlock_level : 1;
    return { n, type, need, open: S.level >= need };
  });
}

function openSlots() {
  // 슬롯 1~3 은 Lv1 부터 존재한다 — Lv1~2 구간은 order_fixed 16장이 채운다.
  // 랜덤 발급 자체는 order_rule.unlock_level 로 따로 막는다.
  const out = [1, 2, 3];
  const r4 = ruleOf("random_3"), r5 = ruleOf("random_4");
  if (r4 && S.level >= r4.unlock_level) out.push(4);
  if (r5 && S.level >= r5.unlock_level) out.push(5);
  return out;
}

/* ======================================================================
   4. 오더 생성 — 개발 기획서 1.2.1 의 8단계
   ====================================================================== */
function boardCounts() {
  const m = new Map();
  for (const c of S.cells) {
    if (!c) continue;
    const sp = specOf(c.code);
    if (sp && sp.is_generator) continue;
    m.set(c.code, (m.get(c.code) || 0) + 1);
  }
  return m;
}
/* [5] 이벤트 점수 — score_min 오름차순으로 「기준값 >= score_min 인 마지막 행」.
   score_max 는 검사용이라 런타임 선택에 쓰지 않는다. 행이 없거나 기준값 0 이면 0. */
function eventScore(base) {
  if (!base || base <= 0) return 0;
  const rows = (DATA.event_order_score || []).filter((r) => r.in_use)
    .sort((a, b) => a.score_min - b.score_min);
  let hit = null;
  for (const r of rows) if (base >= r.score_min) hit = r;
  if (!hit) return 0;
  if (hit.token_pct > 0) return Math.floor((base * hit.token_pct) / 10000);
  return hit.token_fix || 0;
}

function requiredElsewhere(slotNo) {
  const set = new Set();
  for (const [n, card] of Object.entries(S.slots)) {
    if (Number(n) === slotNo || !card) continue;
    card.reqs.forEach((q) => set.add(q.code));
  }
  return set;
}

// [4] 보드 상황 배수 — 하나만 적용, 중복 곱 금지
/* 기획서 [2] 는 「다른 오더가 **이 체인을** 요구」라고 체인 단위로 쓴다.
   후보 제외(banned)만 명시적으로 코드 단위다 — 둘을 섞지 않는다.
   납품 가능 여부는 그 코드가 보드에 있어야 하므로 코드 단위 그대로. */
function situationMult(code, othersReq, counts, C, othersChains) {
  const chains = othersChains || new Set([...othersReq].map(chainOf));
  const wanted = chains.has(chainOf(code));
  const canServe = (counts.get(code) || 0) > 0;
  if (wanted && canServe) return { v: C.order_weight_mult_required_enough, why: "타오더 요구+납품가능" };
  if (!wanted) {
    const ch = chainOf(code), st = stepOf(code);
    for (const [c, n] of counts)
      if (n > 0 && chainOf(c) === ch && stepOf(c) <= st)
        return { v: C.order_weight_mult_higher_level, why: "미요구+보드에 동급·하급 有" };
    return { v: C.order_weight_mult_not_required, why: "미요구" };
  }
  return { v: 1, why: "타오더 요구+납품불가(기본)" };
}

const pickBand = (type, level) =>
  DATA.order_slot_band.filter((b) => b.order_type === type && b.in_use)
    .sort((a, b) => a.band_seq - b.band_seq)
    .find((b) => level >= b.level_min && level <= b.level_max) || null;

function pickAvatar() {
  const pool = DATA.order_avatar.filter((a) => a.in_use && a.open_day <= S.day);
  const used = new Set(Object.values(S.slots).filter(Boolean).map((c) => c.avatar));
  const free = pool.filter((a) => !used.has(a.avatar_key));
  if (free.length) return free[RNG.int(free.length)].avatar_key;
  if (pool.length) return pool[RNG.int(pool.length)].avatar_key;
  const fb = DATA.order_avatar.filter((a) => a.open_day < 999);
  return fb.length ? fb[0].avatar_key : "—";
}

function generateOrder(slotNo, opts = {}) {
  const dry = !!opts.dry;
  const level = opts.level ?? S.level;
  const type = opts.type ?? slotType(slotNo);
  const C = DATA.const;
  const L = [];
  const push = (t) => L.push(t);

  // ---- [0] 고정 오더 먼저 (랜덤 예산·대기 미변경)
  if (!opts.skipFixed) {
    const fx = DATA.order_fixed.find((f) => f.in_use && f.fixed_seq === S.orderGen.fixed_next_seq);
    if (fx) {
      const slotOk = [fx.slot_1, fx.slot_2, fx.slot_3].includes(slotNo);
      const lvOk = level >= fx.unlock_level;
      if (slotOk && lvOk) {
        const reqs = [{ code: fx.requirement_1, count: 1 }];
        if (fx.requirement_2) reqs.push({ code: fx.requirement_2, count: 1 });
        const coin = reqs.reduce((a, q) => a + (oiOf(q.code)?.order_price || 0), 0);
        const diff = reqs.reduce((a, q) => a + (oiOf(q.code)?.diff_score || 0), 0);
        push(`<span class="k">[0] 고정 오더 채택</span> fixed_seq=${fx.fixed_seq} (unlock_level ${fx.unlock_level} ≤ Lv${level} · 슬롯 ${fx.slot_1}/${fx.slot_2}/${fx.slot_3} 에 ${slotNo} 포함)`);
        push(`    요구 ${reqs.map((q) => labelOf(q.code)).join(" + ")} · 랜덤 예산·대기 변경 없음`);
        if (!dry) S.orderGen.fixed_next_seq++;
        return { card: { slot: slotNo, type: "fixed", reqs, avatar: pickAvatar(), coin, diff, evt: eventScore(diff), band: null }, log: L };
      }
      push(`[0] 고정 오더 fixed_seq=${fx.fixed_seq} 미적용 (${!lvOk ? `unlock_level ${fx.unlock_level} > Lv${level}` : `슬롯 ${fx.slot_1}/${fx.slot_2}/${fx.slot_3} 에 ${slotNo} 없음`}) → 순번 유지, 랜덤 검사로`);
    }
  }

  // ---- [1] 예산·대기
  const rule = ruleOf(type);
  if (!rule) { push(`<span class="w">order_rule 에 ${type} 활성 행 없음</span>`); return { card: null, log: L }; }
  /* 해금 검사는 상태를 바꾸지 않는 순수 판정이라 dry 에서도 돈다.
     예산·대기만 dry 에서 건너뛴다 — 이걸 한 블록에 묶어 두면 분포 시뮬이
     미해금 타입도 발급해 버려서, 실제로는 한 장도 안 나올 오더가 통계에 섞인다. */
  if (level < rule.unlock_level) {
    push(`<span class="w">[1] ${type} 미해금</span> (unlock_level ${rule.unlock_level} > Lv${level}) → 랜덤 발급 없음. 고정 오더만 이 슬롯을 채운다`);
    return { card: null, log: L, locked: true };
  }
  if (!dry) {
    const t = (S.orderGen.type_timers[type] ||= { remaining_count: rule.refill_max, next_refill_at: 0 });
    const now = Date.now() / 1000;
    if (t.next_refill_at > 0 && now >= t.next_refill_at) {
      t.remaining_count = rule.refill_max; t.next_refill_at = 0;
      push(`[1] 대기 종료 → 예산 ${rule.refill_max} 로 <span class="k">한 번</span> 채움 (누적 없음)`);
    }
    if (t.remaining_count <= 0) {
      if (t.next_refill_at <= 0) {
        t.next_refill_at = now + rule.refresh_sec;
        push(`<span class="w">[1] 예산 0 → 대기 시작</span> now+${rule.refresh_sec}s · 카드 만들지 않음`);
      } else {
        push(`<span class="w">[1] 예산 0 · 대기 중</span> 남은 ${Math.ceil(t.next_refill_at - now)}s · 종료 시각 안 미룸`);
      }
      return { card: null, log: L };
    }
    push(`[1] 예산 ${t.remaining_count}/${rule.refill_max} (${type}${type === "normal" ? " · 슬롯 1·2 공유" : ""})`);
  }

  // ---- [2] 자리별 단계 범위
  const band = pickBand(type, level);
  if (!band) { push(`<span class="w">[2] order_slot_band 에 Lv${level} 구간 없음 → 데이터 오류</span>`); return { card: null, log: L }; }
  push(`<span class="k">[2] 밴드</span> band_seq=${band.band_seq} (Lv ${band.level_min}~${band.level_max}) · 첫째 ${band.first_min}~${band.first_max}단계 · 둘째 ≤${band.second_max}단계`);

  // ---- [3] 후보 집합
  const counts = opts.counts ?? boardCounts();
  const othersReq = opts.othersReq ?? requiredElsewhere(slotNo);
  const prev = opts.prev !== undefined ? opts.prev : S.prevOfSlot[slotNo];
  const CR = opts.repeat || S.orderGen.chain_repeat;   // 시뮬은 사본을 넘겨 게임 상태를 오염시키지 않는다
  const othersChains = new Set([...othersReq].map(chainOf));
  const banned = new Set([...othersReq]);
  if (prev) prev.forEach((c) => banned.add(c));
  push(`[3] 제외 item_code: ${banned.size ? [...banned].map(labelOf).join(", ") : "없음"} <span style="opacity:.65">(체인 전체 아님)</span>`);

  const pool = DATA.order_item.filter((o) => o.in_use && o.unlock_level <= level);
  const slotMax = rule.item_slot_max;
  const picked = [];
  const chosen = new Set();
  // 가중치를 실제로 나눈 체인 — 반복 카운터는 「뽑힌 것」이 아니라 「제한이 걸린 것」 기준이다
  const divided = new Set();

  for (let seat = 1; seat <= slotMax; seat++) {
    const lo = seat === 1 ? band.first_min : 0;
    const hi = seat === 1 ? band.first_max : band.second_max;
    const cand = pool.filter((o) => {
      const st = stepOf(o.item_code);
      return st >= lo && st <= hi && !banned.has(o.item_code) && !chosen.has(o.item_code);
    });
    if (!cand.length) {
      push(`<span class="w">[4] 자리${seat} 후보 0</span> (${lo}~${hi}단계) → 이 자리 이후는 추첨하지 않는다`);
      break;
    }
    const rows = cand.map((o) => {
      const m = situationMult(o.item_code, othersReq, counts, C, othersChains);
      const rem = CR[chainOf(o.item_code)] || 0;
      const div = rem > 0 && o.repeat_weight_decrease > 0 ? o.repeat_weight_decrease : 0;
      if (div) divided.add(chainOf(o.item_code));
      return { o, mult: m.v, why: m.why, div, w: div ? m.v / div : m.v };
    });
    const total = rows.reduce((a, r) => a + r.w, 0);
    const win = rows[RNG.pick(rows.map((r) => r.w))];
    picked.push(win.o); chosen.add(win.o.item_code);

    const byWhy = {};
    rows.forEach((r) => { byWhy[r.why] = (byWhy[r.why] || 0) + 1; });
    push(`<span class="k">[4] 자리${seat}</span> 범위 ${lo}~${hi} · 후보 ${cand.length}종 [${Object.entries(byWhy).map(([k, v]) => `${k} ${v}`).join(" / ")}]`);
    push(`    → <span class="p">${labelOf(win.o.item_code)}</span> 배수 ${win.mult}${win.div ? ` ÷제수 ${win.div}` : ""} = 가중 ${win.w.toFixed(1)} / 합 ${total.toFixed(1)} = <span class="p">${((win.w / total) * 100).toFixed(2)}%</span>`);
  }

  if (!picked.length) {
    push(`<span class="w">[4] 첫 자리부터 후보 없음 → 생성 실패.</span> 기회·카운터·난수 상태 전부 보존 (기회 소비 안 함)`);
    return { card: null, log: L, failed: true };
  }

  // ---- [5] 요구 종수 — 자리를 먼저 뽑고 그 수 안에서 정한다
  const grp = Math.max(...DATA.order_item_count.filter((r) => r.in_use && r.level <= level).map((r) => r.level));
  const rowsC = DATA.order_item_count.filter((r) => r.in_use && r.level === grp && r.item_count <= picked.length && r.item_count <= slotMax);
  let n = picked.length;
  if (rowsC.length) {
    const sum = rowsC.reduce((a, r) => a + r.count_weight, 0);
    n = rowsC[RNG.pick(rowsC.map((r) => r.count_weight))].item_count;
    push(`<span class="k">[5] 종수</span> level 묶음 ${grp} · 후보 자리 ${picked.length} · ${rowsC.map((r) => `${r.item_count}종 ${((r.count_weight / sum) * 100).toFixed(2)}%`).join(" / ")} → <span class="p">${n}종</span>`);
  }
  const finalReqs = picked.slice(0, n).map((o) => ({ code: o.item_code, count: 1 }));
  if (n < picked.length)
    push(`    버린 후보 ${picked.slice(n).map((o) => labelOf(o.item_code)).join(", ")} — <span class="k">반복 카운터 갱신에는 포함</span>`);

  /* ---- 반복 카운터 — 「가중치를 나눈 모든 후보의 체인」이 대상이다.
     뽑힌 후보로만 대상을 만들면 won ⊇ applied 가 되어 감소 분기에 절대 닿지 않고,
     한 번 눌린 체인이 영원히 눌린 채로 남는다. divided 는 [4] 에서 실제로 나눈 체인이다. */
  if (!dry || opts.repeat) {                            // 사본을 받았으면 dry 여도 갱신한다
    const applied = divided;
    const won = new Set(picked.map((o) => chainOf(o.item_code)));
    const upd = [];
    applied.forEach((ch) => {
      if (won.has(ch)) { CR[ch] = C.order_repeat_reset_count; upd.push(`${letterOf(ch)}→${C.order_repeat_reset_count}`); }
      else {
        CR[ch] = Math.max(0, (CR[ch] || 0) - 1);
        if (!CR[ch]) delete CR[ch];
        upd.push(`${letterOf(ch)}−1`);
      }
    });
    if (upd.length) push(`    반복 카운터 ${upd.join(", ")}`);
  }

  // ---- [6][7]
  const avatar = pickAvatar();
  const coin = finalReqs.reduce((a, q) => a + (oiOf(q.code)?.order_price || 0) * q.count, 0);
  const diff = finalReqs.reduce((a, q) => a + (oiOf(q.code)?.diff_score || 0) * q.count, 0);
  push(`<span class="k">[6] 손님</span> ${avatar} (day ${S.day} 해금 명단에서 균등)`);
  const evt = eventScore(diff);
  push(`<span class="k">[7] 보상</span> 코인 ${coin} = ${finalReqs.map((q) => oiOf(q.code)?.order_price).join(" + ")} · 난이도 ${diff} · <span style="opacity:.65">경험치 0</span>`);
  push(`<span class="k">[5] 이벤트 점수</span> 기준값 ${diff} → ${evt} <span style="opacity:.65">(event_order_score · 기준값=난이도로 가정)</span>`);

  if (!dry) {
    const t = S.orderGen.type_timers[type];
    if (t) { t.remaining_count--; push(`[8] 예산 −1 → ${t.remaining_count} · 카드+난수+카운터 원자 저장 → 표시 → /order/refresh`); }
    S.orderGen.rng_state = RNG.save();
  }
  return { card: { slot: slotNo, type, reqs: finalReqs, avatar, coin, diff, evt, band: band.band_seq }, log: L };
}

/* ======================================================================
   렌더 헬퍼 — 양쪽이 쓰는 것만.
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

const clock = (d) => { const p = (x) => String(x).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

/* 오더 카드 마크업 — 레일과 뽑기 표본이 같은 그림을 쓴다.
   문서 「오더 카드 해부」: NPC 초상 · 접시 · A 상단 우측 · B 하단 좌 · C 하단 우 · Serve */
function orderCardHTML(card, o = {}) {
  const counts = o.counts;
  const evt = card.evt ?? eventScore(card.diff || 0);
  return `<div class="rw-card"${o.slot ? ` data-slot="${o.slot}"` : ""}>
      <span class="rw-npc">${card.avatar.slice(0, 3)}</span>
      <div class="rw-top">
        <span class="rw-ra"><span>◎ ${card.coin}</span>${card.diff ? `<span>◈ ${card.diff}</span>` : ""}</span>
      </div>
      <div class="rw-dish">${card.reqs.map((q) => {
        const have = counts ? (counts.get(q.code) || 0) >= q.count : false;
        return `<span class="rw-req ${shapeOf(q.code)} ${counts && !have ? "miss" : ""}" style="--h:${hueOf(chainOf(q.code))}deg">${labelOf(q.code)}${have ? '<span class="ck">✓</span>' : ""}</span>`;
      }).join("")}</div>
      <div class="rw-bot">
        <span class="rw-rb" title="B — 이벤트 재화">◆ ${evt}</span>
        ${(S.debug || o.debug) && card.type ? `<span class="rw-lbl">${card.type}${card.band ? ` b${card.band}` : ""}</span>` : ""}
        <span class="rw-rc" title="C — 팩·카드">★ 팩</span>
      </div>
      ${o.serve ? `<span class="rw-serve"><button class="rw-btn serve" onclick="event.stopPropagation();serve(${o.slot})">Serve</button></span>` : ""}
    </div>`;
}
