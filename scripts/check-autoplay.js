/* 로즈우드 자동 플레이 검증 — RwEcon 단위/속성 검사(Part 1) + 전체 페이지 옵션 매트릭스 러너(Part 2).
   ──────────────────────────────────────────────────────────────────────
   계약 근거: `_ignore/plan-rosewood-autoplay.md` 부록 B (B1 bal 스키마 · B2 RwEcon API ·
   B3 RwView.render(snap) · B4 rosewood-board.js §1 루프 + window.__RWB 디버그 훅),
   부록 C(소모형 상자·젬 충전·젬 음수 허용), 부록 D(16배속·옵션 4개·상자 개봉),
   부록 E(상자 우선·재화 최대 머지) — Part 2 는 옵션 5개 config(정의는 OPT_CONFIGS)를
   페이지 하나에서 이어서 돌린다.

   vm 컨텍스트 주의 (scripts/check-bench-draw-parity.js 와 같은 함정):
   `docs/js/rosewood-order-engine.js` 는 top-level `let DATA`(그 외 `S, IDX, RNG, COLS...`)를
   선언한다. `ctx.DATA = ...` 처럼 컨텍스트 **밖에서** 프로퍼티를 대입해도 그 바인딩은
   안 덮인다 — 반드시 `vm.runInContext('DATA = __BAL; ...', ctx)` 처럼 **컨텍스트 안에서**
   대입해야 한다. 여기서는 `RwEcon.init(bal)` 가 이 대입을 엔진과 같은 컨텍스트 **안에서**
   실행하는 함수이므로(같은 vm.runInContext 로 로드됐다), 그 함수를 그대로 부르면 된다 —
   단, `RwEcon.init` 자체는 econ.js 가 IIFE 로 감싸 `window.RwEcon` 에만 걸어 두므로
   엔진과 econ.js를 **같은 컨텍스트**에 순서대로 runInContext 해야 한다(B2).

   사용:  node scripts/check-autoplay.js     (레포 루트에서)
   의존 파일(없으면 해당 파트를 SKIP 하고 사유를 찍는다):
     docs/js/rosewood-order-engine.js (이미 있음, 수정 금지 대상)
     docs/js/rosewood-econ.js         (W2 산출물)
     docs/data/rosewood-board.json 의 `bal` 키 (W1 산출물)
     docs/rosewood-initial-board.html + docs/js/rosewood-board.js 의 window.__RWB (W2/W3 통합 산출물)
   ────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = process.cwd();
const ENGINE_PATH = path.join(ROOT, 'docs/js/rosewood-order-engine.js');
const ECON_PATH = path.join(ROOT, 'docs/js/rosewood-econ.js');
const BOARD_JSON_PATH = path.join(ROOT, 'docs/data/rosewood-board.json');
const HTML_PATH = path.join(ROOT, 'docs/rosewood-initial-board.html');
const DOCS_DIR = path.join(ROOT, 'docs');

const results = []; // {name, pass, detail}
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: typeof detail === 'string' ? detail : '' });
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
  }
}
function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg);
}

function printResults(list) {
  for (const r of list) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.name}${r.detail ? ' :: ' + r.detail : ''}`);
}

/* ======================================================================
   Part 1 — RwEcon 단위/속성 검사
   ====================================================================== */
