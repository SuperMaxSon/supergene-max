/* ============================================================================
   rosewood-board.js — 초기 보드를 스스로 풀어 보이는 판 하나 + 계정 축 자동 플레이.

   판정은 클라 구현(`IngameVM` · `MergeRules` · `ProduceRules`)을 그대로 옮긴 것이고,
   여기서 규칙을 새로 만들지 않는다. 옮긴 것은 이만큼이다.
     canPick        집기는 상자·거미줄을 **둘 다** 막는다
     mergeCheckAt   놓기는 상자만 막는다 — 거미줄 칸은 도착지로 **연다**
     mergeCheck     같은 체인·같은 단계 + 다음 단계가 있을 것
     shock          4방향 · 상자만 반응 · 드러난 칸이 움직일 수 있으면 연쇄
     produceCheck   재고 → 빈칸 → 에너지 → 산출 순서. 자동 산출 생성기는 탭을 안 받는다
     produceRoll    럭키(lucky_produce · 개체별 천장)를 주머니보다 먼저 굴린다. 당첨은 에너지만 쓰고 재고·주머니 보존
     drawFromBag    `produce_weight_N` 은 확률이 아니라 **개수**. 비면 재충전(방식 1). 주머니는 방식 1·2 모두 개체별
     nearestEmpty   산출은 생성기에서 나선(12시 · 시계방향)으로 가장 가까운 빈 칸에 놓인다(BoardGeometry.spiralOrderFrom)
     tickGenerators 자동 생산기는 1초마다 주변 8칸(상하좌우 → 대각선) 빈 칸에 재고가 남는 만큼 스스로 놓는다
     mergeCheckAt   한 번이라도 산출한 소모형 상자는 못 합친다. 개봉 중이어도 안 쓴 상자는 합친다
     ProduceRecord  재고(보드)와 창고(예비)를 따로 든다. 타이머는 재고 < 상한일 때만, 돌고 있지 않을 때만
                    시작하고 종류는 그때 정한다(창고 > 0 보드 회복 · 0 창고 회복). 완료는 한 번에 상한까지
     speedupCost    `max(1, ceil(기본 × 남은초 ÷ 회복초))` · 기본은 타이머 종류별 item/storage 비용
     exhausted      회복이 없는 소모 상자는 다 쓰면 끝이다(ProduceRules.ts:134 Exhausted)
   옮기지 않은 것(범위 밖 · 2026-09-28): 배수 부스터 · 도구 · 인벤토리 · 판매 체인 보호(`protect_level`) · 되돌리기.

   계정 축(레벨·경험치·코인·심부름·보상 보관함·오더 레일)은 `rosewood-econ.js`(RwEcon)가 쥐고,
   이 파일은 한 수의 **우선순위**만 정한다(_ignore/plan-rosewood-autoplay.md §1).
     [0] 보상 보관함 → 첫 빈 칸 1개 (매 수 맨 앞. 보드가 꽉 차면 그대로 둔다)
     [1] 심부름 — 코인 ≥ cost_coin
     [2] 오더 납품 — 보드만으로 채워지는 카드 중 슬롯 번호가 가장 낮은 것
     [2.5] 수확 — 짝이 없거나 빈 칸이 1개 이하인 재화 아이템(코인·젬·에너지)
     [3] 머지(D6 요구품 보호) → 생성기 탭(D8 에너지 모자라면 충전 +100 · C2 재고 0이면 젬 충전)
     [4] 보드가 꽉 찼으면 판매 1건(D4). 막힌 게 오더 예산 타이머뿐이면 시계를 감는다.
   부록 D: 64배속(16배속부터는 연출 없이 한 프레임에 여러 수 · 그림은 한 번) · 옵션 4개(window.RWB_OPTS —
           매 수 새로 읽는다. 재생 중에 바꿔도 다음 수부터 먹는다) · 상자 개봉(BoxRules.ts 이식).
   부록 E: [3] 안 순서 = 머지 → 개봉 시작 → 상자 꺼내기 → 생성기 탭 · 코인·젬은 최대 단계에서만 수확.
   부록 C: C1 소모형 상자는 마지막 산출과 함께 칸을 비운다(클라와 같다) ·
           C2 재고 회복을 기다리지 않고 젬(speedupCost — 결제 시점 재계산)으로 끝낸다 · C3 젬은 음수 허용.
   후보를 인덱스 오름차순으로 고르면 같은 보드에서 늘 같은 순서가 나온다.
   ========================================================================== */
