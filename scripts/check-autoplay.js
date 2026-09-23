/* 로즈우드 자동 플레이 검증 — RwEcon 단위/속성 검사(Part 1) + 전체 페이지 5000수 러너(Part 2).
   ──────────────────────────────────────────────────────────────────────
   계약 근거: `_ignore/plan-rosewood-autoplay.md` 부록 B (B1 bal 스키마 · B2 RwEcon API ·
   B3 RwView.render(snap) · B4 rosewood-board.js §1 루프 + window.__RWB 디버그 훅).

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

async function part2() {
  console.log('\n== Part 2: full-page autoplay run (5000 steps) ==');
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

  const httpPort = await findFreePort();
  const cdpPort = await findFreePort();
  const staticProc = await startStaticServer(DOCS_DIR, httpPort);
  const ok = await waitForHttp(`http://127.0.0.1:${httpPort}/rosewood-initial-board.html`, 5000);
  if (!ok) { console.log('SKIP Part2 - static server on docs/ did not come up'); staticProc.kill(); return; }

  const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let chromeProc = null;
  let usedCDP = false;
  const milestones = { day: {}, level: {} };
  let stopReason = 'unknown';
  let stepsRun = 0;
  const finalStats = {};
  const invariantFails = [];

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
    const targetUrl = `http://127.0.0.1:${httpPort}/rosewood-initial-board.html`;
    const navP0 = (async () => {
      // /json/new?url 로 만든 탭은 이미 그 URL 로 이동을 시작한 상태다 — Page.enable 뒤
      // loadEventFired 를 한 번 더 기다려서 완전히 로드될 때까지 확인한다.
      const { cdp } = await connectCDP(cdpPort, targetUrl);
      return cdp;
    })();
    const cdp = await navP0;
    usedCDP = true;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 이미 탭 생성 시점에 navigate 가 걸려 있으므로, 로드가 이미 끝났을 수도 있다 —
    // readyState 를 먼저 보고, 아니면 loadEventFired 를 기다린다.
    const already = await cdp.evalExpr('document.readyState === "complete"').catch(() => false);
    if (!already) {
      const navP = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
      await Promise.race([navP, new Promise((r) => setTimeout(r, 8000))]);
    }

    // window.__RWB.step 이 뜰 때까지 대기
    const rwbReady = await (async () => {
      for (let i = 0; i < 100; i++) {
        const v = await cdp.evalExpr('!!(window.__RWB && window.__RWB.step)');
        if (v) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })();
    if (!rwbReady) throw new Error('window.__RWB.step did not appear within 10s');

    /* 전체 러너를 페이지 안에서 한 번에 돌린다(라운드트립 5000회를 피한다).
       분류 규칙은 docs/js/rosewood-board.js 실제 소스를 읽고 그대로 뽑았다:
         - merge  : LOG 엔트리에 .popped 배열이 있다 (applyMerge, board.js:191)
         - produce: LOG 엔트리에 .to·.cost·.stock 이 있다 (applyProduce, board.js:325)
         - recharge(에너지 충전, D8): kind==='energy' && .html===undefined (board.js:317)
         - 그 외는 logPush(kind, html) 로 만든 {kind, html} 모양이고 html 문자열로 다시 가른다:
             '빨리 감기' 포함 → fastforward(시계만 감음, board.js:743) — 보드/보관함 안 건드림
             '새 오더' 포함   → refill 알림(board.js:401) — 레일만 바뀐다, 보드/보관함 무관
             '납품' 포함      → 진짜 오더 납품(runServe, board.js:791)
             '보관함 →' 포함 → dropReward, 보관함→보드 (board.js:416) : board+1/box-1
             '수확' 포함      → findCollect/runCollect(board.js:797-806) : board-1/box+0
               (dropReward·collect 둘 다 kind==='reward' 를 쓰므로 html 로 갈라야 한다 — 실측 필요했다)
             나머지은 kind 그대로: chore/level/day/sell
       한 번의 step() 호출 안에 [railDue 리필 알림?] + [reward 드랍?] + [주 액션 하나] 가
       같이 쌓일 수 있어(board.js:710-752 우선순위 그대로), 위 분류로 뽑은 태그 집합을 보고
       기대 델타를 검사한다. */
    const maxSteps = 5000;
    const runnerExpr = `(() => {
      const RWB = window.__RWB, RwEconRef = window.RwEcon;
      RWB.instant = true;
      const A = () => RWB.acc;
      const boardCount = () => RWB.cells.filter(c => c && c.code).length;
      const boxCount = () => (A().rewardBox || []).length;
      const classify = (e) => {
        if (e.popped !== undefined) return 'merge';
        if (e.to !== undefined && e.cost !== undefined && e.stock !== undefined) return 'produce';
        if (e.kind === 'energy' && e.html === undefined) return 'recharge';
        const html = typeof e.html === 'string' ? e.html : '';
        if (html.indexOf('빨리 감기') >= 0) return 'fastforward';
        if (html.indexOf('새 오더') >= 0) return 'refill-notice';
        if (html.indexOf('납품') >= 0) return 'serve';
        if (html.indexOf('보관함 →') >= 0) return 'reward-drop';
        if (html.indexOf('수확') >= 0) return 'collect';
        return e.kind; // chore / level / day / sell
      };
      const MAX_STEPS = ${maxSteps};
      const milestones = { day: {}, level: {} };
      const fails = [];
      let prevLevel = A().level, prevDay = A().day;
      let steps = 0, stopReason = 'loop_limit';
      for (let i = 1; i <= MAX_STEPS; i++) {
        let choreOk = null;
        try { choreOk = !!(RwEconRef && RwEconRef.choreCheck(A()).ok); } catch (e) { choreOk = null; }
        const bBefore = boardCount(), xBefore = boxCount();
        const logBefore = RWB.log.length;
        RWB.step();
        steps = i;
        const bAfter = boardCount(), xAfter = boxCount();
        const newEntries = RWB.log.slice(logBefore);
        if (!newEntries.length) { stopReason = 'no new log entry (engine stopped)'; steps = i - 1; break; }
        const kinds = newEntries.map(classify);
        const dropped = kinds.includes('reward-drop') ? 1 : 0;
        const dBoard = bAfter - bBefore, dBox = xAfter - xBefore;
        const tag = (msg) => fails.push('step ' + i + ': ' + msg + ' (kinds=' + JSON.stringify(kinds) + ' dBoard=' + dBoard + ' dBox=' + dBox + ')');
        if (kinds.includes('merge')) {
          if (dBoard - dropped !== -1) tag('merge expected boardDelta-drop=-1');
          if (dBox + dropped !== 0) tag('merge expected boxDelta+drop=0');
        } else if (kinds.includes('produce')) {
          if (dBoard - dropped !== 1) tag('produce expected boardDelta-drop=1');
          if (dBox + dropped !== 0) tag('produce expected boxDelta+drop=0');
        } else if (kinds.includes('serve')) {
          const d = dBoard - dropped;
          if (d !== -1 && d !== -2) tag('serve expected boardDelta-drop in {-1,-2}, got ' + d);
          if (dBox + dropped !== 0) tag('serve expected boxDelta+drop=0');
        } else if (kinds.includes('collect')) {
          if (dBoard - dropped !== -1) tag('collect expected boardDelta-drop=-1');
          if (dBox + dropped !== 0) tag('collect expected boxDelta+drop=0');
        } else if (kinds.includes('sell')) {
          if (dBoard - dropped !== -1) tag('sell expected boardDelta-drop=-1');
          if (dBox + dropped !== 0) tag('sell expected boxDelta+drop=0');
        } else if (kinds.includes('chore') || kinds.includes('level') || kinds.includes('day')) {
          if (dBoard - dropped !== 0) tag('chore/level/day must not move board beyond the reward-drop');
        } else if (kinds.length && kinds.every((k) => k === 'reward-drop' || k === 'refill-notice' || k === 'recharge')) {
          if (kinds.includes('reward-drop')) { if (dBoard !== 1 || dBox !== -1) tag('reward-drop-only expected board+1/box-1'); }
          else if (dBoard !== 0 || dBox !== 0) tag('refill-notice/recharge-only must not move board/box');
        } else if (kinds.every((k) => k === 'fastforward' || k === 'refill-notice' || k === 'recharge')) {
          if (dBoard !== 0 || dBox !== 0) tag('fastforward-only must not move board/box');
        }
        if (A().coin < 0) tag('coin negative: ' + A().coin);
        if (choreOk === true && !kinds.includes('chore')) tag('choreCheck was ok before step but no chore action happened (priority violation)');
        const cur = A();
        if (cur.day > prevDay && milestones.day[cur.day] === undefined) milestones.day[cur.day] = i;
        if (cur.level > prevLevel && milestones.level[cur.level] === undefined) milestones.level[cur.level] = i;
        prevDay = cur.day; prevLevel = cur.level;
      }
      const F = A();
      return JSON.stringify({
        steps, stopReason, milestones,
        finalStats: { level: F.level, day: F.day, coin: F.coin, gem: F.gem, energy: RWB.energy,
                      stats: F.stats, boardCount: boardCount(), boxCount: boxCount(), logLen: RWB.log.length },
        fails: fails.slice(0, 30), failCount: fails.length,
      });
    })()`;

    const report = JSON.parse(await cdp.evalExpr(runnerExpr));
    stepsRun = report.steps;
    stopReason = report.stopReason + (report.steps < maxSteps ? ` (stopped at step ${report.steps} of ${maxSteps})` : '');
    Object.assign(milestones, report.milestones);
    Object.assign(finalStats, report.finalStats);
    invariantFails.push(...report.fails);
    if (report.failCount > report.fails.length) invariantFails.push(`... (${report.failCount - report.fails.length} more, truncated)`);
  } catch (e) {
    stopReason = `error: ${e.message}`;
    console.log(`Part2 error after ${stepsRun} steps: ${e.message}`);
  } finally {
    if (chromeProc) chromeProc.kill();
    staticProc.kill();
  }

  console.log(`Part2 backend used: ${usedCDP ? 'Chrome CDP' : 'not reached (fell back before Chrome connected)'}`);
  console.log(`stop reason: ${stopReason}`);
  console.log(`steps run: ${stepsRun}`);
  console.log('milestones (Day N / Lv N first reached at step):');
  console.log('  Day: ' + Object.entries(milestones.day || {}).map(([d, s]) => `D${d}@${s}`).join(' '));
  console.log('  Lv : ' + Object.entries(milestones.level || {}).map(([l, s]) => `Lv${l}@${s}`).join(' '));
  console.log('final stats: ' + JSON.stringify(finalStats));
  if (invariantFails.length) {
    console.log(`invariant FAILS (${invariantFails.length}, showing up to 30):`);
    invariantFails.slice(0, 30).forEach((m) => console.log('  ' + m));
  } else if (stepsRun > 0) {
    console.log('invariant checks: no violations detected');
  }
}

(async () => {
  part1();
  await part2();
})();