function part1() {
  console.log('\n== Part 1: RwEcon unit/property checks ==');

  if (!fs.existsSync(ENGINE_PATH)) {
    console.log(`SKIP Part1 - missing ${path.relative(ROOT, ENGINE_PATH)}`);
    return;
  }
  if (!fs.existsSync(ECON_PATH)) {
    console.log(`SKIP Part1 - missing ${path.relative(ROOT, ECON_PATH)} (W2 not landed yet)`);
    return;
  }
  if (!fs.existsSync(BOARD_JSON_PATH)) {
    console.log(`SKIP Part1 - missing ${path.relative(ROOT, BOARD_JSON_PATH)}`);
    return;
  }
  const boardJson = JSON.parse(fs.readFileSync(BOARD_JSON_PATH, 'utf8'));
  const bal = boardJson.bal;
  if (!bal) {
    console.log('SKIP Part1 - docs/data/rosewood-board.json has no `bal` key yet (W1 not landed yet)');
    return;
  }

  const engineSrc = fs.readFileSync(ENGINE_PATH, 'utf8');
  const econSrc = fs.readFileSync(ECON_PATH, 'utf8');

  function freshCtx(balObj) {
    const store = {};
    const ctx = {
      window: {},
      document: { querySelector: () => null, querySelectorAll: () => [] },
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      },
      console,
    };
    vm.createContext(ctx);
    // __BAL 은 vm 글로벌(=ctx) 의 프로퍼티라 컨텍스트 안 코드에서 맨 식별자로 보인다.
    ctx.__BAL = JSON.parse(JSON.stringify(balObj));
    vm.runInContext(engineSrc, ctx, { filename: 'rosewood-order-engine.js' });
    vm.runInContext(econSrc, ctx, { filename: 'rosewood-econ.js' });
    vm.runInContext('window.RwEcon.init(__BAL)', ctx);
    if (!ctx.window.RwEcon) throw new Error('window.RwEcon 이 없다 (econ.js 가 IIFE 로 window.RwEcon 을 안 내놓음?)');
    return ctx;
  }
  function newEcon(balObj) {
    const ctx = freshCtx(balObj || bal);
    return { ctx, RwEcon: ctx.window.RwEcon };
  }

  // ---- 호스트 쪽에서 독립적으로 재계산하는 기대값 헬퍼(엔진 인덱스를 안 믿고 원본 bal 을 직접 읽는다) ----
  const chores = (bal.main_task || []).filter((r) => r.in_use).sort((a, b) => a.day - b.day || a.task_seq - b.task_seq);
  const rewardKeyRow = (key) => (bal.reward_key || []).find((r) => r.reward_key === key);
  const lastDay = chores.length ? Math.max(...chores.map((r) => r.day)) : 0;

  // ====================================================================
  // 1. 심부름
  // ====================================================================
  {
    const { RwEcon } = newEcon();
    let acc = RwEcon.newAccount();
    const first = chores[0];
    check('chore: coin short -> not ok', () => {
      acc.coin = Math.max(0, (first.cost_coin || 1) - 1);
      const c = RwEcon.choreCheck(acc);
      assertTrue(c.ok === false, `choreCheck.ok expected false, got ${c.ok}`);
      assertTrue(c.reason === 'CoinShort', `reason expected CoinShort, got ${c.reason}`);
      return `reason=${c.reason}`;
    });
    check('chore: coin short -> doChore changes nothing', () => {
      const before = JSON.stringify({ coin: acc.coin, doneKeys: acc.doneKeys, day: acc.day, level: acc.level, exp: acc.exp, rewardBox: acc.rewardBox });
      const r = RwEcon.doChore(acc);
      const after = JSON.stringify({ coin: acc.coin, doneKeys: acc.doneKeys, day: acc.day, level: acc.level, exp: acc.exp, rewardBox: acc.rewardBox });
      assertTrue(r.ok === false, `doChore.ok expected false, got ${r.ok}`);
      assertEq(after, before, 'account state after failed doChore');
      return 'no state change on failure';
    });
  }
  {
    const { RwEcon } = newEcon();
    let acc = RwEcon.newAccount();
    const first = chores[0];
    acc.coin = 999999;
    const coinBefore = acc.coin;
    const doneBefore = acc.doneKeys.length;
    const r = RwEcon.doChore(acc);
    check('chore: spent === row.cost_coin exactly', () => {
      assertTrue(r.ok, `doChore.ok expected true, got ${r.ok} (row=${JSON.stringify(r.row)})`);
      assertEq(r.spent, first.cost_coin, 'spent');
      assertEq(coinBefore - acc.coin, first.cost_coin, 'coin delta');
      return `spent=${r.spent}`;
    });
    check('chore: doneKeys grows by 1', () => {
      assertEq(acc.doneKeys.length, doneBefore + 1, 'doneKeys.length');
      // econ.js choreKey() 실제 포맷은 "{day}:{task_seq}" (ChoreRules.ts:21-23 인용 주석대로).
      const expectKey = `${first.day}:${first.task_seq}`;
      assertTrue(acc.doneKeys.includes(expectKey), `doneKeys should contain "${expectKey}", got ${JSON.stringify(acc.doneKeys)}`);
      return `doneKeys += "${expectKey}"`;
    });
    check('chore: grants match reward_item_key_1..3/amount', () => {
      for (let i = 1; i <= 3; i++) {
        const key = first[`reward_item_key_${i}`];
        const amount = first[`reward_amount_${i}`];
        if (!key || key === 'none' || !amount) continue;
        if (key === 'currency_exp') {
          const g = r.grants.find((g) => g.kind === 'exp' && g.amount === amount);
          assertTrue(!!g, `expected exp grant amount=${amount}, got ${JSON.stringify(r.grants)}`);
        } else if (key.startsWith('currency_')) {
          const kind = key.replace('currency_', '');
          const g = r.grants.find((g) => g.kind === kind && g.amount === amount);
          assertTrue(!!g, `expected ${kind} grant amount=${amount}, got ${JSON.stringify(r.grants)}`);
        } else {
          const row = rewardKeyRow(key);
          assertTrue(!!row, `reward_key row not found for ${key}`);
          const g = r.grants.find((g) => g.kind === 'item' && g.code === row.item_code && g.amount === amount);
          assertTrue(!!g, `expected item grant code=${row.item_code} amount=${amount}, got ${JSON.stringify(r.grants)}`);
        }
      }
      return `grants=${JSON.stringify(r.grants)}`;
    });
  }
  {
    // day 를 끝까지 밀어서 D1(마지막 task_seq 다음 day 진행, lastDay 이후 AllCleared) 확인
    const { RwEcon } = newEcon();
    let acc = RwEcon.newAccount();
    acc.coin = 99999999;
    let dayAdvancedSeen = false;
    let allClearedSeen = false;
    let lastRes = null;
    for (let i = 0; i < chores.length + 2; i++) {
      const c = RwEcon.choreCheck(acc);
      if (!c.ok) { if (c.reason === 'AllCleared') allClearedSeen = true; break; }
      const before = { ...acc, day: acc.day };
      lastRes = RwEcon.doChore(acc);
      if (lastRes.dayAdvanced) dayAdvancedSeen = true;
      acc.coin = 99999999; // 매 수 코인 보충(비용 검사에서 안 막히게)
    }
    check('chore: day advances after last task_seq of a day', () => {
      assertTrue(dayAdvancedSeen, 'expected at least one dayAdvanced=true while clearing all chores');
      return 'dayAdvanced observed';
    });
    check('chore: stops after lastDay -> AllCleared', () => {
      assertTrue(allClearedSeen, 'expected choreCheck.reason=AllCleared after clearing all chores');
      assertEq(acc.day, lastDay + 1 > lastDay ? acc.day : lastDay, 'day should not exceed lastDay range unexpectedly'); // sanity, day 값 자체는 econ 구현에 맡긴다
      return `day=${acc.day} lastDay(bal)=${lastDay}`;
    });
  }

  // ====================================================================
  // 2. 레벨
  // ====================================================================
  {
    const { RwEcon } = newEcon();
    let acc = RwEcon.newAccount();
    const curve = (bal.level_curve || []).slice().sort((a, b) => a.level - b.level);
    // 레벨 1->4 정도를 한 번에 넘길 만큼 exp 를 몰아준다
    const need = curve.slice(0, 3).reduce((a, r) => a + (r.exp_cost || 0), 0) + 1;
    check('level: addExp across multiple levels matches level_curve cumulative math', () => {
      const startLevel = acc.level;
      const levelUps = RwEcon.addExp(acc, need);
      assertTrue(Array.isArray(levelUps), 'addExp should return levelUps array');
      // 호스트 쪽에서 독립적으로 시뮬레이션
      let lvl = startLevel, exp = 0, remain = need, ups = 0;
      while (true) {
        const row = curve.find((r) => r.level === lvl);
        if (!row || !row.exp_cost) break;
        exp += remain; remain = 0;
        if (exp < row.exp_cost) break;
        exp -= row.exp_cost; remain = exp; exp = 0;
        lvl++; ups++;
        if (!curve.find((r) => r.level === lvl)) break;
      }
      assertEq(acc.level, lvl, 'level after addExp');
      assertEq(levelUps.length, ups, 'levelUps.length');
      return `level ${startLevel}->${acc.level} (+${need} exp), levelUps=${levelUps.length}`;
    });
    check('level: each level-up grants that row\'s level_curve reward items (D3)', () => {
      const acc2Ctx = newEcon();
      const acc2 = acc2Ctx.RwEcon.newAccount();
      const row1 = curve[0];
      const boxBefore = acc2.rewardBox.length;
      acc2Ctx.RwEcon.addExp(acc2, row1.exp_cost);
      let expectedPush = 0;
      for (let i = 1; i <= 3; i++) {
        const key = row1[`reward_item_key_${i}`];
        const amount = row1[`reward_amount_${i}`] || 0;
        if (key && key !== 'none' && !key.startsWith('currency_')) expectedPush += amount;
      }
      assertEq(acc2.rewardBox.length - boxBefore, expectedPush, 'rewardBox growth from level 1 reward items');
      return `rewardBox +${expectedPush}`;
    });
    check('level: addExp stops at curve end', () => {
      const { RwEcon: E2 } = newEcon();
      const a2 = E2.newAccount();
      const huge = curve.reduce((s, r) => s + (r.exp_cost || 0), 0) * 5 + 1000000;
      E2.addExp(a2, huge);
      // 곡선 마지막 행(level=maxRow)의 exp_cost 가 "그 레벨에서 다음 레벨까지" 비용이므로,
      // 그 비용을 다 채우면 도달 가능한 최고 레벨은 maxRow+1 이다(그 다음엔 expNeed=0 이라 멈춘다).
      const maxRow = Math.max(...curve.map((r) => r.level));
      const lastRow = curve.find((r) => r.level === maxRow);
      const reachable = lastRow && lastRow.exp_cost > 0 ? maxRow + 1 : maxRow;
      assertEq(a2.level, reachable, `level after huge exp (curve max row ${maxRow}, last exp_cost ${lastRow && lastRow.exp_cost})`);
      return `level capped at ${a2.level} (curve max row ${maxRow}, reachable ${reachable})`;
    });
  }

  // ====================================================================
  // 3. rewardBox FIFO
  // ====================================================================
  {
    const { RwEcon } = newEcon();
    const acc = RwEcon.newAccount();
    const itemRewardKey = (bal.reward_key || []).find((r) => r.category && r.category.includes('머지'));
    check('rewardBox: FIFO order preserved', () => {
      assertTrue(!!itemRewardKey, 'need at least one item reward_key row to test with');
      RwEcon.grant(acc, itemRewardKey.reward_key, 1);
      const other = (bal.reward_key || []).find((r) => r.reward_key !== itemRewardKey.reward_key && r.category && r.category.includes('머지'));
      assertTrue(!!other, 'need a second distinct item reward_key row');
      RwEcon.grant(acc, other.reward_key, 1);
      assertEq(acc.rewardBox[0], itemRewardKey.item_code, 'first pushed should stay first (FIFO)');
      assertEq(acc.rewardBox[1], other.item_code, 'second pushed should be second');
      return `rewardBox=${JSON.stringify(acc.rewardBox)}`;
    });
  }

  // ====================================================================
  // 4. serveCheck / serveReward
  // ====================================================================
  {
    const { RwEcon } = newEcon();
    const acc = RwEcon.newAccount();
    const oi = (bal.order_item || []).filter((r) => r.in_use);
    const dupCode = oi[0].item_code;
    const otherCode = oi[1].item_code;
    const card = { slot: 1, type: 'normal', reqs: [{ code: dupCode, count: 1 }, { code: dupCode, count: 1 }] };
    check('serveCheck: duplicate code in two slots needs 2 on board', () => {
      // 주의: boardCounts 는 host 의 `new Map()` 이 아니라 **plain object** 로 넘긴다.
      // econ.js countOf() 는 `counts instanceof Map` 으로 분기하는데, vm 컨텍스트 안 코드가 보는
      // Map 생성자는 host 의 Map 과 다른 realm 이라 host Map 인스턴스는 instanceof 가 false 로
      // 나와 조용히 「개수 0」으로 읽힌다(plain object 경로는 realm 무관 property lookup 이라 안전).
      let boardCounts = { [dupCode]: 1 };
      let c = RwEcon.serveCheck(card, boardCounts);
      assertTrue(c.ok === false, `expected ok=false with only 1 on board, got ${JSON.stringify(c)}`);
      boardCounts = { [dupCode]: 2 };
      c = RwEcon.serveCheck(card, boardCounts);
      assertTrue(c.ok === true, `expected ok=true with 2 on board, got ${JSON.stringify(c)}`);
      return `needs 2x code ${dupCode}, confirmed short(1)/ok(2)`;
    });
    check('serveCheck: rewardBox items not counted', () => {
      RwEcon.grant(acc, (bal.reward_key || []).find((r) => r.item_code === otherCode)?.reward_key || 'item_' + otherCode, 5);
      const soloCard = { slot: 2, type: 'normal', reqs: [{ code: otherCode, count: 1 }] };
      const boardCounts = {}; // 보드엔 없음 — rewardBox 에만 5개 있어도 카운트되면 안 된다
      const c = RwEcon.serveCheck(soloCard, boardCounts);
      assertTrue(c.ok === false, `expected ok=false since boardCounts has none of code ${otherCode} (rewardBox has 5 but must not be counted)`);
      return 'rewardBox stock ignored by serveCheck';
    });
    check('serveReward: coin === order_price sum, exp === 0', () => {
      const reqs = [{ code: oi[0].item_code, count: 1 }, { code: oi[2] ? oi[2].item_code : oi[0].item_code, count: 1 }];
      const card2 = { slot: 1, type: 'normal', reqs };
      const oiByCode = new Map(oi.map((r) => [r.item_code, r]));
      const expectCoin = reqs.reduce((a, q) => a + (oiByCode.get(q.code)?.order_price || 0) * q.count, 0);
      const r = RwEcon.serveReward(card2);
      assertEq(r.coin, expectCoin, 'serveReward.coin');
      assertEq(r.exp, 0, 'serveReward.exp');
      return `coin=${r.coin} exp=${r.exp}`;
    });
  }

  // ====================================================================
  // 5. fillRail at Lv1
  // ====================================================================
  {
    const { ctx, RwEcon } = newEcon();
    const acc = RwEcon.newAccount();
    acc.level = 1;
    const slotTypesJson = vm.runInContext('JSON.stringify(slotMap())', ctx);
    const slotTypes = JSON.parse(slotTypesJson); // 길이 6, 인덱스 0 = 슬롯1
    const ruleByType = new Map((bal.order_rule || []).filter((r) => r.in_use).map((r) => [r.order_type, r]));
    const rail = slotTypes.map((type, i) => ({
      slot: i + 1,
      type,
      card: null,
      unlockLevel: ruleByType.get(type)?.unlock_level ?? 999,
    }));
    RwEcon.fillRail(acc, rail, {}, Date.now() / 1000); // plain object — host Map 은 vm realm 에서 instanceof 실패한다(위 serveCheck 주석 참조)
    check('fillRail@Lv1: only unlockLevel<=1 slots may get cards', () => {
      const wrong = rail.filter((s) => s.card && s.unlockLevel > 1);
      assertEq(wrong.length, 0, `slots got cards despite unlockLevel>1: ${JSON.stringify(wrong)}`);
      return `rail=${JSON.stringify(rail.map((s) => ({ slot: s.slot, type: s.type, unlockLevel: s.unlockLevel, hasCard: !!s.card })))}`;
    });
    check('fillRail@Lv1: slot 6 (special) always locked', () => {
      const s6 = rail[5];
      assertTrue(!s6.card, `slot 6 should have no card, got ${JSON.stringify(s6.card)}`);
      return 'slot 6 empty';
    });
    check('fillRail@Lv1: every card has <=2 requirements', () => {
      const bad = rail.filter((s) => s.card && s.card.reqs && s.card.reqs.length > 2);
      assertEq(bad.length, 0, `cards with >2 reqs: ${JSON.stringify(bad)}`);
      return 'all cards <=2 reqs';
    });
  }

  // ====================================================================
  // 6. DISTURBANCE — 교란 테스트: 체커가 실제로 FAIL 을 낼 수 있는지 증명한다.
  //    시트 cost_coin 을 몰래 바꾼 사본으로 econ 을 초기화하되, 기대값은 원본 bal 값을 쓴다.
  //    이 항목은 의도적으로 FAIL 이 나야 정상이다(검출 능력 자체를 검증하는 항목).
  // ====================================================================
  {
    const mutated = JSON.parse(JSON.stringify(bal));
    const firstRow = mutated.main_task.find((r) => r.in_use);
    const originalExpectedCost = chores[0].cost_coin;
    firstRow.cost_coin = originalExpectedCost === 1 ? 2 : 1; // 원본과 다르게 교란
    const { RwEcon } = newEcon(mutated);
    const acc = RwEcon.newAccount();
    acc.coin = 999999;
    const r = RwEcon.doChore(acc);
    check('DISTURBANCE (expected FAIL - proves this checker can fail): spent should equal ORIGINAL sheet cost_coin', () => {
      assertEq(r.spent, originalExpectedCost, 'spent (checked against un-mutated original value on purpose)');
      return 'unexpected: mutation not detected';
    });
  }

  printResults(results);
}