(function () {
  "use strict";

  var DATA_URL = "data/rosewood-board.json";
  var COLS = 7, ROWS = 9, CELLS = COLS * ROWS;
  var STEP_MS = 420;                               // 한 수와 다음 수 사이 (1배속 기준)
  var FLY_MS = 240;                                // 칩이 날아가는 시간 (1배속 기준)
  var SPEEDS = [1, 2, 4, 8, 16, 32, 64];           // D-1 · 버튼 하나에 배속 하나
  var BATCH_FROM = 16;                             // 이 배속부터 배치 재생 — 8배속에서 연출 바닥(날기 40ms)에 닿는다
  var BATCH_CAP = 12;                              // 한 프레임에 두는 수 상한 (탭 복귀 직후 몰아치기 방지)
  var SPEED = 1;                                   // 간격·연출을 **같은 배수**로 줄인다.
                                                   // 한쪽만 줄이면 8배속에서 칩이 도착하기 전에 다음 수가 들어온다.
  function stepMs() { return Math.max(24, STEP_MS / SPEED); }
  function flyMs() { return Math.max(40, FLY_MS / SPEED); }

  var RECHARGE_AMOUNT = 100;                       // D8 — 탭하면 0 아래로 갈 때 +100 · 충전 1회
  var FF_MAX = 200;                                // 수 없이 시계만 감는 횟수 상한 (무한 루프 방지)
  var LOG_SHOW = 240;                              // 로그는 최근 것만 그린다

  var DB = null;     // { board, items, bal, _meta }
  var S = null;      // 현재 보드 — [{code,box,web}|null] × 63
  var PROD = null;   // 칸 번호 → { code, stock, reserve, timer, timerAt, pity, used } — 생성기 기록은 칸에 붙는다
  var BAGS = null;   // "c"+칸 → 주머니 잔량 배열 — 방식 1·2 모두 개체별
  var ACC = null;    // RwEcon 계정
  var RAIL = null;   // 오더 레일 6칸
  var ENERGY = 0, ENERGY_MAX = 0, ENERGY_REC = 0, ENERGY_AT = 0;
  var LOG = [];
  var PLAYING = false, TIMER = null, BUSY = false;
  var FF_RUN = 0;                                  // 연속으로 시계만 감은 횟수
  var STEP_N = 0;                                  // step() 호출 번호
  var LAST_PROD = null;                            // { code, n } — 직전 수에 뽑은 코드(판매 헛돌기 방지)
  var INSTANT = false;                             // 검증용 — 연출(날기·깜빡임)을 건너뛴다
  var TURBO = false;                               // 배치 재생 중 — 연출을 건너뛰고 render 는 프레임 끝에 한 번
  var DIRTY = false;                               // 배치 중에 render 가 불렸나
  var RAF = 0, RAF_AT = 0, RAF_ACC = 0;            // 배치 재생 프레임 · 직전 프레임 시각 · 적립된 벽시계 ms
  var OPENING = null;                              // { cell, code, endAt } — 지금 열리는 상자(보드에 하나뿐)
  var OPENED = null;                               // Set(칸) — 개봉이 끝난 상자 칸
  var AUTO_AT = -Infinity;                         // 자동 생산기 직전 틱의 게임 시각

  /* D-2 옵션 — W3 가 window.RWB_OPTS 를 늘 최신값으로 둔다. 규칙이 갈리는 자리마다 새로 읽는다. */
  var OPT_DEFAULT = { energyRefill: true, gemUnlimited: true, genNoCooldown: false, chestNoTimer: false };
  function opts() {
    var o = window.RWB_OPTS || OPT_DEFAULT, out = {};
    for (var k in OPT_DEFAULT) out[k] = o[k] === undefined ? OPT_DEFAULT[k] : !!o[k];
    return out;
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };

  /* 회복은 **게임 시각**으로 잰다. 배속을 올리면 연출만 빨라지고 재고·에너지 회복은
     실시간 그대로라, 8배속에서도 120초를 꼬박 기다리게 된다 — 시계를 같이 감는다.
     경과를 그때그때 배수로 적립하므로 배속을 바꿔도 이미 흐른 시간은 보존된다. */
  var CLOCK = { t: 0, wall: Date.now() / 1000 };
  function now() {
    var w = Date.now() / 1000;
    CLOCK.t += (w - CLOCK.wall) * SPEED;
    CLOCK.wall = w;
    return CLOCK.t;
  }

  /* ── 조회 ────────────────────────────────────────────────────────────── */
  function spec(code) { return DB.items[String(code)] || null; }
  function nameOf(code) {
    var s = spec(code);
    if (s) return s.name;
    var r = window.RwEcon && RwEcon.spec(code);
    return r && r.name ? r.name : String(code);
  }
  function imgOf(code) {
    var s = spec(code);
    return s && s.img === false ? "" : "img/items/" + code + ".png";
  }

  /* ── 머지 판정 (클라 이식) ───────────────────────────────────────────── */
  function canPick(i) {
    var c = S[i];
    if (!c) return false;
    return !c.box && !c.web;                       // IngameVM.canPick
  }

  function mergeCheck(a, b) {                      // MergeRules.mergeCheck
    if (!a) return { ok: false, reason: "no_source" };
    if (!b) return { ok: true, kind: "move" };
    var sa = spec(a.code), sb = spec(b.code);
    if (!sa || !sb) return { ok: false, reason: "unknown_spec" };
    if (sa.chain !== sb.chain || sa.step !== sb.step) return { ok: false, reason: "not_same_pair" };
    if (!sa.next) return { ok: false, reason: "max_step" };
    return { ok: true, kind: "merge", code: sa.next };
  }

  function mergeCheckAt(from, to) {                // IngameVM.mergeCheckAt
    if (from === to) return { ok: false, reason: "no_source" };
    if (!canPick(from)) return { ok: false, reason: "no_source" };
    var t = S[to];
    // 덮개 칸은 대상이 될 수 없다. 거미줄 칸은 대상이 된다 — 여기가 규칙의 핵심이다.
    if (t && t.box) return { ok: false, reason: "not_same_pair" };
    var r = mergeCheck(S[from], t);
    // IngameVM.mergeCheckAt — 소모형 상자는 타이머가 아니라 **산출 사용 여부**로 가른다. 닫힘·개봉 중·개봉 완료라도
    // 한 번도 안 썼으면 합치고(개봉 점유는 dropCellState 가 푼다), 한 번이라도 산출했으면 못 합친다.
    if (r.ok && r.kind === "merge" && (isBoxUsedAt(from) || isBoxUsedAt(to)))
      return { ok: false, reason: "not_same_pair" };
    return r;
  }

  /* IngameVM.isBoxUsedAt — 읽기 전용. 기록이 없거나 코드가 다르면 안 쓴 상자다. 럭키도 산출이라 used 가 켜진다. */
  function isBoxUsedAt(i) {
    var c = S[i];
    if (!c) return false;
    var row = RwEcon.spec(c.code);
    if (!row || row.is_generator !== false || !(Number(row.spread_item_max) > 0)) return false;
    var st = PROD.get(i);
    return !!st && st.code === c.code && st.used === true;
  }

  /* 4방향 인접 충격. 반응하는 건 종이상자뿐이고, 드러난 칸이 움직일 수 있으면 연쇄한다.
     seen 이 없으면 두 칸이 서로를 다시 때려 무한히 돈다(원작 unlockShocked 자리). */
  function shock(index, seen, popped) {
    var col = index % COLS, row = Math.floor(index / COLS);
    var OFF = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (var k = 0; k < OFF.length; k++) {
      var nc = col + OFF[k][0], nr = row + OFF[k][1];
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      var n = nr * COLS + nc;
      if (seen.indexOf(n) >= 0) continue;
      var cell = S[n];
      if (!cell || !cell.box) continue;
      seen.push(n);
      cell.box = false;                            // 상자만 걷힌다. 거미줄은 그대로 둔다
      popped.push(n);
      if (cell.web) continue;                      // 못 움직이는 칸에서 멈춘다
      shock(n, seen, popped);
    }
  }

  /* 오더 판정·보유량이 보는 보드 — 잠긴 칸(상자·거미줄)은 세지 않는다
     (IngameVM.ts:2378 toRuleCell → OrderRules.ts:115 countBoard). 보상 보관함은 애초에 여기 없다. */
  function boardCounts() {
    var m = new Map();
    for (var i = 0; i < CELLS; i++) {
      if (!canPick(i)) continue;
      var code = S[i].code;
      m.set(code, (m.get(code) || 0) + 1);
    }
    return m;
  }

  /* 레일 전체가 요구하는 코드별 개수(같은 코드 두 칸 = 2). */
  function railNeed() {
    var m = new Map();
    RAIL.forEach(function (s) {
      if (!s.card) return;
      RwEcon.reqCodes(s.card).forEach(function (c) { m.set(c, (m.get(c) || 0) + 1); });
    });
    return m;
  }

  /* D6 — 레일이 요구하는 코드는 합친 **뒤에도** 보드 수가 요구 수 이상일 때만 합친다.
     거미줄 칸 도착지는 원래 안 세던 개체라 빠지는 건 출발 칸 하나다. */
  function mergeAllowed(from, to, need, counts) {
    var code = S[from].code, q = need.get(code) || 0;
    if (!q) return true;
    var after = (counts.get(code) || 0) - 1 - (canPick(to) ? 1 : 0);
    return after >= q;
  }

  /* 도착 칸 4방향에 종이상자가 있나 — 합치면 shock 이 걷어 낸다. */
  function boxNear(to) {
    var col = to % COLS, row = Math.floor(to / COLS);
    var OFF = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (var k = 0; k < OFF.length; k++) {
      var nc = col + OFF[k][0], nr = row + OFF[k][1];
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      var n = S[nr * COLS + nc];
      if (n && n.box) return true;
    }
    return false;
  }

  /* 둘 수 있는 머지 한 수. 이동(`move`)은 후보로 보지 않는다 — 빈 칸으로 옮겨 봐야
     보드 상태가 제자리를 돈다.
     고르는 순서(시연 정책 — 판정은 mergeCheckAt · mergeAllowed 그대로):
       ⓪ 결과가 레일의 모자란 요구로 간다(F2)  ① 도착지가 거미줄 칸(합치면 풀린다)
       ② 도착지 옆에 종이상자(shock 로 걷힌다)  ③ 나머지.
     같은 등급 안에서는 인덱스 오름차순이라 같은 보드에서 늘 같은 수가 나온다. */
  /* F2 — 결과가 레일의 모자란 요구 코드이거나, 같은 체인에서 그 코드로 가는 낮은 단계(결과 step ≤ 요구 step)인가. */
  function feedsShortReq(code, shortReq) {
    var s = spec(code);
    if (!s) return false;
    for (var k = 0; k < shortReq.length; k++) {
      var q = spec(shortReq[k]);
      if (shortReq[k] === code || (q && q.chain === s.chain && s.step <= q.step)) return true;
    }
    return false;
  }

  function findMerge() {
    var need = railNeed(), counts = boardCounts(), best = null, bestTier = 4;
    var shortReq = [];
    need.forEach(function (q, code) { if ((counts.get(code) || 0) < q) shortReq.push(code); });
    for (var from = 0; from < CELLS && bestTier > 0; from++) {
      if (!canPick(from)) continue;
      for (var to = 0; to < CELLS; to++) {
        if (to === from) continue;
        var r = mergeCheckAt(from, to);
        if (!r.ok || r.kind !== "merge") continue;
        if (!mergeAllowed(from, to, need, counts)) continue;
        // F2 ① 오더로 가는 머지 → ② 거미줄 도착지 → ③ 상자 옆 → ④ 나머지
        var tier = feedsShortReq(r.code, shortReq) ? 0 : S[to].web ? 1 : boxNear(to) ? 2 : 3;
        if (tier < bestTier) { best = { from: from, to: to, code: r.code }; bestTier = tier; }
        if (tier === 0) break;
      }
    }
    return best;
  }

  /* 칸이 비거나 다른 개체가 되면 그 칸의 재고·개체 주머니 기록도 같이 죽는다(IngameVM.sell 규약). */
  function dropCellState(i) {
    PROD.delete(i);
    BAGS.delete("c" + i);
    OPENED.delete(i);                              // 개봉 상태도 칸에 붙는다 — 새 개체는 닫힌 상자다
    if (OPENING && OPENING.cell === i) OPENING = null;   // IngameVM.ts:2449 clearOpeningAt
  }

  function applyMerge(from, to) {
    var r = mergeCheckAt(from, to);
    if (!r.ok) return r;
    S[from] = null;
    S[to] = { code: r.code, box: false, web: false };
    dropCellState(from);                           // 떠난 칸의 재고 기록을 지운다
    dropCellState(to);                             // 합친 결과는 다른 코드의 새 개체다
    var popped = [];
    shock(to, [], popped);                         // 합치기에만 걸린다 — 이동은 트리거가 아니다
    popped.sort(function (a, b) { return a - b; });
    ACC.stats.merges++;
    LOG.push({ kind: "merge", from: from, to: to, code: r.code, popped: popped });
    return { ok: true, kind: "merge", code: r.code, popped: popped };
  }

  /* 에너지 자연 회복 — 정본 「에너지」 그대로.
       직전 >= 상한 → 회복 정지 · 아니면 floor(경과 ÷ 120) 만큼 채우고 기준시각을 배수로 스냅
     (나머지 초를 버리면 회복이 영원히 느려진다). 보상·구매로 상한을 넘겨 갖는 건 줄이지 않는다. */
  function rechargeEnergy() {
    if (ENERGY_REC <= 0 || ENERGY >= ENERGY_MAX) { ENERGY_AT = now(); return; }
    var elapsed = now() - ENERGY_AT;
    if (elapsed < 0) { ENERGY_AT = now(); return; }
    if (elapsed < ENERGY_REC) return;
    var gained = Math.floor(elapsed / ENERGY_REC);
    ENERGY = Math.min(ENERGY_MAX, ENERGY + gained);
    ENERGY_AT = ENERGY >= ENERGY_MAX ? now() : ENERGY_AT + gained * ENERGY_REC;
  }

  function energyWait() {
    if (ENERGY >= ENERGY_MAX || ENERGY_REC <= 0) return 0;
    return Math.max(0, ENERGY_REC - (now() - ENERGY_AT));
  }

  /* ── 생산 판정 (클라 이식) ───────────────────────────────────────────── */
  function firstEmpty() {
    for (var i = 0; i < CELLS; i++) if (!S[i]) return i;
    return -1;
  }

  /* ── 생성기 재고 레코드 (ProduceRules.ts 이식) ──────────────────────────
     재고(보드)와 창고(예비)는 다른 개념이다 — 탭은 재고만 깎고, 창고는 보드 회복이 끝날 때 부족분만큼 줄어든다.
     타이머는 재고 < 상한일 때만 돈다. 종류는 **시작 시점**에 정한다 — 창고 > 0 이면 보드 회복, 0 이면 창고 회복.
     창고 회복이 끝나면 재고·창고 **둘 다** 상한이다. 완료는 투영 한 번에 많아야 한 번(밀린 주기를 재생하지 않는다).
     규칙 값은 item_spec 원본 행(RwEcon.spec)에서 읽는다 — board.json 의 p 에는 창고 열이 없다. */
  var T_NONE = "none", T_BOARD = "board", T_STORAGE = "storage";
  var GEN_ROWS = new Map();

  /* 소모 상자(is_generator=false)는 회복 값이 있어도 회복·창고를 갖지 않는다(ProduceRules.canRecover). */
  function genRow(code) {
    var g = GEN_ROWS.get(code);
    if (g) return g;
    var r = RwEcon.spec(code) || {};
    g = {
      max: Number(r.spread_item_max) || 0,
      storeMax: Number(r.spread_storage_max) || 0,
      itemSec: Number(r.spread_item_recovery_sec) || 0,
      storeSec: Number(r.spread_storage_recovery_sec) || 0,
      itemCost: Number(r.spread_item_speedup_cost) || 0,
      storeCost: Number(r.spread_storage_speedup_cost) || 0,
    };
    g.recover = g.itemSec > 0 && r.is_generator !== false;
    GEN_ROWS.set(code, g);
    return g;
  }

  /* timerDurationSec — 창고 회복 열이 0 이하면 보드 회복 값으로 떨어진다. */
  function timerDur(g, kind) {
    if (kind === T_BOARD) return g.itemSec;
    if (kind !== T_STORAGE) return 0;
    return g.storeSec > 0 ? g.storeSec : g.itemSec;
  }

  function timerKindFor(st) { return st.reserve > 0 ? T_BOARD : T_STORAGE; }

  /* newProduceRecord — 재고·창고 상한, 타이머 없음. 저장본 없는 첫 진입의 동작이다. */
  function newRec(code, g) {
    return { code: code, stock: g.max, reserve: g.recover ? g.storeMax : 0, timer: T_NONE, timerAt: 0,
             pity: { remainTotal: 0, remainLucky: 0 }, used: false };
  }

  /* consumeRecord — 타이머는 **돌고 있지 않을 때만** 시작한다. 탭마다 기준점을 당기면 진행 중이던 회복이 버려진다. */
  function consume(g, st, n, t) {
    st.stock = Math.max(0, st.stock - n);
    if (st.timer !== T_NONE) return;
    if (st.stock >= g.max) return;
    if (!g.recover) return;
    st.timer = timerKindFor(st);
    st.timerAt = t;
  }

  /* applyCompletion — 보드 회복: 창고에서 부족분을 빼고(0 미만은 0) 재고 상한 · 창고 회복: 둘 다 상한. */
  function complete(g, st) {
    if (st.timer === T_BOARD) st.reserve = Math.max(0, st.reserve - Math.max(0, g.max - st.stock));
    else if (st.timer === T_STORAGE) st.reserve = g.storeMax;
    st.stock = g.max;
    st.timer = T_NONE;
    st.timerAt = 0;
  }

  /* projectRecord — t 까지 흐른 시간을 반영한다. 완료는 많아야 한 번이다. */
  function project(g, st, t) {
    if (!g.recover) { st.stock = Math.min(g.max, st.stock); st.reserve = 0; st.timer = T_NONE; st.timerAt = 0; return; }
    if (st.stock >= g.max) { st.stock = g.max; st.timer = T_NONE; st.timerAt = 0; return; }
    if (st.timer === T_NONE) { st.timer = timerKindFor(st); st.timerAt = t; return; }
    if (st.timerAt > t) st.timerAt = t;                    // 시계가 뒤로 갔으면 기준점만 당긴다
    if (t < st.timerAt + timerDur(g, st.timer)) return;
    complete(g, st);
  }

  /* recordWaitSec — 회복까지 남은 초. 한 회분 길이를 넘기지 않는다. */
  function waitSec(g, st, t) {
    if (st.timer === T_NONE) return 0;
    var dur = timerDur(g, st.timer);
    return Math.max(0, Math.min(dur, st.timerAt + dur - t));
  }

  /* recordSpeedupCost — 남은 시간에 비례해 줄어든다. 회복이 없거나 이미 끝났으면 0(살 게 없다). */
  function speedupCost(g, st, t) {
    if (st.timer === T_NONE) return 0;
    var dur = timerDur(g, st.timer);
    if (dur <= 0) return 0;
    var remain = waitSec(g, st, t);
    if (remain <= 0) return 0;
    var base = st.timer === T_STORAGE ? g.storeCost : g.itemCost;
    return Math.max(1, Math.ceil((base * remain) / dur));
  }

  /* 재고 기록은 칸에 붙는다. 코드가 바뀌었으면(합쳐졌으면) 다른 개체라 새로 만든다. */
  function prodAt(i) {
    var st = PROD.get(i);
    if (!st || st.code !== S[i].code) {
      st = newRec(S[i].code, genRow(S[i].code));
      PROD.set(i, st);
    }
    return st;
  }

  /* 주머니는 방식 1·2 모두 **개체별**이다(IngameVM — ProduceRecord.bag). 칸이 비거나 합쳐지면 dropCellState 가 지운다. */
  function bagKey(i) { return "c" + i; }
  function bagOf(i, code, p) {
    var remain = BAGS.get(bagKey(i));
    if (!remain || remain.length !== p.slots.length) remain = p.slots.map(function (s) { return s[1]; });
    return remain;
  }
  function bagTotal(remain) { return remain.reduce(function (a, b) { return a + b; }, 0); }

  /* BoxRules.ts:55-58 isOpenableBox — 산출이 있고 spread_open_duration_sec > 0 인 상자. */
  function openDurOf(code) {
    var r = RwEcon.spec(code);
    return r && Number(r.spread_open_duration_sec) > 0 ? Number(r.spread_open_duration_sec) : 0;
  }
  function isOpenable(code) { return !!(spec(code) || {}).p && openDurOf(code) > 0; }

  /* D-2 genNoCooldown(시뮬 전용) — 회복하는 생성기는 재고가 0 이 되는 즉시 도는 회복을 끝낸다.
     공짜 완료일 뿐 완료 규칙은 같다 — 보드 회복이면 창고에서 부족분을 빼고, 창고 회복이면 둘 다 상한.
     회복이 없는 것(소진)에는 걸지 않는다. */
  function noCooldownFill(g, st) {
    if (opts().genNoCooldown && g.recover && st.stock <= 0 && st.timer !== T_NONE) complete(g, st);
  }

  /* 탭 가능 여부 — 재고 → 빈칸 → 에너지 → 산출 순서(정본). 어느 단계에서 막히든 아무것도 깎지 않는다.
     에너지는 energyRefill 이 켜져 있으면 막지 않는다(D8 — 탭하는 순간 충전). 꺼져 있으면 모자랄 때 막힌다.
     개봉 대기 상자는 개봉이 끝나야 꺼낼 수 있다(BoxRules — 개봉 시작이 먼저). */
  function produceCheckAt(i) {
    var c = S[i];
    if (!c || c.box || c.web) return { ok: false, reason: "no_produce" };
    var p = (spec(c.code) || {}).p;
    if (!p) return { ok: false, reason: "no_produce" };
    if (p.auto) return { ok: false, reason: "auto_only" };   // 자동 산출은 탭을 받지 않는다
    if (isOpenable(c.code) && !OPENED.has(i))
      return { ok: false, reason: OPENING && OPENING.cell === i ? "opening" : "not_opened" };
    var st = prodAt(i), g = genRow(c.code), t = now();
    project(g, st, t);
    noCooldownFill(g, st);
    // ProduceRules.ts isExhausted — 회복이 없는데 재고가 0 이거나, 소모형 주머니가 비었으면 끝이다
    if ((st.stock <= 0 && p.rec <= 0) || (p.wt === 2 && bagTotal(bagOf(i, c.code, p)) <= 0))
      return { ok: false, reason: "exhausted" };
    if (st.stock <= 0) return { ok: false, reason: "recharging", wait: waitSec(g, st, t) };
    var dest = nearestEmpty(i);                    // IngameVM.nearestEmptyIndex — 나선으로 가장 가까운 빈 칸
    if (dest < 0) return { ok: false, reason: "board_full" };
    if (!opts().energyRefill && ENERGY < p.cost) return { ok: false, reason: "energy_short", wait: energyWait(), need: p.cost };
    return { ok: true, dest: dest, p: p, st: st };
  }

  /* 거미줄 칸(상자 없는 것)에 깔린 아이템의 체인 — 그 체인을 낳는 생성기를 먼저 누른다. */
  function webChains() {
    var set = {};
    for (var k = 0; k < CELLS; k++) {
      var c = S[k];
      if (c && c.web && !c.box) { var s = spec(c.code); if (s) set[s.chain] = 1; }
    }
    return set;
  }
  function feedsWeb(p, chains) {
    return p.slots.some(function (sl) { var s = spec(sl[0]); return !!(s && chains[s.chain]); });
  }

  /* 레일이 요구하는데 보드에 모자란 코드의 체인 — 그 체인을 낳는 생성기가 거미줄보다 먼저다.
     (재고를 젬으로 채울 수 있게 되자 거미줄 쪽 생성기가 늘 재고를 가져 오더 체인을 영영 안 누르게 됐다.) */
  function shortChains() {
    var need = railNeed(), counts = boardCounts(), set = {};
    need.forEach(function (q, code) {
      if ((counts.get(code) || 0) >= q) return;
      var s = spec(code);
      if (s) set[s.chain] = 1;
    });
    return set;
  }

  /* 보드에서 지금 누를 수 있는 생성기 하나. 없으면 왜 없는지까지 돌려준다.
     시연 정책: 재고 있는 생성기가 젬 충전보다 먼저고, 같은 쪽 안에서는
     ① 레일이 모자란 코드의 체인을 낳는 것 ② 거미줄 칸 아이템 체인을 낳는 것 ③ 인덱스 오름차순
     (판정은 produceCheckAt 그대로). */
  /* 지금 젬으로 끝내면 얼마인가 — 투영이 끝난 레코드 기준. 0 이면 살 게 없다. */
  function gemCostAt(i) {
    var st = PROD.get(i);
    return st && st.code === S[i].code ? speedupCost(genRow(st.code), st, now()) : 0;
  }

  /* E1 — kind "chest": 생성기가 아닌 산출 상자(열렸거나 개봉이 필요 없는 것)만 · "gen": 생성기만. */
  function findProduce(kind) {
    rechargeEnergy();
    var o = opts();
    var why = null, dest = firstEmpty(), chains = webChains(), rail = shortChains();
    /* F1 — 순위 = (오더에 모자란 체인을 낳나) → (재고 있음 / 젬 충전) → 거미줄 → 칸 번호.
       오더용 생성기가 재고 0이면(F3 로 젬을 쓸 수 있을 때) 재고 있는 무관한 생성기보다 먼저 충전해 누른다. */
    var pick = [null, null, null, null, null, null, null, null];
    function rank(p, gem) { return (feedsWeb(p, rail) ? 0 : 4) + (gem ? 2 : 0) + (feedsWeb(p, chains) ? 0 : 1); }
    for (var i = 0; i < CELLS; i++) {
      if (!S[i]) continue;
      var isGen = !!(spec(S[i].code) || {}).gen;
      if (kind && (kind === "gen") !== isGen) continue;
      var r = produceCheckAt(i);
      if (r.ok) {
        var k = rank(r.p, false);
        if (!pick[k]) pick[k] = { index: i, check: r };
        continue;
      }
      if (r.reason === "no_produce" || r.reason === "auto_only" || r.reason === "exhausted"
          || r.reason === "not_opened" || r.reason === "opening") continue;
      /* C2 — 재고 0 · 회복 대기면 젬으로 채우고 누를 수 있다. 재고가 있는 생성기가 우선이고,
         그다음 같은 거미줄 선호. 빈 칸이 없으면 채워 봐야 못 누르니 후보가 아니다. */
      var gdest = dest >= 0 ? nearestEmpty(i) : -1;
      var gc = r.reason === "recharging" && gdest >= 0 ? gemCostAt(i) : 0;
      if (gc > 0 && canSpendGem(gc, o)) {
        var p = spec(S[i].code).p, kg = rank(p, true);
        if (!pick[kg]) pick[kg] = { index: i, gem: true, check: { ok: true, dest: gdest, p: p, st: PROD.get(i) } };
      }
      // 막힌 사유는 「생성기가 아예 없다」와 구분해야 해서 남긴다. 기다리면 풀리는 사유가 가장 약하다.
      if (!why || !isWait(why)) why = r;
    }
    for (var j = 0; j < pick.length; j++) if (pick[j]) return pick[j];
    return { index: -1, why: why };
  }

  /* C2 — 젬 충전 = IngameVM.speedupGenerator. 비용은 결제 시점에 다시 잰다(speedupCost).
     C3 — gemUnlimited 가 켜져 있으면 모자라도 막지 않는다(음수). 꺼져 있으면 findProduce 가 후보에서 뺀다. */
  /* F3 — 젬을 쓸 수 있나. gemUnlimited 꺼짐이면 쓴 뒤에도 0 이상이어야 한다(젬은 절대 음수가 안 된다). */
  function canSpendGem(cost, o) {
    return (o || opts()).gemUnlimited || ACC.gem - cost >= 0;
  }

  /* F3 — 젬을 쓰는 **유일한** 자리. 못 쓰면 false 를 돌려주고 아무것도 바꾸지 않는다. */
  function spendGem(cost) {
    if (!canSpendGem(cost)) return false;
    ACC.gem -= cost;
    ACC.stats.gemSpent += cost;
    return true;
  }

  /* 투영 → 비용 → 결제 → 완료(completeRecordNow). 그사이 회복이 끝났으면 살 게 없으니 그대로 누른다.
     로그 entry.gem 에 결제 근거(종류·남은초·회복초·기본 비용)를 남긴다 — 검사기가 비용을 다시 계산한다. */
  function gemRecharge(i, check) {
    var g = genRow(S[i].code), st = check.st, t = now();
    project(g, st, t);
    var cost = speedupCost(g, st, t);
    if (cost <= 0) return st.stock > 0;
    if (!spendGem(cost)) return false;
    var kind = st.timer, remain = waitSec(g, st, t), dur = timerDur(g, kind);
    complete(g, st);
    ACC.stats.gemRecharges++;
    LOG.push({ kind: "gem",
      html: "cell" + i + " " + esc(nameOf(S[i].code)) + " · −" + cost + " 젬 → 젬 " + ACC.gem
        + ' <span class="rwb-dim">· ' + (kind === T_STORAGE ? "창고" : "보드") + " 회복 남은 " + Math.ceil(remain) + "s/" + dur + "s"
        + " · 재고 " + st.stock + " · 창고 " + st.reserve + "</span>",
      gem: { kind: kind, remain: remain, dur: dur, base: kind === T_STORAGE ? g.storeCost : g.itemCost, cost: cost } });
    return true;
  }

  /* C1 — 생성기가 아닌 소모 상자가 더 뽑을 게 없나(방식 2 주머니가 비었거나, 회복 없이 재고 0). */
  function isSpentChest(i, p, st) {
    var s = spec(S[i].code);
    if (!s || s.gen) return false;
    if (p.wt === 2 && bagTotal(bagOf(i, S[i].code, p)) <= 0) return true;
    return p.rec <= 0 && !!st && st.stock <= 0;
  }

  /* C1 스윕 — 이미 소진된 채 보드에 남아 있는 상자(리셋·불러오기 뒤 등)를 치운다. */
  function sweepSpentChests() {
    for (var i = 0; i < CELLS; i++) {
      var c = S[i];
      if (!c || c.box || c.web) continue;
      var p = (spec(c.code) || {}).p;
      if (!p) continue;
      var st = PROD.get(i);
      if (st && st.code !== c.code) st = null;
      var bagged = p.wt === 2 && BAGS.has("c" + i);
      if (!st && !bagged) continue;                // 한 번도 안 눌린 상자는 만땅이다
      if (!isSpentChest(i, p, st)) continue;
      var code = c.code;
      S[i] = null;
      dropCellState(i);
      ACC.stats.chestsEmptied++;
      LOG.push({ kind: "prod", html: "cell" + i + " " + codeTag(code) + ' <span class="rwb-pop">소진 상자 치움</span>',
                 emptied: true, from: i, code: code });
    }
  }

  /* ProduceRules.drawFromBag — `produce_weight_N` 은 개수다. 뽑으면 그 칸이 1 줄고,
     다 비면 방식 1은 재충전한다. 방식 2(소모형)는 재충전하지 않는다. */
  function drawFromBag(i, code, p) {
    var remain = bagOf(i, code, p);
    var total = bagTotal(remain);
    var refilled = false;
    if (total <= 0) {
      if (p.wt === 2) return null;                 // 소모형은 재충전하지 않는다
      remain = p.slots.map(function (s) { return s[1]; });
      total = bagTotal(remain);
      refilled = true;
    }
    var r = pick(total);
    for (var k = 0; k < remain.length; k++) {
      r -= remain[k];
      if (r >= 0) continue;
      remain[k] -= 1;
      BAGS.set(bagKey(i), remain);
      return { code: p.slots[k][0], refilled: refilled };
    }
    return null;
  }

  /* 클라 pick(n) — [0, n) 정수. 시드 재현은 범위 밖이라 Math.random 이다. */
  function pick(n) { return Math.floor(Math.random() * n); }

  /* ── 럭키 산출 (ProduceRules.luckyRowFor · rollLucky · pickLuckyItem 이식) ──────────
     lucky_produce 한 행이 generator_1..5 에 걸린다. 그 생성기·플레이어 레벨에서 in_use 인 첫 행이 쓰인다.
     천장은 **개체별**이다 — 레코드의 pity 가 칸을 따라다닌다. */
  var LUCKY = null;
  function luckyRowFor(code, level) {
    if (!LUCKY) {
      LUCKY = new Map();
      (DB.bal.lucky_produce || []).forEach(function (row) {
        for (var n = 1; n <= 5; n++) {
          var gcode = Number(row["generator_" + n]) || 0;
          if (!gcode) continue;
          if (!LUCKY.has(gcode)) LUCKY.set(gcode, []);
          LUCKY.get(gcode).push(row);
        }
      });
    }
    var rows = LUCKY.get(Number(code));
    if (!rows) return null;
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      if (row.in_use !== true) continue;
      if (level < row.level_min || level > row.level_max) continue;
      return row;
    }
    return null;
  }

  /* lucky_weight_N 은 **가중치**다(개수 해석은 produce_weight_N 에만). */
  function pickLuckyItem(row, pk) {
    var codes = [], weights = [], total = 0;
    for (var n = 1; n <= 6; n++) {
      var c = Number(row["lucky_item_" + n]) || 0, w = Number(row["lucky_weight_" + n]) || 0;
      if (c <= 0 || w <= 0) continue;
      codes.push(c); weights.push(w); total += w;
    }
    if (!codes.length) return 0;
    if (total <= 0) return codes[0];
    var r = pk(total);
    for (var k = 0; k < codes.length; k++) { r -= weights[k]; if (r < 0) return codes[k]; }
    return codes[codes.length - 1];
  }

  /* 남은총탭 0 → pity_total·pity_lucky 로 되감기 · r = 1..남은총탭 · 남은총탭 −1 · r <= 남은럭키 → 당첨, 남은럭키 −1 */
  function rollLucky(row, pity, pk) {
    pk = pk || pick;
    var miss = { hit: false, code: 0, pity: { remainTotal: pity.remainTotal, remainLucky: pity.remainLucky } };
    if (!row) return miss;
    var total = pity.remainTotal, lucky = pity.remainLucky;
    if (total === 0) { total = row.pity_total; lucky = row.pity_lucky; }
    if (total <= 0) return miss;
    var r = pk(total) + 1;
    total -= 1;
    if (r > lucky) return { hit: false, code: 0, pity: { remainTotal: total, remainLucky: lucky } };
    var code = pickLuckyItem(row, pk);
    if (code <= 0) return { hit: false, code: 0, pity: { remainTotal: total, remainLucky: lucky } };
    return { hit: true, code: code, pity: { remainTotal: total, remainLucky: lucky - 1 } };
  }

  /* ProduceRules.produceRoll — 럭키를 **먼저** 굴린다. 당첨이면 주머니를 안 건드린다.
     실패(주머니 결손)면 null 이고 천장도 저장하지 않는다 — 호출부가 성공일 때만 pity 를 굳힌다. */
  function produceRoll(i, code, p, st) {
    var lucky = rollLucky(luckyRowFor(code, ACC.level), st.pity || { remainTotal: 0, remainLucky: 0 });
    if (lucky.hit) return { code: lucky.code, lucky: true, refilled: false, pity: lucky.pity };
    var draw = drawFromBag(i, code, p);
    if (!draw) return null;
    return { code: draw.code, lucky: false, refilled: draw.refilled, pity: lucky.pity };
  }

  /* 산출 한 건을 레코드에 굳힌다 — 럭키는 재고를 안 깎는다. 럭키도 산출이라 used 는 늘 켠다(P1 M8). */
  function commitRoll(g, st, roll, t) {
    st.pity = roll.pity;
    if (!roll.lucky) consume(g, st, 1, t);
    st.used = true;
  }

  /* ── 산출 칸 (BoardGeometry.spiralOrderFrom 이식) ───────────────────────────
     자기 칸 → 링 1..8, 링마다 12시에서 시계방향. 덮개·거미줄 칸은 이 보드에서 비어 있지 않으니 자연히 빠진다. */
  var SPIRAL = [];
  function spiralOrderFrom(from) {
    if (SPIRAL[from]) return SPIRAL[from];
    var order = [from], col = from % COLS, row = Math.floor(from / COLS);
    function push(r, c) { if (r >= 0 && r < ROWS && c >= 0 && c < COLS) order.push(r * COLS + c); }
    var maxRing = Math.max(COLS, ROWS) - 1;
    for (var ring = 1; ring <= maxRing; ring++) {
      var dc, dr;
      for (dc = 0; dc <= ring; dc++) push(row - ring, col + dc);
      for (dr = -ring + 1; dr <= ring; dr++) push(row + dr, col + ring);
      for (dc = ring - 1; dc >= -ring; dc--) push(row + ring, col + dc);
      for (dr = ring - 1; dr >= -ring; dr--) push(row + dr, col - ring);
      for (dc = -ring + 1; dc <= -1; dc++) push(row - ring, col + dc);
    }
    SPIRAL[from] = order;
    return order;
  }

  /* ── 자동 생산기 (IngameVM.tickGenerators 이식) ──────────────────────────────
     spread_auto 생성기는 탭을 안 받고, 1초(AUTO_TICK_SEC) 틱마다 회복을 한 번 반영한 뒤 재고가 남는 동안
     주변 8칸의 첫 빈 칸에 계속 놓는다. 에너지 0 · 배수 1 · 럭키·주머니·천장은 탭과 같은 규칙이다.
     클라의 게이트(끌기 · 되돌리기 · 입력 막힘)는 이 시뮬에 없어 늘 열려 있다. */
  var AUTO_TICK_SEC = 1;
  var AUTO_NB = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];   // [열, 행] — 상하좌우 먼저

  function autoNeighbor(i) {
    var col = i % COLS, row = Math.floor(i / COLS);
    for (var k = 0; k < AUTO_NB.length; k++) {
      var c = col + AUTO_NB[k][0], r = row + AUTO_NB[k][1];
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      if (!S[r * COLS + c]) return r * COLS + c;
    }
    return -1;
  }

  function isAutoAt(i) {
    var c = S[i];
    if (!c || c.box || c.web) return false;
    var p = (spec(c.code) || {}).p;
    if (!p || !p.auto) return false;
    return !(isOpenable(c.code) && !OPENED.has(i));   // 열기 전 상자는 산출하지 않는다(b1)
  }

  function tickGenerators() {
    var t = now();
    if (t - AUTO_AT < AUTO_TICK_SEC) return 0;
    AUTO_AT = t;
    var placed = 0;
    for (var i = 0; i < CELLS; i++) {
      if (!isAutoAt(i)) continue;
      var code = S[i].code, p = spec(code).p, g = genRow(code), st = prodAt(i);
      project(g, st, t);
      noCooldownFill(g, st);
      for (var to = autoNeighbor(i); to >= 0 && st.stock > 0; to = autoNeighbor(i)) {
        var roll = produceRoll(i, code, p, st);
        if (!roll) break;
        commitRoll(g, st, roll, t);
        noCooldownFill(g, st);
        S[to] = { code: roll.code, box: false, web: false };
        placed++;
        LOG.push({ kind: "prod", auto: true, from: i, to: to, code: roll.code, lucky: roll.lucky,
                   html: "cell" + i + " " + codeTag(code) + " → cell" + to + " " + codeTag(roll.code)
                     + ' <span class="rwb-pop">자동 생산' + (roll.lucky ? " · 럭키" : "") + "</span>"
                     + ' <span class="rwb-dim">재고 ' + st.stock + "</span>" });
      }
    }
    return placed;
  }

  /* IngameVM.nearestEmptyIndex — 생성기에서 가장 가까운 빈 칸. 없으면 -1. */
  function nearestEmpty(from) {
    var order = spiralOrderFrom(from);
    for (var k = 0; k < order.length; k++) if (!S[order[k]]) return order[k];
    return -1;
  }

  /* 기다리면 풀리는 사유. 보드가 가득하거나 생성기가 없는 것과 달리 시간이 해결한다.
     에너지는 D8 로 기다리지 않으므로 재고 회복만 남는다. */
  function isWait(r) { return r && (r.reason === "recharging" || r.reason === "energy_short"); }

  function applyProduce(i, check) {
    var draw = produceRoll(i, S[i].code, check.p, check.st);
    if (!draw) return null;
    var cost = check.p.cost;
    if (ENERGY - cost < 0 && opts().energyRefill) {   // D8 — 기다리지 않고 충전한 뒤 그 탭을 진행한다
      ACC.stats.recharges++;
      ENERGY += RECHARGE_AMOUNT;
      LOG.push({ kind: "energy", amount: RECHARGE_AMOUNT, energy: ENERGY, n: ACC.stats.recharges });
    }
    if (ENERGY >= ENERGY_MAX) ENERGY_AT = now();   // 만땅에서 처음 쓰는 순간부터 회복 시계가 돈다
    ENERGY -= cost;                                // 에너지가 먼저, 그 다음 재고
    ACC.stats.energySpent += cost;
    var g = genRow(S[i].code);
    commitRoll(g, check.st, draw, now());
    noCooldownFill(g, check.st);
    S[check.dest] = { code: draw.code, box: false, web: false };
    LAST_PROD = { code: draw.code, n: STEP_N };
    var entry = { kind: "prod", from: i, to: check.dest, code: draw.code, cost: cost,
                  stock: check.st.stock, refilled: draw.refilled, lucky: draw.lucky };
    if (isSpentChest(i, check.p, check.st)) {      // C1 — 마지막 산출과 함께 상자 칸을 비운다
      S[i] = null;
      dropCellState(i);
      entry.emptied = true;
      ACC.stats.chestsEmptied++;
    }
    LOG.push(entry);
    return { dest: check.dest, code: draw.code, emptied: !!entry.emptied };
  }

  /* ── 계정 축 (RwEcon) ────────────────────────────────────────────────── */
  function logPush(kind, html) { LOG.push({ kind: kind, html: html }); }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function lvOfCode(code) { var s = spec(code); return s && s.step ? s.step : 0; }
  function codeTag(code) { return "<code>" + code + "</code> " + esc(nameOf(code)) + " <b>Lv" + lvOfCode(code) + "</b>"; }
  var KIND_KO = { exp: "경험치", coin: "코인", gem: "젬", energy: "에너지" };
  function fmtGrants(list) {
    if (!list || !list.length) return '<span class="rwb-dim">없음</span>';
    return list.map(function (g) {
      if (g.kind === "item") return codeTag(g.code) + (g.amount > 1 ? " ×" + g.amount : "") + " → 보관함";
      return (KIND_KO[g.kind] || g.kind) + " +" + g.amount;
    }).join(" · ");
  }

  /* 에너지 보상은 계정 밖(이 파일)에 있어 여기서 더한다. 상한을 넘겨 가질 수 있다(PlayerVM.addEnergy). */
  function applyEnergyGrants(list) {
    (list || []).forEach(function (g) { if (g.kind === "energy") ENERGY += g.amount; });
  }

  function cardText(card) { return RwEcon.reqCodes(card).map(codeTag).join(" + "); }

  /* 빈 칸만 채운다 — 시작 · 납품 직후 · 레벨업 직후 · 예산 타이머가 깼을 때. */
  function refill(reason) {
    var made = RwEcon.fillRail(ACC, RAIL, boardCounts(), now());
    made.forEach(function (card) {
      logPush("order", "슬롯 " + card.slot + " 새 오더" + (card.type === "fixed" ? " (고정)" : " · " + card.type)
        + " — " + cardText(card) + ' <span class="rwb-dim">코인 ' + RwEcon.serveReward(card).coin
        + " · " + reason + "</span>");
    });
    return made;
  }

  /* [0] 보상 보관함 → 첫 빈 칸 (IngameVM.ts:1080-1100). 빈 칸이 없으면 꺼내지 않는다. */
  function dropReward() {
    if (!ACC.rewardBox.length) return -1;
    var dest = firstEmpty();
    if (dest < 0) return -1;
    var code = ACC.rewardBox.shift();
    S[dest] = { code: code, box: false, web: false };
    dropCellState(dest);
    logPush("reward", "보관함 → cell" + dest + " " + codeTag(code)
      + ' <span class="rwb-dim">남은 ' + ACC.rewardBox.length + "</span>");
    return dest;
  }

  /* [2] 슬롯 번호가 가장 낮은, 보드만으로 채워지는 카드. */
  function findServe() {
    var counts = boardCounts();
    for (var k = 0; k < RAIL.length; k++) {
      var s = RAIL[k];
      if (!s.card) continue;
      var r = RwEcon.serveCheck(s.card, counts);
      if (r.ok) return { slot: s.slot, check: r };
    }
    return null;
  }

  /* 소모는 요구 칸 배열 그대로, 잠기지 않은 첫 칸부터(IngameVM.ts:1858-1866 · findCellByCode). */
  function findCellByCode(code) {
    for (var i = 0; i < CELLS; i++) if (canPick(i) && S[i].code === code) return i;
    return -1;
  }

  /* 같은 코드의 짝이 보드에 있나(다음 단계가 있어야 짝이다). 움직일 수 있는 짝, 또는
     **도착지로만** 쓸 수 있는 거미줄 칸(상자 없는 것 — mergeCheckAt 이 상자 도착지를 막는다).
     거미줄 짝을 세야 수확·판매가 거미줄을 풀 수 있는 아이템을 버리지 않는다. */
  function hasPartner(i, counts) {
    var code = S[i].code, s = spec(code);
    if (!(s && s.next)) return false;
    if ((counts.get(code) || 0) >= 2) return true;
    for (var k = 0; k < CELLS; k++) {
      var c = S[k];
      if (k !== i && c && c.web && !c.box && c.code === code) return true;
    }
    return false;
  }

  /* [2.5] 수확 대상 — 재화 아이템(collect_reward_key) 중
       짝이 없거나(합칠 게 없으면 들고 있을 이유가 없다) · 빈 칸이 1개 이하(자리가 급하다).
     짝이 있으면 [3] 이 먼저 합친다 — 합친 뒤 수확하는 쪽이 보상이 크다(2701 ×2 = 4 < 2702 = 6).
     레일 요구품이면 건드리지 않는다(재화 아이템은 order_item 에 없어 실제로는 걸리지 않는다). */
  /* E2 — 코인(currency_coin)·젬(currency_gem) 아이템은 체인 마지막 단계(next == 0)에서만 수확한다.
     그 전에는 머지 대상으로만 둔다. 에너지는 종전 규칙(짝 없음 또는 빈 칸 ≤ 1). */
  function isMaxOnly(c) { return c.key === "currency_coin" || c.key === "currency_gem"; }

  function findCollect() {
    var counts = boardCounts(), need = railNeed(), free = 0;
    for (var k = 0; k < CELLS; k++) if (!S[k]) free++;
    for (var i = 0; i < CELLS; i++) {
      if (!canPick(i)) continue;
      var code = S[i].code, c = RwEcon.collectOf(code);
      if (!c || need.has(code)) continue;
      if (isMaxOnly(c)) {
        if (!(spec(code) || {}).next) return { index: i, code: code, reward: c, max: true };
        continue;
      }
      if (free <= 1 || !hasPartner(i, counts)) return { index: i, code: code, reward: c };
    }
    return null;
  }

  /* E2 막힘 해소 — 보드가 꽉 차 머지·개봉·꺼내기·탭이 다 막혔으면, 판매보다 먼저
     가장 높은 단계의 코인·젬 하나를 수확한다(낮은 코인이 짝 없이 칸을 영원히 차지하지 않게). */
  function findUnjamCollect() {
    var need = railNeed(), best = null;
    for (var i = 0; i < CELLS; i++) {
      if (!canPick(i)) continue;
      var code = S[i].code, c = RwEcon.collectOf(code);
      if (!c || !isMaxOnly(c) || need.has(code)) continue;
      var st = (spec(code) || {}).step || 0;
      if (!best || st > best.step) best = { index: i, code: code, reward: c, step: st, unjam: true };
    }
    return best;
  }

  /* [4] D4 — 오더 요구가 아니고 생성기·산출 상자·희귀·판매 금지(-1)가 아닌 것 중 판매가가 가장 낮은 것.
     헛돌기 방지: 직전 수에 뽑은 코드는 다른 후보가 없을 때만 팔고, 짝이 없는 것을 먼저 판다.
     정렬 = [직전 산출 여부, 짝 있음, 판매가, 칸 번호] 오름차순. */
  function findSell() {
    var need = railNeed(), counts = boardCounts(), best = null;
    for (var i = 0; i < CELLS; i++) {
      if (!canPick(i)) continue;
      var code = S[i].code, sp = RwEcon.spec(code);
      if (!sp || sp.is_generator === true || (spec(code) || {}).p) continue;
      var rare = typeof sp.rare === "number" ? sp.rare === 1 : Number(sp.show_sell_confirm) === 1;   // SellRules.ts:83 needsSellConfirm
      if (rare) continue;
      if (!(sp.selling_price >= 0)) continue;     // SellRules.ts:23 SELL_FORBIDDEN_PRICE
      if (need.has(code)) continue;
      var c = { index: i, code: code, price: sp.selling_price,
                recent: !!(LAST_PROD && LAST_PROD.n === STEP_N - 1 && LAST_PROD.code === code) ? 1 : 0,
                partner: hasPartner(i, counts) ? 1 : 0 };
      if (!best || c.recent < best.recent
          || (c.recent === best.recent && (c.partner < best.partner
          || (c.partner === best.partner && c.price < best.price)))) best = c;
    }
    return best;
  }

  /* ── 상자 개봉 (BoxRules.ts · IngameVM.ts:940-1000) ─────────────────── */
  /* 개봉이 끝났으면 점유를 풀고 그 칸을 열린 상자로 둔다(finishBoxOpen).
     chestNoTimer 를 재생 도중에 켜면 이미 열리는 중인 상자도 다음 수에 끝낸다 — 시작 시점에만 읽으면 안 먹는다. */
  function tickOpening() {
    if (!OPENING) return false;
    if (!opts().chestNoTimer && now() < OPENING.endAt) return false;
    OPENED.add(OPENING.cell);
    logPush("prod", "cell" + OPENING.cell + " " + codeTag(OPENING.code) + " 상자 개봉 완료");
    OPENING = null;
    return true;
  }

  /* BoxRules.ts:84-102 boxOpenCheck — 잠김 → 자기 자신 → 점유(Busy) 순서. 개봉 안 된 첫 상자. */
  function findOpen() {
    if (OPENING) return null;                      // Busy — 동시에 하나만
    for (var i = 0; i < CELLS; i++) {
      if (!canPick(i)) continue;                   // 덮개·거미줄은 개봉도 막는다(IngameVM.ts:951)
      if (!isOpenable(S[i].code) || OPENED.has(i)) continue;
      return i;
    }
    return null;
  }

  /* 막힌 게 기다림뿐이면 얼마나 감을지 — D-3 사유 넷 중 가장 이른 것.
     오더 타이머 · 에너지 회복(energyRefill 꺼짐) · 생성기 회복(젬 부족 · gemUnlimited 꺼짐) · 상자 개봉. */
  function waitPlan(boardFull) {
    var t = now(), best = null;
    function cand(sec, kind, what) { if (sec > 0 && (!best || sec < best.sec)) best = { sec: sec, kind: kind, what: what }; }
    var at = RwEcon.railNextAt(ACC, RAIL);
    if (at > 0) cand(at - t, "order", "오더 대기");
    if (OPENING) cand(OPENING.endAt - t, "prod", "상자 개봉");
    // 자동 생산기는 회복이 끝나면 스스로 놓는다 — 그것만으로 풀리는 판이 멈추지 않게 대기 후보에 넣는다
    for (var ai = 0; ai < CELLS; ai++) {
      if (!isAutoAt(ai) || autoNeighbor(ai) < 0) continue;
      var ast = prodAt(ai), ag = genRow(S[ai].code);
      project(ag, ast, t);
      if (ast.stock <= 0 && ast.timer !== T_NONE) cand(Math.max(AUTO_TICK_SEC, waitSec(ag, ast, t)), "prod", "생성기 회복(자동)");
    }
    if (!boardFull) {
      for (var i = 0; i < CELLS; i++) {
        if (!S[i]) continue;
        var r = produceCheckAt(i);
        if (r.reason === "recharging") cand(r.wait, "prod", "생성기 회복");
        else if (r.reason === "energy_short")
          cand(energyWait() + Math.max(0, r.need - ENERGY - 1) * ENERGY_REC, "energy", "에너지 회복");
      }
    }
    return best;
  }

  /* 시계를 감는다 — 로그 html 「시간 경과 · 사유 · +Ns」, stats.waitSec 에 더한다. */
  function skipTime(sec, kind, what) {
    CLOCK.t += sec;
    ACC.stats.waitSec = (ACC.stats.waitSec || 0) + sec;
    logPush(kind, "시간 경과 · " + what + " · +" + sec + "s");
  }

  /* 열린 칸이 전부 비어 있고 오더 추첨 타이머가 걸려 있으면 그 시각까지 시계를 감는다.
     C2 이후 늘 누를 생성기가 있어 [4] 의 빨리 감기가 안 오므로, 레일이 텅 빈 채 재고만 쌓이는 걸 막는다.
     한 장이라도 떠 있으면 그대로 둔다. */
  function railIdleSkip() {
    for (var k = 0; k < RAIL.length; k++) if (RAIL[k].card && RwEcon.slotOpen(ACC, RAIL[k])) return false;
    var t = now(), at = RwEcon.railNextAt(ACC, RAIL);
    if (!(at > t)) return false;
    skipTime(Math.ceil(at - t), "order", "오더 대기");
    refill("예산 회복");
    return true;
  }

  /* ── 렌더 ────────────────────────────────────────────────────────────── */
  function classOf(c) {
    if (!c) return "bc bc-empty";
    var k = "bc";
    if (c.box) k += " is-box";
    if (c.web) k += " is-web";
    if (!c.box && !c.web) k += " is-free";
    return k;
  }

  function titleOf(i, c) {
    var xy = "x" + (i % COLS + 1) + "·y" + (Math.floor(i / COLS) + 1);
    if (!c) return "cell " + i + " · " + xy + " · 빈 칸";
    var s = spec(c.code) || {};
    var lock = c.box && c.web ? "상자+거미줄" : c.box ? "상자" : c.web ? "거미줄" : "잠금 없음";
    var t = "cell " + i + " · " + xy + " · " + c.code + " " + (s.name || "")
      + " · 체인 " + s.chain + "-" + s.step + " · " + lock;
    if (s.p && PROD.has(i)) {
      var st = PROD.get(i), g = genRow(c.code);
      t += " · 재고 " + st.stock + "/" + s.p.max + (g.recover ? " · 창고 " + st.reserve + "/" + g.storeMax : "");
    }
    return t;
  }

  function build() {
    var b = $("#rwbBoard");
    b.innerHTML = "";
    for (var i = 0; i < CELLS; i++) b.appendChild(document.createElement("div"));
  }

  function render() {
    if (TURBO) { DIRTY = true; return; }
    var b = $("#rwbBoard");
    if (b.children.length !== CELLS) build();
    for (var i = 0; i < CELLS; i++) {
      var el = b.children[i], c = S[i];
      el.className = classOf(c);
      el.title = titleOf(i, c);
      var s = c ? (spec(c.code) || {}) : null;
      var badge = "";
      if (c && OPENING && OPENING.cell === i) {
        badge = '<span class="bc-gen" title="개봉 중">⏳' + Math.ceil(Math.max(0, OPENING.endAt - now())) + "</span>";
      } else if (c && s.p && isOpenable(c.code) && !OPENED.has(i)) {
        badge = '<span class="bc-gen" title="개봉 전 상자">📦</span>';
      } else if (c && s.p && !s.p.auto) {
        var st = PROD.get(i);
        badge = '<span class="bc-gen" title="생성기 재고">⚡' + (st ? st.stock : s.p.max) + "</span>";
      } else if (c && s.p && s.p.auto) {
        badge = '<span class="bc-gen" title="자동 산출 생성기 — 탭을 받지 않습니다">⏱</span>';
      }
      var src = c ? imgOf(c.code) : "";
      el.innerHTML = '<span class="bc-c">' + i + "</span>"
        + (c ? (src ? '<img src="' + src + '" alt="" loading="lazy" draggable="false" />' : "")
             + '<span class="bc-code">Lv ' + (s.step || 0) + ' · ' + c.code + "</span>"
             + '<span class="bc-nm">' + (s.name || nameOf(c.code)) + "</span>" + badge
           : "");
    }
    renderStats();
    renderLog();
    if (window.RwView && RwView.render) RwView.render(snap());
  }

  /* 화면(RwView)에 넘기는 상태 — 계약 부록 B3 모양 그대로. */
  function snap() {
    var counts = boardCounts();
    var chk = RwEcon.choreCheck(ACC), row = chk.row;
    var st = ACC.stats;
    return {
      level: ACC.level, exp: ACC.exp, expNeed: RwEcon.expNeed(ACC.level),
      coin: ACC.coin, gem: ACC.gem, energy: ENERGY, energyMax: ENERGY_MAX,
      stats: { merges: st.merges, energySpent: st.energySpent, orders: st.orders,
               chores: st.chores, recharges: st.recharges, sells: st.sells, collects: st.collects || 0,
               gemRecharges: st.gemRecharges || 0, gemSpent: st.gemSpent || 0, chestsEmptied: st.chestsEmptied || 0,
               chestOpens: st.chestOpens || 0, waitSec: st.waitSec || 0, gemGained: st.gemGained || 0 },
      opts: opts(),
      opening: OPENING ? { cell: OPENING.cell, code: OPENING.code, remainSec: Math.max(0, Math.ceil(OPENING.endAt - now())) } : null,
      choreTotal: RwEcon.choreTotal(),
      day: ACC.day, lastDay: RwEcon.lastDay(),
      dayDone: RwEcon.dayDone(ACC, ACC.day), dayTotal: RwEcon.dayRows(ACC.day).length,
      chore: row ? { key: row.day + "-" + row.task_seq, name: row.name || row.name_key, cost: chk.cost,
                     canStart: chk.ok, reason: chk.reason, rewards: RwEcon.rewardsOf(row) } : null,
      rewardBox: ACC.rewardBox.slice(),
      rail: RAIL.map(function (s) {
        var card = null;
        if (s.card) {
          card = { req: RwEcon.reqCodes(s.card), have: RwEcon.serveCheck(s.card, counts).have,
                   coin: RwEcon.serveReward(s.card).coin, fixed: s.card.type === "fixed" };
        }
        return { slot: s.slot, type: s.type, locked: !RwEcon.slotOpen(ACC, s), unlockLevel: s.unlockLevel, card: card };
      }),
      img: imgOf, name: nameOf, lv: lvOfCode,
    };
  }

  function renderStats() {
    var n = { bw: 0, w: 0, b: 0, free: 0 };
    for (var i = 0; i < CELLS; i++) {
      var c = S[i];
      if (!c) continue;
      if (c.box && c.web) n.bw++;
      else if (c.box) n.b++;
      else if (c.web) n.w++;
      else n.free++;
    }
    set("#rwbNbw", n.bw); set("#rwbNw", n.w); set("#rwbNb", n.b); set("#rwbNfree", n.free);
    set("#rwbNmv", LOG.length); set("#rwbEnergy", ENERGY);
    var wait = energyWait();
    set("#rwbEnergySub", ENERGY >= ENERGY_MAX ? "가득" : "+1까지 " + Math.ceil(wait) + "초");
  }

  function set(sel, v) { var e = $(sel); if (e) e.textContent = String(v); }

  function applySpeed() {
    $("#rwbBoard").style.setProperty("--sp", String(SPEED));
    var btns = document.querySelectorAll("#rwbSpeeds [data-sp]");
    for (var k = 0; k < btns.length; k++)
      btns[k].setAttribute("aria-pressed", Number(btns[k].getAttribute("data-sp")) === SPEED ? "true" : "false");
  }

  /* 재생 중에 바꿔도 된다 — 다음 수부터 새 배속이고, 연출/배치 재생은 루프가 알아서 갈아탄다. */
  function setSpeed(n) {
    if (SPEEDS.indexOf(n) < 0 || n === SPEED) return;
    now();                                         // 배속을 바꾸기 **전에** 지금까지 흐른 시간을 적립한다
    SPEED = n;
    applySpeed();
  }

  var KIND_LABEL = { chore: "심부름", order: "오더", level: "레벨업", reward: "보상", sell: "판매",
                     energy: "충전", day: "새 날", merge: "합치기", prod: "생산", gem: "젬" };

  function logLine(m, i) {
    var chip = '<span class="rwb-k k-' + m.kind + '">' + (KIND_LABEL[m.kind] || m.kind) + "</span>";
    var head = "<b>수 " + (i + 1) + "</b> ";
    if (m.kind === "merge") {
      return chip + head + "cell" + m.from + " → cell" + m.to + " <code>" + m.code + "</code> " + esc(nameOf(m.code))
        + (m.popped.length
            ? ' <span class="rwb-pop">상자 걷힘 ' + m.popped.map(function (c) { return "cell" + c; }).join(" · ") + "</span>"
            : ' <span class="rwb-dim">걷힌 상자 없음</span>');
    }
    if (m.kind === "prod" && m.html == null) {
      return chip + head + "cell" + m.from + " → cell" + m.to + " <code>" + m.code + "</code> " + esc(nameOf(m.code))
        + ' <span class="rwb-dim">에너지 −' + m.cost + " · 재고 " + m.stock + "</span>"
        + (m.lucky ? ' <span class="rwb-pop">럭키</span>' : "")
        + (m.refilled ? ' <span class="rwb-pop">주머니 재충전</span>' : "")
        + (m.emptied ? ' <span class="rwb-pop">상자 소진 — 칸 비움</span>' : "");
    }
    if (m.kind === "energy" && m.html == null) {
      return chip + head + "에너지 +" + m.amount + " → " + m.energy + ' <span class="rwb-dim">충전 ' + m.n + "회째</span>";
    }
    return chip + head + m.html;
  }

  function renderLog() {
    var box = $("#rwbLog");
    if (!box) return;
    if (!LOG.length) {
      box.innerHTML = '<p class="rwb-empty">재생을 누르면 보상 보관함 → 심부름 → 오더 → 머지·생산 → 판매 순으로 한 수씩 둡니다.</p>';
      return;
    }
    var out = [], last = Math.max(0, LOG.length - LOG_SHOW);
    for (var i = LOG.length - 1; i >= last; i--) out.push('<div class="rwb-l">' + logLine(LOG[i], i) + "</div>");
    box.innerHTML = out.join("");
  }

  function status(msg) {
    var e = $("#rwbStatus");
    if (!e || e.textContent === msg) return;
    e.textContent = msg;
    e.classList.remove("hit");
    void e.offsetWidth;
    e.classList.add("hit");
  }

  function flash(list, cls) {
    if (INSTANT || TURBO) return;
    var b = $("#rwbBoard");
    list.forEach(function (i) {
      var el = b.children[i];
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth;                         // 같은 칸이 연속으로 맞을 때 애니를 다시 태운다
      el.classList.add(cls);
      setTimeout(function () { el.classList.remove(cls); }, 620 / SPEED);
    });
  }

  /* 출발 칸의 그림이 도착 칸으로 날아간다. 판정과 무관한 연출이라 상태를 만지지 않는다. */
  function fly(from, to, code, done) {
    if (INSTANT || TURBO) { done(); return; }
    var b = $("#rwbBoard");
    var a = b.children[from].getBoundingClientRect();
    var z = b.children[to].getBoundingClientRect();
    var host = b.getBoundingClientRect();
    var el = document.createElement("div");
    el.className = "rwb-fly";
    el.style.width = a.width + "px";
    el.style.height = a.height + "px";
    el.style.transform = "translate(" + (a.left - host.left) + "px," + (a.top - host.top) + "px)";
    var src = imgOf(code);
    el.innerHTML = src ? '<img src="' + src + '" alt="" />' : "";
    b.appendChild(el);
    void el.offsetWidth;
    el.style.transition = "transform " + flyMs() + "ms cubic-bezier(.2,.7,.3,1)";
    el.style.transform = "translate(" + (z.left - host.left) + "px," + (z.top - host.top) + "px)";
    setTimeout(function () { el.remove(); done(); }, flyMs());
  }

  function markBoard(list) {
    if (INSTANT || TURBO) return;
    var b = $("#rwbBoard");
    list.forEach(function (x) { if (b.children[x.i]) b.children[x.i].classList.add(x.c); });
  }

  var STOP_MSG = {
    board_full: "보드가 가득 차서 더 생산할 수 없습니다",
    no_sell: "보드가 가득 찼고 팔 수 있는 아이템이 없습니다",
    no_generator: "누를 수 있는 생성기가 없습니다",
    ff_max: "시계를 감아도 둘 수 있는 수가 없습니다",
  };

  /* ── 한 수 ───────────────────────────────────────────────────────────── */
  function step(then) {
    if (BUSY) return;
    STEP_N++;
    tickOpening();                                 // 개봉 끝났으면 열린 상자로
    tickGenerators();                              // 자동 생산기 1초 틱
    railIdleSkip();                                // 레일이 통째로 비었으면 오더 타이머까지 감는다
    if (RwEcon.railDue(ACC, RAIL, now())) refill("예산 회복");
    sweepSpentChests();                            // C1 — [0] 보다 먼저

    var dropped = dropReward();                    // [0] 우선순위 단계가 아니라 매 수 맨 앞의 선처리

    if (RwEcon.choreCheck(ACC).ok) { runChore(then); return; }          // [1]

    var sv = findServe();                                               // [2]
    if (sv) { runServe(sv, then); return; }

    var cl = findCollect();                                             // [2.5]
    if (cl) { runCollect(cl, then); return; }

    // [3] E1 — 머지 → 개봉 시작 → 상자 꺼내기 → 생성기 탭
    var mv = findMerge();
    if (mv) { runMerge(mv, then); return; }
    var op = findOpen();
    if (op != null) { runOpen(op, then); return; }
    var cp = findProduce("chest");
    if (cp.index >= 0) { cp.chest = true; runProduce(cp, then); return; }
    var pr = findProduce("gen");
    if (pr.index >= 0) { runProduce(pr, then); return; }

    var full = firstEmpty() < 0;                                        // [4]
    if (full) {
      var uj = findUnjamCollect();                                      // E2 막힘 해소 — 판매보다 먼저
      if (uj) { runCollect(uj, then); return; }
      var sl = findSell();
      if (sl) { runSell(sl, then); return; }
    }
    if (dropped >= 0) { FF_RUN = 0; finish("보상 보관함 → cell" + dropped, [dropped], then); return; }

    // 막힌 게 기다림뿐이면 정지하지 않고 게임 시계를 감는다(D-3 사유 넷).
    var w = waitPlan(full);
    if (w && FF_RUN < FF_MAX) {
      FF_RUN++;
      var sec = Math.max(1, Math.ceil(w.sec));
      skipTime(sec, w.kind, w.what);
      render();
      status("수 " + LOG.length + " · " + w.what + " " + sec + "초를 건너뜀");
      if (then) then();
      return;
    }
    stop();
    status(w ? STOP_MSG.ff_max : full ? STOP_MSG.no_sell
      : STOP_MSG[(pr.why && pr.why.reason) || "no_generator"] || "더 진행할 수 없습니다");
  }

  /* 즉시 끝나는 수(심부름·납품·판매·보관함) 공통 마무리. */
  function finish(msg, cells, then) {
    render();
    flash(cells || [], "fx-pop");
    status("수 " + LOG.length + " · " + msg);
    if (then) then();
  }

  function runChore(then) {
    FF_RUN = 0;
    var r = RwEcon.doChore(ACC);
    if (!r.ok) { finish("심부름을 시작할 수 없습니다 (" + r.reason + ")", [], then); return; }
    applyEnergyGrants(r.grants);
    logPush("chore", "Day " + r.row.day + "-" + r.row.task_seq + " " + esc(r.row.name || r.row.name_key)
      + " · 코인 −" + r.spent + " → " + ACC.coin + " · 보상 " + fmtGrants(r.grants));
    r.levelUps.forEach(function (up) {
      applyEnergyGrants(up.rewards);
      logPush("level", "Lv" + up.from + " → Lv" + up.to + " · 보상 " + fmtGrants(up.rewards)
        + ' <span class="rwb-dim">(D3 — 클라는 지급하지 않는다)</span>');
    });
    if (r.dayAdvanced) logPush("day", "New day (Day " + r.day + ")");
    if (r.levelUps.length) refill("레벨업");
    finish("심부름 " + r.row.day + "-" + r.row.task_seq + " 완료 · 코인 −" + r.spent
      + (r.levelUps.length ? " · Lv" + ACC.level : "") + (r.dayAdvanced ? " · Day " + r.day : ""), [], then);
  }

  function runServe(sv, then) {
    FF_RUN = 0;
    var cells = [];
    sv.check.consume.forEach(function (code) {
      var i = findCellByCode(code);
      if (i < 0) return;
      S[i] = null;
      dropCellState(i);
      cells.push(i);
    });
    var out = RwEcon.onServed(ACC, RAIL, sv.slot);
    logPush("order", "슬롯 " + sv.slot + " 납품 — " + cardText(out.card) + " · cell" + cells.join("·cell")
      + " · 코인 +" + out.reward.coin + " → " + ACC.coin);
    refill("납품");
    finish("슬롯 " + sv.slot + " 납품 · 코인 +" + out.reward.coin, cells, then);
  }

  function runCollect(cl, then) {
    FF_RUN = 0;
    S[cl.index] = null;
    dropCellState(cl.index);
    var g = RwEcon.collect(ACC, cl.code);
    if (g) applyEnergyGrants([g]);                 // 에너지는 상한을 넘겨 받는다(PlayerVM.addEnergy)
    logPush("reward", "수확 cell" + cl.index + " " + codeTag(cl.code) + " · " + fmtGrants(g ? [g] : [])
      + (cl.unjam ? ' <span class="rwb-pop">막힘 해소</span>' : cl.max ? ' <span class="rwb-dim">최대 단계</span>' : "")
      + ' <span class="rwb-dim">(collect)</span>');
    var e = LOG[LOG.length - 1];
    e.collect = cl.code; e.unjam = !!cl.unjam; e.maxStep = !!cl.max;
    finish("수확 cell" + cl.index + " · " + nameOf(cl.code) + (g ? " · " + (KIND_KO[g.kind] || g.kind) + " +" + g.amount : ""),
      [cl.index], then);
  }

  function runSell(sl, then) {
    FF_RUN = 0;
    S[sl.index] = null;
    dropCellState(sl.index);
    ACC.coin += sl.price;                          // IngameVM.ts:686-709 sell
    ACC.stats.sells++;
    logPush("sell", "cell" + sl.index + " " + codeTag(sl.code) + " · 코인 +" + sl.price + " → " + ACC.coin
      + ' <span class="rwb-dim">(D4 — 보드가 가득 차 가장 싼 것)</span>');
    finish("판매 cell" + sl.index + " · " + nameOf(sl.code) + " · 코인 +" + sl.price, [sl.index], then);
  }

  function runMerge(mv, then) {
    BUSY = true; FF_RUN = 0;
    markBoard([{ i: mv.from, c: "is-src" }, { i: mv.to, c: "is-dst" }]);
    fly(mv.from, mv.to, S[mv.from].code, function () {
      var r = applyMerge(mv.from, mv.to);
      render();
      flash([mv.to], "fx-pop");
      if (r.popped.length) flash(r.popped, "fx-shock");
      status("수 " + LOG.length + " · 합치기 cell" + mv.from + " → cell" + mv.to + " · " + nameOf(r.code)
        + (r.popped.length ? " · 상자 " + r.popped.length + "칸 걷힘" : ""));
      BUSY = false;
      if (then) then();
    });
  }

  /* 개봉 시작 — BoxRules.boxOpenCheck 통과 뒤 점유를 세운다(IngameVM.ts:962-976 startBoxOpen).
     chestNoTimer 면 개봉 시간을 0 으로 본다(다음 수에 열린다). 젬 즉시 개봉은 하지 않는다. */
  function runOpen(i, then) {
    FF_RUN = 0;
    var preempt = findProduce("gen").index >= 0;   // 검증용 — 이 수에 생성기 탭도 가능했나
    var dur = opts().chestNoTimer ? 0 : openDurOf(S[i].code);
    OPENING = { cell: i, code: S[i].code, endAt: now() + dur };
    ACC.stats.chestOpens++;
    LOG.push({ kind: "prod", html: "cell" + i + " " + codeTag(S[i].code) + " · 상자 개봉 시작 · " + dur + "초",
               open: true, from: i, code: S[i].code, preempt: preempt });
    finish("상자 개봉 시작 cell" + i + " · " + nameOf(S[i].code) + " · " + dur + "초", [i], then);
  }

  function runProduce(pr, then) {
    BUSY = true; FF_RUN = 0;
    var preempt = pr.chest ? findProduce("gen").index >= 0 : false;
    markBoard([{ i: pr.index, c: "is-src" }, { i: pr.check.dest, c: "is-dst" }]);
    if (pr.gem && !gemRecharge(pr.index, pr.check)) {   // C2 — 채운 뒤 같은 수에서 누른다 · F3 못 쓰면 탭 안 함
      BUSY = false; finish("젬이 모자라 충전하지 않습니다", [], then); return;
    }
    var out = applyProduce(pr.index, pr.check);
    if (!out) { BUSY = false; stop(); status("주머니가 비어 더 뽑을 수 없습니다"); return; }
    if (pr.chest) { var e = LOG[LOG.length - 1]; e.chest = true; e.preempt = preempt; }
    fly(pr.index, out.dest, out.code, function () {
      render();
      flash([out.dest], "fx-pop");
      status("수 " + LOG.length + " · 생산 cell" + pr.index + " → cell" + out.dest + " · " + nameOf(out.code)
        + " · 에너지 " + ENERGY + (pr.gem ? " · 젬 충전" : "") + (out.emptied ? " · 상자 소진" : ""));
      BUSY = false;
      if (then) then();
    });
  }

  /* ── 재생 ────────────────────────────────────────────────────────────── */
  function tick() {
    if (SPEED >= BATCH_FROM) { batchStart(); return; }
    step(function () {
      if (!PLAYING) return;
      TIMER = setTimeout(tick, Math.max(16, stepMs() - flyMs()));
    });
  }

  /* 배치 재생(16배속부터) — 한 수 간격 420/배속 ms 를 벽시계로 적립해 이번 프레임에 둘 수를 정하고,
     그림은 프레임 끝에 한 번 그린다. 규칙 계산은 한 수 0.05ms, render 가 8ms 라(헤드리스 실측)
     그리는 횟수만 줄이면 64배속도 버틴다. 연출 재생은 8배속에서 날기 바닥(40ms)에 닿아 더 못 빨라진다. */
  function batchStart() {
    RAF_AT = performance.now();
    RAF_ACC = 0;
    RAF = requestAnimationFrame(batchFrame);
  }

  function batchFrame(ts) {
    RAF = 0;
    if (!PLAYING) return;
    if (SPEED < BATCH_FROM) { tick(); return; }    // 재생 중에 8배속 이하로 내리면 연출 재생으로 돌아간다
    var gap = STEP_MS / SPEED;
    RAF_ACC += Math.max(0, ts - RAF_AT);
    RAF_AT = ts;
    var n = Math.min(BATCH_CAP, Math.floor(RAF_ACC / gap));
    RAF_ACC = n >= BATCH_CAP ? 0 : RAF_ACC - n * gap;   // 상한에 걸리면 밀린 몫은 버린다(탭 복귀 직후)
    if (n > 0) {
      TURBO = true;
      DIRTY = false;
      try { for (var k = 0; k < n && PLAYING; k++) step(); }
      finally { TURBO = false; }
      if (DIRTY) render();
    }
    if (PLAYING) RAF = requestAnimationFrame(batchFrame);
  }

  function play() {
    if (PLAYING) return;
    PLAYING = true;
    $("#rwbPlay").textContent = "⏸ 일시정지";
    tick();
  }

  function stop() {
    PLAYING = false;
    clearTimeout(TIMER);
    if (RAF) { cancelAnimationFrame(RAF); RAF = 0; }
    var e = $("#rwbPlay");
    if (e) e.textContent = "▶ 재생";
  }

  function reset() {
    stop();
    BUSY = false; FF_RUN = 0; STEP_N = 0; LAST_PROD = null;
    S = DB.board.map(function (c) { return c ? { code: c.code, box: c.box, web: c.web } : null; });
    PROD = new Map();
    BAGS = new Map();
    OPENED = new Set();
    OPENING = null;
    AUTO_AT = -Infinity;
    ENERGY = ENERGY_MAX = DB._meta.energy;
    ENERGY_REC = DB._meta.energyRec || 0;
    CLOCK = { t: 0, wall: Date.now() / 1000 };     // 게임 시각도 같이 되감는다
    ENERGY_AT = 0;
    LOG = [];
    ACC = RwEcon.newAccount();                     // 엔진 상태(고정 오더 순번·예산·난수)도 같이 새로
    RAIL = RwEcon.makeRail();
    refill("시작");
    render();
    status("초기 상태 — 잠금 없는 칸은 cell22 · cell29 두 곳뿐입니다");
  }

  /* 검증 훅 — 살아 있는 객체를 그대로 준다. instant 를 켜면 연출 없이 한 수가 동기로 끝난다. */
  window.__RWB = {
    get acc() { return ACC; },
    get rail() { return RAIL; },
    get cells() { return S; },
    get energy() { return ENERGY; },
    get log() { return LOG; },
    get clock() { return CLOCK; },
    get prod() { return PROD; },
    // 재고 레코드 순수 함수 — 검사기가 가짜 시각으로 클라 규칙을 직접 대조한다
    produce: { genRow: genRow, newRec: newRec, consume: consume, project: project, complete: complete,
               waitSec: waitSec, speedupCost: speedupCost, gemCostAt: gemCostAt,
               luckyRowFor: luckyRowFor, rollLucky: rollLucky, spiralOrderFrom: spiralOrderFrom,
               autoNeighbor: autoNeighbor, isBoxUsedAt: isBoxUsedAt, mergeCheckAt: mergeCheckAt,
               bagKey: bagKey, commitRoll: commitRoll },
    get snap() { return snap(); },
    get instant() { return INSTANT; },
    set instant(v) { INSTANT = !!v; },
    step: function (then) { step(then); },
  };

  /* ── 기동 ────────────────────────────────────────────────────────────── */
  fetch(DATA_URL, { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (json) {
      DB = json;
      if (!window.RwEcon || !DB.bal) throw new Error(!window.RwEcon ? "rosewood-econ.js 없음" : "bal 없음");
      RwEcon.init(DB.bal);
      build();
      reset();
      $("#rwbPlay").addEventListener("click", function () { PLAYING ? stop() : play(); });
      $("#rwbStep").addEventListener("click", function () { stop(); step(); });
      $("#rwbReset").addEventListener("click", reset);
      $("#rwbSpeeds").addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest("[data-sp]") : null;
        if (b) setSpeed(Number(b.getAttribute("data-sp")));
      });
      applySpeed();
    })
    .catch(function (e) {
      $("#rwbBoard").innerHTML = '<p class="rwb-empty" style="grid-column:1/-1">'
        + (location.protocol === "file:"
            ? "<code>file://</code> 로 열면 데이터 파일을 못 읽습니다. 허브 URL 로 열어 주세요."
            : "보드 데이터를 불러오지 못했습니다 (" + e.message + ")") + "</p>";
    });
})();