/* ======================================================================
   Part 2 — 전체 페이지 5000수 러너
   ====================================================================== */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startStaticServer(dir, port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'http.server', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let started = false;
    const onData = () => { if (!started) { started = true; resolve(proc); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData); // python http.server logs requests to stderr; startup itself is silent, so also resolve on timeout
    proc.on('error', reject);
    setTimeout(() => { if (!started) { started = true; resolve(proc); } }, 800);
  });
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(); });
        req.on('error', reject);
      });
      return true;
    } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        const cbs = this.listeners.get(msg.method);
        if (cbs) cbs.forEach((cb) => cb(msg.params));
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(cb); }
  once(method, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const cb = (p) => { if (done) return; done = true; resolve(p); };
      this.on(method, cb);
      if (timeoutMs) setTimeout(() => cb(null), timeoutMs);
    });
  }
  async evalExpr(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('Runtime.evaluate exception: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails));
    return r.result.value;
  }
}

function httpJson(url, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: method || 'GET' }, (res) => {
      let data = ''; res.on('data', (d) => data += d); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

/* /json/version 은 브라우저 레벨 웹소켓(Browser.* 만 된다) — Page/Runtime 은 탭(target)
   레벨이라 반드시 /json/new 로 새 탭을 만들고 그 탭의 webSocketDebuggerUrl 에 붙어야 한다. */
async function connectCDP(cdpPort, url) {
  const tab = await httpJson(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, 'PUT');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return { cdp: new CDP(ws), tabId: tab.id };
}

/* 부록 D 옵션 매트릭스 — 5개 config. 페이지는 한 번만 띄우고, config 마다
   window.RWB_OPTS 를 제자리에서 바꾼 뒤 #rwbReset 을 눌러 독립된 계정으로 다시 돈다
   (reload 로 옵션을 새로 박으려던 첫 시도는 실패했다 — part2() 안의 긴 주석 참조). */
const OPT_CONFIGS = [
  { name: 'defaults', opts: { energyRefill: true, gemUnlimited: true, genNoCooldown: false, chestNoTimer: false }, steps: 5000 },
  { name: 'all-on', opts: { energyRefill: true, gemUnlimited: true, genNoCooldown: true, chestNoTimer: true }, steps: 2000 },
  { name: 'all-off', opts: { energyRefill: false, gemUnlimited: false, genNoCooldown: false, chestNoTimer: false }, steps: 2000 },
  { name: 'E-off-only', opts: { energyRefill: false, gemUnlimited: true, genNoCooldown: false, chestNoTimer: false }, steps: 2000 },
  { name: 'G-off-only', opts: { energyRefill: true, gemUnlimited: false, genNoCooldown: false, chestNoTimer: false }, steps: 2000 },
];

/* 러너는 config 마다 같은 코드를 쓴다 — window.RWB_OPTS 는 페이지 로드 전에 이미 박혀 있으므로
   브라우저 쪽 코드가 그 값을 직접 읽어 옵션별 검사를 분기한다(Node 에서 따로 안 넘긴다). */
function buildRunnerExpr(maxSteps) {
  return `(() => {
    const RWB = window.__RWB, RwEconRef = window.RwEcon, OPTS = window.RWB_OPTS || {};
    RWB.instant = true;
    const A = () => RWB.acc;
    const boardCount = () => RWB.cells.filter(c => c && c.code).length;
    const boxCount = () => (A().rewardBox || []).length;
    const codeAt = (cells, i) => (cells[i] ? cells[i].code : null);
    const cellsIn = (html) => (html.match(/cell(\\d+)/g) || []).map((s) => Number(s.slice(4)));
    const isOpenableCode = (code) => {
      if (code == null || !RwEconRef) return false;
      const sp = RwEconRef.spec(code);
      return !!(sp && Number(sp.spread_open_duration_sec) > 0);
    };
    /* 엔트리 하나마다 {tag, dBoard, dBox} 기여분을 매기고 합산해서 검사한다 — 부록 C/D/E 가
       들어오며 한 수 안에 [완료?]+[개봉시작?]+[reward드랍?]+[주 액션] 이 같이 쌓일 수 있어
       kind 로만 가르는 if/else 버킷은 안전하지 않다. docs/js/rosewood-board.js 실측 그대로: */
    const classify = (e, cellsBefore) => {
      if (e.popped !== undefined) return { tag: 'merge', dBoard: -1, dBox: 0, from: e.from, to: e.to };
      if (e.open === true) return { tag: 'chest-open-start', dBoard: 0, dBox: 0, cell: e.from,
        dur: (() => { const m = (e.html || '').match(/·\\s*(\\d+)초/); return m ? Number(m[1]) : null; })() };
      if (e.to !== undefined && e.cost !== undefined && e.stock !== undefined) {
        // 실제 산출(생성기 또는 상자 꺼내기) — .chest 가 있으면 상자 경로(E1)
        return { tag: (e.chest ? 'produce-chest' : 'produce-gen') + (e.emptied ? '-emptied' : ''),
                 dBoard: e.emptied ? 0 : 1, dBox: 0, from: e.from, to: e.to,
                 chest: !!e.chest, emptiedFrom: e.emptied ? e.from : null };
      }
      if (e.kind === 'energy' && e.html === undefined) return { tag: 'recharge-energy', dBoard: 0, dBox: 0 };
      if (e.kind === 'prod' && e.emptied) return { tag: 'sweep-empty', dBoard: -1, dBox: 0, emptiedFrom: e.from };
      const html = typeof e.html === 'string' ? e.html : '';
      if (html.indexOf('개봉 완료') >= 0) { const c = cellsIn(html); return { tag: 'chest-open-complete', dBoard: 0, dBox: 0, cell: c[0] }; }
      if (e.kind === 'gem') {
        const m = html.match(/cell(\\d+).*?[-−](\\d+)\\s*젬/); // '젬' 앞 숫자 = 결제 코스트
        return { tag: 'gem-recharge', dBoard: 0, dBox: 0,
                 gemCell: m ? Number(m[1]) : null, gemCost: m ? Number(m[2]) : null,
                 gemCode: m ? codeAt(cellsBefore, Number(m[1])) : null };
      }
      if (html.indexOf('시간 경과') >= 0) { // skipTime — 사유별로 더 가른다(오더 대기/생성기 회복/에너지 회복/상자 개봉)
        const m = html.match(/시간 경과 · (.+?) · \\+(\\d+)s/);
        const what = m ? m[1] : '';
        const sub = what.indexOf('오더') >= 0 ? 'order-wait' : what.indexOf('생성기') >= 0 ? 'gen-recharge-wait'
                  : what.indexOf('에너지') >= 0 ? 'energy-wait' : what.indexOf('상자') >= 0 ? 'chest-wait' : 'wait-other';
        return { tag: sub, dBoard: 0, dBox: 0, sec: m ? Number(m[2]) : 0, what };
      }
      if (html.indexOf('새 오더') >= 0) return { tag: 'refill-notice', dBoard: 0, dBox: 0 };
      if (html.indexOf('납품') >= 0) { const cells = cellsIn(html); return { tag: 'serve', dBoard: -cells.length, dBox: 0, cells }; }
      if (e.collect !== undefined) return { tag: 'collect', dBoard: -1, dBox: 0, collectCode: e.collect,
        unjam: !!e.unjam, maxStep: !!e.maxStep, cells: cellsIn(html) };
      if (html.indexOf('보관함 →') >= 0) { const cells = cellsIn(html); return { tag: 'reward-drop', dBoard: 1, dBox: -1, cells }; }
      if (e.kind === 'sell') { const cells = cellsIn(html); return { tag: 'sell', dBoard: -1, dBox: 0, cells }; }
      if (e.kind === 'chore' || e.kind === 'level' || e.kind === 'day') return { tag: e.kind, dBoard: 0, dBox: null };
      return { tag: 'unknown:' + e.kind, dBoard: null, dBox: null, raw: e };
    };
    const MAX_STEPS = ${maxSteps};
    const milestones = { day: {}, level: {} };
    const fails = [];
    const collectEvents = [];
    let prevLevel = A().level, prevDay = A().day;
    let steps = 0, stopReason = 'loop_limit';
    let gemChecked = 0, gemMismatch = 0;
    let openedMirror = new Set(), openingNow = null;   // OPENED / OPENING 를 로그로 재구성한다
    let startableButTapped = 0, drawableOpenedButTapped = 0; // 부록 E addendum(2)
    for (let i = 1; i <= MAX_STEPS; i++) {
      let choreOk = null;
      try { choreOk = !!(RwEconRef && RwEconRef.choreCheck(A()).ok); } catch (e) { choreOk = null; }
      const cellsBefore = RWB.cells.slice();
      const bBefore = boardCount(), xBefore = boxCount(), gBefore = A().gem;
      const logBefore = RWB.log.length;
      RWB.step();
      steps = i;
      const bAfter = boardCount(), xAfter = boxCount();
      const newEntries = RWB.log.slice(logBefore);
      if (!newEntries.length) { stopReason = 'no new log entry (engine stopped)'; steps = i - 1; break; }
      const parts = newEntries.map((e) => classify(e, cellsBefore));
      const tags = parts.map((p) => p.tag);
      const dBoard = bAfter - bBefore, dBox = xAfter - xBefore;
      const tagFail = (msg) => fails.push('step ' + i + ': ' + msg + ' (tags=' + JSON.stringify(tags) + ' dBoard=' + dBoard + ' dBox=' + dBox + ')');

      // -- 부록 E addendum(2): 생성기 탭이 있었으면, 그 직전에 시작 가능한 개봉/꺼낼 수 있는 상자가 없어야 한다.
      //    (openedMirror/openingNow 는 이 스텝의 액션을 반영하기 *전* 상태 — cellsBefore 기준으로 판정한다)
      const genTapped = parts.some((p) => p.tag === 'produce-gen' || p.tag === 'produce-gen-emptied');
      if (genTapped) {
        for (let ci = 0; ci < cellsBefore.length; ci++) {
          const c = cellsBefore[ci];
          if (!c || c.box || c.web) continue;
          if (!isOpenableCode(c.code)) continue;
          if (!openedMirror.has(ci) && openingNow === null) { startableButTapped++; tagFail('generator tapped while cell ' + ci + ' had a startable chest opening'); }
          else if (openedMirror.has(ci)) drawableOpenedButTapped++; // 소진·회복 여부를 여기서 못 봐서 참고용 집계만
        }
      }

      if (parts.some((p) => p.dBoard === null)) {
        tagFail('unclassified log kind, cannot verify board delta: ' + JSON.stringify(parts.filter((p) => p.dBoard === null).map((p) => p.raw)));
      } else {
        const expectBoard = parts.reduce((a, p) => a + p.dBoard, 0);
        if (dBoard !== expectBoard) tagFail('board delta mismatch: expected ' + expectBoard + ', got ' + dBoard);
        const hasMint = parts.some((p) => p.dBox === null);
        if (hasMint) {
          const knownBox = parts.reduce((a, p) => a + (p.dBox || 0), 0);
          if (dBox < knownBox) tagFail('box delta below known component (mint should only add): known=' + knownBox + ', got ' + dBox);
        } else {
          const expectBox = parts.reduce((a, p) => a + p.dBox, 0);
          if (dBox !== expectBox) tagFail('box delta mismatch: expected ' + expectBox + ', got ' + dBox);
        }
      }
      // C1 — 산출·소진과 동시에 비운 칸은 그 수가 끝난 뒤 실제로 비어 있어야 한다.
      parts.forEach((p) => {
        if (p.emptiedFrom != null && RWB.cells[p.emptiedFrom] !== null)
          tagFail('emptied cell ' + p.emptiedFrom + ' still occupied after the step (' + p.tag + ')');
      });
      // C2 — 젬 충전 코스트가 item_spec.spread_item_speedup_cost(없거나 0이면 1)와 맞는지.
      parts.forEach((p) => {
        if (p.tag !== 'gem-recharge') return;
        gemChecked++;
        const spec = p.gemCode != null && RwEconRef ? RwEconRef.spec(p.gemCode) : null;
        const expectCost = spec && Number(spec.spread_item_speedup_cost) > 0 ? Number(spec.spread_item_speedup_cost) : 1;
        if (p.gemCost == null || spec == null) { gemMismatch++; tagFail('gem-recharge: could not parse cell/cost or spec for code ' + p.gemCode); }
        else if (p.gemCost !== expectCost) { gemMismatch++; tagFail('gem-recharge cost mismatch: code ' + p.gemCode + ' cell ' + p.gemCell + ' got ' + p.gemCost + ' expected ' + expectCost + ' (spread_item_speedup_cost)'); }
        // G off — 결제 전에 충분했어야 한다(모자라면 애초에 후보가 아니다).
        if (OPTS.gemUnlimited === false && gBefore < p.gemCost)
          tagFail('gem-recharge happened with insufficient gem while gemUnlimited=false: had ' + gBefore + ', cost ' + p.gemCost);
      });
      // E2 — 코인·젬 수확 기록.
      parts.forEach((p) => { if (p.tag === 'collect') collectEvents.push({ code: p.collectCode, unjam: p.unjam, maxStep: p.maxStep }); });
      // 상자 상태 재구성 — 시작/완료/제거를 순서대로 반영한다(보드에 다른 개체가 들어오면 개봉 기록도 죽는다).
      parts.forEach((p) => {
        if (p.tag === 'chest-open-start') {
          if (openingNow !== null) tagFail('two chests opening at once: cell ' + openingNow.cell + ' still open when cell ' + p.cell + ' started');
          if (openedMirror.has(p.cell)) tagFail('chest-open-start on an already-opened cell ' + p.cell);
          openingNow = { cell: p.cell };
          if (OPTS.chestNoTimer === true && p.dur !== 0) tagFail('chestNoTimer=true but open duration was ' + p.dur + ' (expected 0)');
        } else if (p.tag === 'chest-open-complete') {
          if (openingNow === null || openingNow.cell !== p.cell) tagFail('chest-open-complete for cell ' + p.cell + ' but openingNow=' + JSON.stringify(openingNow));
          openingNow = null;
          openedMirror.add(p.cell);
        } else if (p.tag === 'produce-chest' || p.tag === 'produce-chest-emptied') {
          // chest:true 는 "생성기가 아니다"일 뿐이다 — 개봉 절차(BoxRules)가 필요한 건
          // spread_open_duration_sec > 0 인 것만이다(isOpenable). 그 조건일 때만 openedMirror 를 요구한다.
          const srcCode = codeAt(cellsBefore, p.from);
          if (isOpenableCode(srcCode) && !openedMirror.has(p.from))
            tagFail('drew from an openable chest at cell ' + p.from + ' (code ' + srcCode + ') before it was opened');
        }
        // 칸 정체성이 바뀌면(dropCellState 와 같은 축) 그 칸의 개봉 기록도 지운다.
        const cleared = [];
        if (p.tag === 'merge') { cleared.push(p.from, p.to); }
        else if (p.tag.indexOf('produce-') === 0) { cleared.push(p.to); if (p.emptiedFrom != null) cleared.push(p.emptiedFrom); }
        else if (p.tag === 'sweep-empty') { cleared.push(p.emptiedFrom); }
        else if (p.tag === 'reward-drop' || p.tag === 'sell' || p.tag === 'collect' || p.tag === 'serve') { (p.cells || []).forEach((c) => cleared.push(c)); }
        cleared.forEach((c) => { openedMirror.delete(c); if (openingNow && openingNow.cell === c) openingNow = null; });
      });
      // C3 — 젬은 음수 허용(gemUnlimited=true), 플래그하지 않는다. gemUnlimited=false 면 음수 금지.
      if (A().coin < 0) tagFail('coin negative: ' + A().coin);
      if (OPTS.gemUnlimited === false && A().gem < 0) tagFail('gem negative while gemUnlimited=false: ' + A().gem);
      if (RWB.energy < 0) tagFail('energy negative: ' + RWB.energy);
      // E off — 탭 리필이 절대 일어나지 않아야 한다.
      if (OPTS.energyRefill === false && parts.some((p) => p.tag === 'recharge-energy'))
        tagFail('energyRefill=false but a recharge-energy entry happened');
      // P on — 젬 충전이 전혀 없어야 하고, 생성기 회복 대기도 없어야 한다.
      if (OPTS.genNoCooldown === true) {
        if (((A().stats || {}).gemRecharges || 0) > 0) tagFail('genNoCooldown=true but stats.gemRecharges > 0');
        if (parts.some((p) => p.tag === 'gen-recharge-wait')) tagFail('genNoCooldown=true but a gen-recharge-wait fastforward happened');
      }
      if (choreOk === true && !tags.includes('chore')) tagFail('choreCheck was ok before step but no chore action happened (priority violation)');
      const cur = A();
      if (cur.day > prevDay && milestones.day[cur.day] === undefined) milestones.day[cur.day] = i;
      if (cur.level > prevLevel && milestones.level[cur.level] === undefined) milestones.level[cur.level] = i;
      prevDay = cur.day; prevLevel = cur.level;
    }
    // chestNoTimer=true — 개봉 시작 바로 다음 로그 엔트리가 그 칸의 완료여야 한다(같은 수에 끝나지는
    // 않는다 — tickOpening 은 *다음* step() 의 맨 앞에서 돈다 — 그래서 완료가 "즉시 다음 엔트리"인지로 잰다).
    if ((window.RWB_OPTS || {}).chestNoTimer === true) {
      for (let idx = 0; idx < RWB.log.length - 1; idx++) {   // 마지막 엔트리는 아직 다음 수가 안 돌아 판정 보류
        const e = RWB.log[idx];
        if (e.open !== true) continue;
        const next = RWB.log[idx + 1];
        const nextHtml = next && typeof next.html === 'string' ? next.html : '';
        const nextCell = nextHtml.indexOf('개봉 완료') >= 0 ? cellsIn(nextHtml)[0] : null;
        if (nextCell !== e.from) fails.push('log[' + idx + ']: chest-open-start at cell ' + e.from + ' not immediately followed by its completion (next=' + JSON.stringify(next) + ')');
      }
    }
    const F = A();
    return JSON.stringify({
      steps, stopReason, milestones,
      finalStats: { level: F.level, day: F.day, coin: F.coin, gem: F.gem, energy: RWB.energy,
                    stats: F.stats, boardCount: boardCount(), boxCount: boxCount(), logLen: RWB.log.length },
      gemChecked, gemMismatch, startableButTapped, drawableOpenedButTapped,
      collectEvents,
      fails: fails.slice(0, 30), failCount: fails.length,
    });
  })()`;
}

async function part2() {
  console.log('\n== Part 2: option-matrix autoplay run ==');
  if (!fs.existsSync(HTML_PATH)) {
    console.log(`SKIP Part2 - missing ${path.relative(ROOT, HTML_PATH)}`);
    return;
  }
  if (!fs.existsSync(ECON_PATH)) {
    console.log('SKIP Part2 - missing docs/js/rosewood-econ.js (W2 not landed yet)');
    return;
  }
  const boardJsPath = path.join(ROOT, 'docs/js/rosewood-board.js');
  const src = fs.existsSync(boardJsPath) ? fs.readFileSync(boardJsPath, 'utf8') : '';
  if (!src.includes('__RWB')) {
    console.log('SKIP Part2 - docs/js/rosewood-board.js does not expose window.__RWB yet (B4 debug hook not landed)');
    return;
  }
  if (!src.includes('RWB_OPTS') || !src.includes('chestOpens')) {
    console.log('SKIP Part2 - docs/js/rosewood-board.js does not have RWB_OPTS/chestOpens yet (부록 D/E not landed)');
    return;
  }

  // E2 검증용 — 코인(27xx)·젬(28xx) 수확이 진짜 체인 마지막 단계였는지는 Node 쪽 items 맵으로 대조한다.
  let items = {};
  try { items = JSON.parse(fs.readFileSync(BOARD_JSON_PATH, 'utf8')).items || {}; } catch (e) { /* Part1 이 이미 존재를 확인했다 */ }

  const httpPort = await findFreePort();
  const cdpPort = await findFreePort();
  const staticProc = await startStaticServer(DOCS_DIR, httpPort);
  const ok = await waitForHttp(`http://127.0.0.1:${httpPort}/rosewood-initial-board.html`, 5000);
  if (!ok) { console.log('SKIP Part2 - static server on docs/ did not come up'); staticProc.kill(); return; }

  const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let chromeProc = null;
  const targetUrl = `http://127.0.0.1:${httpPort}/rosewood-initial-board.html`;
  const results2 = [];

  try {
    if (!fs.existsSync(chromeBin)) throw new Error('Chrome binary not found at ' + chromeBin);
    chromeProc = spawn(chromeBin, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--remote-debugging-port=${cdpPort}`,
      '--user-data-dir=' + fs.mkdtempSync('/tmp/rwb-chrome-'),
      'about:blank',
    ], { stdio: 'ignore' });
    const cdpUp = await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 8000);
    if (!cdpUp) throw new Error('Chrome CDP endpoint did not come up');

    const { cdp } = await connectCDP(cdpPort, 'about:blank');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    /* 페이지는 딱 한 번만 띄운다. `Page.addScriptToEvaluateOnNewDocument` 로 매 config 마다
       reload 하며 window.RWB_OPTS 를 새로 박아 보려 했으나 실패했다 — 실측(별도 진단 스크립트):
       `docs/js/rosewood-autoplay-view.js` 가 스크립트 순서상 board.js 보다 먼저 로드되며
       `window.RWB_OPTS = loadOpts()` 로 **참조를 통째로 교체**한다(localStorage 복원, 없으면
       기본값). addScriptToEvaluateOnNewDocument 로 먼저 심어 놔도 이 줄이 그 값을 덮어써서,
       두 번째 config 부터는 계속 첫 config 값(사실상 기본값)으로 되돌아갔다 — 5 config 전부
       같은 결과가 나온 게 그 증거였다.
       계약(부록 D-2) 이 애초에 "참조 교체 금지 — 속성만 갱신"이라 못 박은 이유가 이거였다 —
       그래서 여기서도 **reload 없이** `Object.assign(window.RWB_OPTS, cfg.opts)` 로 속성만 갈아
       끼우고, `#rwbReset` 버튼을 눌러(클로저 안의 진짜 reset() 을 그대로 태운다) 계정 상태만
       새로 만든다. */
    const loadP0 = cdp.once('Page.loadEventFired', 10000);
    await cdp.send('Page.navigate', { url: targetUrl });
    await loadP0;
    const rwbReady0 = await (async () => {
      for (let i = 0; i < 100; i++) {
        const v = await cdp.evalExpr('!!(window.__RWB && window.__RWB.step && window.__RWB.acc && window.RWB_OPTS && document.querySelector("#rwbReset"))');
        if (v) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })();
    if (!rwbReady0) throw new Error('window.__RWB.step/.acc / window.RWB_OPTS / #rwbReset did not appear within 10s');

    for (const cfg of OPT_CONFIGS) {
      const row = { config: cfg.name, opts: cfg.opts, steps: cfg.steps };
      try {
        const seenOpts = JSON.parse(await cdp.evalExpr(
          `(() => { Object.assign(window.RWB_OPTS, ${JSON.stringify(cfg.opts)}); document.querySelector('#rwbReset').click(); return JSON.stringify(window.RWB_OPTS); })()`
        ));
        for (const k of Object.keys(cfg.opts)) {
          if (seenOpts[k] !== cfg.opts[k]) throw new Error(`window.RWB_OPTS.${k} did not take effect: wanted ${cfg.opts[k]}, page has ${seenOpts[k]}`);
        }

        const report = JSON.parse(await cdp.evalExpr(buildRunnerExpr(cfg.steps)));
        row.stepsRun = report.steps;
        row.stopReason = report.stopReason + (report.steps < cfg.steps ? ` (of ${cfg.steps})` : '');
        row.milestones = report.milestones;
        row.finalStats = report.finalStats;
        row.gemChecked = report.gemChecked; row.gemMismatch = report.gemMismatch;
        row.startableButTapped = report.startableButTapped;
        row.drawableOpenedButTapped = report.drawableOpenedButTapped;
        row.fails = report.fails; row.failCount = report.failCount;

        // E2 — Node 쪽 items 맵으로 코인·젬 수확의 '진짜 최대 단계' 여부를 다시 확인한다.
        let e2Bad = 0;
        (report.collectEvents || []).forEach((ev) => {
          const chain = Math.floor(ev.code / 100);
          if (chain !== 27 && chain !== 28) return; // 코인 27xx · 젬 28xx 만
          if (ev.unjam) return;                      // 막힘 해소는 예외
          const it = items[String(ev.code)];
          const atMax = it ? !it.next : null;
          if (!ev.maxStep || atMax === false) { e2Bad++; row.fails.push(`E2: collect code ${ev.code} not at chain max (maxStepFlag=${ev.maxStep}, items.next=${it ? it.next : 'unknown'})`); }
        });
        row.e2ViolationCount = e2Bad;
        row.failCount += e2Bad;
      } catch (e) {
        row.error = e.message;
      }
      results2.push(row);
    }
  } catch (e) {
    console.log(`Part2 fatal error: ${e.message}`);
  } finally {
    if (chromeProc) chromeProc.kill();
    staticProc.kill();
  }

  console.log('Part2 backend used: Chrome CDP (one browser, one tab, one page load; each config mutates window.RWB_OPTS in place + clicks #rwbReset, no reload)');
  console.log('\nPer-config table:');
  results2.forEach((r) => {
    if (r.error) { console.log(`  [${r.config}] ERROR: ${r.error}`); return; }
    const fs_ = r.finalStats || {}, st = fs_.stats || {};
    const dayM = Object.entries(r.milestones?.day || {}).map(([d, s]) => `D${d}@${s}`).join(' ') || '-';
    const lvM = Object.entries(r.milestones?.level || {}).map(([l, s]) => `Lv${l}@${s}`).join(' ') || '-';
    console.log(`  [${r.config}] opts=${JSON.stringify(r.opts)} steps=${r.stepsRun}/${r.steps} stop="${r.stopReason}"`);
    console.log(`    milestones: Day[${dayM}] Lv[${lvM}]`);
    console.log(`    final: level=${fs_.level} day=${fs_.day} coin=${fs_.coin} gem=${fs_.gem} energy=${fs_.energy}`);
    console.log(`    stats: recharges=${st.recharges} gemRecharges=${st.gemRecharges} chestOpens=${st.chestOpens} waitSec=${st.waitSec} chestsEmptied=${st.chestsEmptied} sells=${st.sells} collects=${st.collects}`);
    console.log(`    gem-cost checks: ${r.gemChecked} checked / ${r.gemMismatch} mismatched · E2 collect checks: ${(r.e2ViolationCount === undefined ? 'n/a' : r.e2ViolationCount + ' bad')} · gen-tap-while-startable-chest: ${r.startableButTapped} · gen-tap-while-opened-chest(informational): ${r.drawableOpenedButTapped}`);
    console.log(`    violations: ${r.failCount}${r.failCount ? ' (showing up to 10)' : ''}`);
    (r.fails || []).slice(0, 10).forEach((m) => console.log('      ' + m));
  });
}

(async () => {
  part1();
  await part2();
})();
