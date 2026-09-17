/* ============================================================================
   rosewood-board.js — 초기 보드를 스스로 풀어 보이는 판 하나.

   판정은 클라 구현(`IngameVM` · `MergeRules` · `ProduceRules`)을 그대로 옮긴 것이고,
   여기서 규칙을 새로 만들지 않는다. 옮긴 것은 이만큼이다.
     canPick        집기는 상자·거미줄을 **둘 다** 막는다
     mergeCheckAt   놓기는 상자만 막는다 — 거미줄 칸은 도착지로 **연다**
     mergeCheck     같은 체인·같은 단계 + 다음 단계가 있을 것
     shock          4방향 · 상자만 반응 · 드러난 칸이 움직일 수 있으면 연쇄
     produceCheck   재고 → 빈칸 → 에너지 → 산출 순서. 자동 산출 생성기는 탭을 안 받는다
     drawFromBag    `produce_weight_N` 은 확률이 아니라 **개수**. 비면 재충전(방식 1)
     rechargeStock  `경과 ÷ 회복초` 만큼 채우고 나머지 초는 버리지 않는다
   옮기지 않은 것: 럭키 산출(`lucky_produce`)·천장·소모형 개체 주머니(방식 2).
   지금 시트에서 이 보드가 닿는 생성기 47종은 전부 방식 1이고 럭키 행이 없다.

   사람이 끌어다 놓는 대신 **재생**이 머지를 찾아 두고, 둘 게 없으면 생성기를 눌러
   산출을 빈 칸에 떨어뜨린 뒤 다시 머지를 본다. 후보를 인덱스 오름차순으로 고르면
   같은 보드에서 늘 같은 순서가 나온다.
   ========================================================================== */
(function () {
  "use strict";

  var DATA_URL = "data/rosewood-board.json";
  var COLS = 7, ROWS = 9, CELLS = COLS * ROWS;
  var STEP_MS = 420;                               // 한 수와 다음 수 사이 (1배속 기준)
  var FLY_MS = 240;                                // 칩이 날아가는 시간 (1배속 기준)
  var SPEEDS = [1, 2, 4, 8];
  var SPEED = 1;                                   // 간격·연출을 **같은 배수**로 줄인다.
                                                   // 한쪽만 줄이면 8배속에서 칩이 도착하기 전에 다음 수가 들어온다.
  function stepMs() { return Math.max(24, STEP_MS / SPEED); }
  function flyMs() { return Math.max(40, FLY_MS / SPEED); }

  var DB = null;     // { board, items, _meta }
  var S = null;      // 현재 보드 — [{code,box,web}|null] × 63
  var PROD = null;   // 칸 번호 → { code, stock, lastAt } — 생성기 재고는 칸에 붙는다
  var BAGS = null;   // 아이템 코드 → 잔량 배열 — 방식 1은 **종류별 하나**를 공유한다
  var ENERGY = 0, ENERGY_MAX = 0, ENERGY_REC = 0, ENERGY_AT = 0;
  var LOG = [];
  var PLAYING = false, TIMER = null, BUSY = false;
  var LAST_PROGRESS = 0;                           // 마지막으로 수를 둔 시각(초)
  var IDLE_MAX_SEC = 400;                          // 게임 시각으로 이만큼 못 두면 멈춘다
                                                   // (에너지 1칸 = 120초라 그보다 넉넉해야 한다)
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
  function nameOf(code) { var s = spec(code); return s ? s.name : String(code); }
  function imgOf(code) { return "img/items/" + code + ".png"; }

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
    return mergeCheck(S[from], t);
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

  /* 둘 수 있는 머지 한 수. 이동(`move`)은 후보로 보지 않는다 — 빈 칸으로 옮겨 봐야
     보드 상태가 제자리를 돈다. */
  function findMerge() {
    for (var from = 0; from < CELLS; from++) {
      if (!canPick(from)) continue;
      for (var to = 0; to < CELLS; to++) {
        if (to === from) continue;
        var r = mergeCheckAt(from, to);
        if (r.ok && r.kind === "merge") return { from: from, to: to, code: r.code };
      }
    }
    return null;
  }

  function applyMerge(from, to) {
    var r = mergeCheckAt(from, to);
    if (!r.ok) return r;
    S[from] = null;
    S[to] = { code: r.code, box: false, web: false };
    PROD.delete(from);                             // 떠난 칸의 재고 기록을 지운다
    PROD.delete(to);                               // 합친 결과는 다른 코드의 새 개체다
    var popped = [];
    shock(to, [], popped);                         // 합치기에만 걸린다 — 이동은 트리거가 아니다
    popped.sort(function (a, b) { return a - b; });
    LOG.push({ t: "merge", from: from, to: to, code: r.code, popped: popped });
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

  /* 재고 기록은 칸에 붙는다. 코드가 바뀌었으면(합쳐졌으면) 다른 개체라 새로 만든다.
     기록이 없을 때 만땅으로 시작하는 것도 클라와 같다 — 저장본 없는 첫 진입의 동작이다. */
  function prodAt(i, p) {
    var st = PROD.get(i);
    if (!st || st.code !== S[i].code) {
      st = { code: S[i].code, stock: p.max, lastAt: now() };
      PROD.set(i, st);
    }
    return st;
  }

  /* IngameVM.rechargeStock — 나머지 초를 버리지 않으려고 lastAt 을 간격 배수로만 민다. */
  function recharge(st, p) {
    if (p.rec <= 0 || st.stock >= p.max) return;
    var elapsed = now() - st.lastAt;
    if (elapsed < 0) { st.lastAt = now(); return; }
    if (elapsed < p.rec) return;
    var gained = Math.floor(elapsed / p.rec);
    st.stock = Math.min(p.max, st.stock + gained);
    st.lastAt = st.stock >= p.max ? now() : st.lastAt + gained * p.rec;
  }

  /* 탭 가능 여부 — 재고 → 빈칸 → 에너지 → 산출 순서(정본). 어느 단계에서 막히든 아무것도 깎지 않는다. */
  function produceCheckAt(i) {
    var c = S[i];
    if (!c || c.box || c.web) return { ok: false, reason: "no_produce" };
    var p = (spec(c.code) || {}).p;
    if (!p) return { ok: false, reason: "no_produce" };
    if (p.auto) return { ok: false, reason: "auto_only" };   // 자동 산출은 탭을 받지 않는다
    var st = prodAt(i, p);
    recharge(st, p);
    if (st.stock <= 0) return { ok: false, reason: "recharging", wait: Math.max(0, p.rec - (now() - st.lastAt)) };
    var dest = firstEmpty();
    if (dest < 0) return { ok: false, reason: "board_full" };
    if (ENERGY < p.cost) return { ok: false, reason: "energy_short", wait: energyWait() };
    return { ok: true, dest: dest, p: p, st: st };
  }

  /* 보드에서 지금 누를 수 있는 생성기 하나. 없으면 왜 없는지까지 돌려준다. */
  function findProduce() {
    rechargeEnergy();
    var why = null;
    for (var i = 0; i < CELLS; i++) {
      var r = produceCheckAt(i);
      if (r.ok) return { index: i, check: r };
      if (r.reason === "no_produce" || r.reason === "auto_only") continue;
      // 막힌 사유는 「생성기가 아예 없다」와 구분해야 해서 남긴다. 기다리면 풀리는 사유가 가장 약하다.
      if (!why || !isWait(why)) why = r;
    }
    return { index: -1, why: why };
  }

  /* ProduceRules.drawFromBag — `produce_weight_N` 은 개수다. 뽑으면 그 칸이 1 줄고,
     다 비면 방식 1은 재충전한다(지금 시트의 생성기는 전부 방식 1). */
  function drawFromBag(code, p) {
    var remain = BAGS.get(code);
    if (!remain || remain.length !== p.slots.length) remain = p.slots.map(function (s) { return s[1]; });
    var total = remain.reduce(function (a, b) { return a + b; }, 0);
    var refilled = false;
    if (total <= 0) {
      if (p.wt === 2) return null;                 // 소모형은 재충전하지 않는다
      remain = p.slots.map(function (s) { return s[1]; });
      total = remain.reduce(function (a, b) { return a + b; }, 0);
      refilled = true;
    }
    var r = Math.floor(Math.random() * total);
    for (var i = 0; i < remain.length; i++) {
      r -= remain[i];
      if (r >= 0) continue;
      remain[i] -= 1;
      BAGS.set(code, remain);
      return { code: p.slots[i][0], refilled: refilled };
    }
    return null;
  }

  /* 기다리면 풀리는 사유. 보드가 가득하거나 생성기가 없는 것과 달리 시간이 해결한다. */
  function isWait(r) { return r && (r.reason === "recharging" || r.reason === "energy_short"); }

  function applyProduce(i, check) {
    var draw = drawFromBag(S[i].code, check.p);
    if (!draw) return null;
    if (ENERGY >= ENERGY_MAX) ENERGY_AT = now();   // 만땅에서 처음 쓰는 순간부터 회복 시계가 돈다
    ENERGY -= check.p.cost;                        // 에너지가 먼저, 그 다음 재고
    check.st.stock -= 1;
    check.st.lastAt = now();
    S[check.dest] = { code: draw.code, box: false, web: false };
    LOG.push({ t: "produce", from: i, to: check.dest, code: draw.code, cost: check.p.cost,
               stock: check.st.stock, refilled: draw.refilled });
    return { dest: check.dest, code: draw.code };
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
    if (s.p && PROD.has(i)) t += " · 재고 " + PROD.get(i).stock + "/" + s.p.max;
    return t;
  }

  function build() {
    var b = $("#rwbBoard");
    b.innerHTML = "";
    for (var i = 0; i < CELLS; i++) b.appendChild(document.createElement("div"));
  }

  function render() {
    var b = $("#rwbBoard");
    if (b.children.length !== CELLS) build();
    for (var i = 0; i < CELLS; i++) {
      var el = b.children[i], c = S[i];
      el.className = classOf(c);
      el.title = titleOf(i, c);
      var s = c ? (spec(c.code) || {}) : null;
      var badge = "";
      if (c && s.p && !s.p.auto) {
        var st = PROD.get(i);
        badge = '<span class="bc-gen" title="생성기 재고">⚡' + (st ? st.stock : s.p.max) + "</span>";
      } else if (c && s.p && s.p.auto) {
        badge = '<span class="bc-gen" title="자동 산출 생성기 — 탭을 받지 않습니다">⏱</span>';
      }
      el.innerHTML = '<span class="bc-c">' + i + "</span>"
        + (c ? '<img src="' + imgOf(c.code) + '" alt="" loading="lazy" draggable="false" />'
             + '<span class="bc-code">' + c.code + "</span>"
             + '<span class="bc-nm">' + (s.name || "") + "</span>" + badge
           : "");
    }
    renderStats();
    renderLog();
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
    $("#rwbSpeed").textContent = "⏩ " + SPEED + "배속";
  }

  function cycleSpeed() {
    now();                                         // 배속을 바꾸기 **전에** 지금까지 흐른 시간을 적립한다
    SPEED = SPEEDS[(SPEEDS.indexOf(SPEED) + 1) % SPEEDS.length];
    applySpeed();
  }

  function renderLog() {
    var box = $("#rwbLog");
    if (!LOG.length) {
      box.innerHTML = '<p class="rwb-empty">재생을 누르면 머지를 찾아 두고, 둘 게 없으면 생성기를 눌러 다시 봅니다.</p>';
      return;
    }
    var out = [];
    for (var i = LOG.length - 1; i >= 0; i--) {
      var m = LOG[i], head = "수 " + (i + 1) + " · cell" + m.from + " → cell" + m.to;
      if (m.t === "merge") {
        out.push('<div class="rwb-l"><b>' + head + "</b> 합치기 <code>" + m.code + "</code> " + nameOf(m.code)
          + (m.popped.length
              ? ' <span class="rwb-pop">상자 걷힘 ' + m.popped.map(function (c) { return "cell" + c; }).join(" · ") + "</span>"
              : ' <span class="rwb-dim">걷힌 상자 없음</span>') + "</div>");
      } else {
        out.push('<div class="rwb-l"><b>' + head + "</b> 생산 <code>" + m.code + "</code> " + nameOf(m.code)
          + ' <span class="rwb-dim">에너지 −' + m.cost + " · 재고 " + m.stock + "</span>"
          + (m.refilled ? ' <span class="rwb-pop">주머니 재충전</span>' : "") + "</div>");
      }
    }
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
    var b = $("#rwbBoard");
    list.forEach(function (i) {
      var el = b.children[i];
      el.classList.remove(cls);
      void el.offsetWidth;                         // 같은 칸이 연속으로 맞을 때 애니를 다시 태운다
      el.classList.add(cls);
      setTimeout(function () { el.classList.remove(cls); }, 620 / SPEED);
    });
  }

  /* 출발 칸의 그림이 도착 칸으로 날아간다. 판정과 무관한 연출이라 상태를 만지지 않는다. */
  function fly(from, to, code, done) {
    var b = $("#rwbBoard");
    var a = b.children[from].getBoundingClientRect();
    var z = b.children[to].getBoundingClientRect();
    var host = b.getBoundingClientRect();
    var el = document.createElement("div");
    el.className = "rwb-fly";
    el.style.width = a.width + "px";
    el.style.height = a.height + "px";
    el.style.transform = "translate(" + (a.left - host.left) + "px," + (a.top - host.top) + "px)";
    el.innerHTML = '<img src="' + imgOf(code) + '" alt="" />';
    b.appendChild(el);
    void el.offsetWidth;
    el.style.transition = "transform " + flyMs() + "ms cubic-bezier(.2,.7,.3,1)";
    el.style.transform = "translate(" + (z.left - host.left) + "px," + (z.top - host.top) + "px)";
    setTimeout(function () { el.remove(); done(); }, flyMs());
  }

  var STOP_MSG = {
    board_full: "보드가 가득 차서 더 생산할 수 없습니다",
    energy_short: "에너지가 모자랍니다",
    no_generator: "누를 수 있는 생성기가 없습니다",
  };

  /* ── 한 수 ───────────────────────────────────────────────────────────── */
  function step(then) {
    if (BUSY) return;
    var mv = findMerge();
    if (mv) { runMerge(mv, then); return; }

    var pr = findProduce();
    if (pr.index >= 0) { runProduce(pr, then); return; }

    // 회복 대기는 정지가 아니다 — 시간이 지나면 다시 눌릴 칸이라 재생을 그대로 둔다.
    var idle = now() - LAST_PROGRESS;
    if (isWait(pr.why) && idle < IDLE_MAX_SEC) {
      renderStats();
      status((pr.why.reason === "energy_short" ? "에너지 회복 대기 " : "재고 회복 대기 ")
        + Math.ceil(pr.why.wait) + "초 — 게임 시각 기준, 배속만큼 빨리 흐릅니다");
      if (then) then();
      return;
    }
    if (idle >= IDLE_MAX_SEC) { stop(); status("회복을 기다려도 둘 수 있는 수가 없습니다"); return; }
    stop();
    status(STOP_MSG[(pr.why && pr.why.reason) || "no_generator"] || "더 진행할 수 없습니다");
  }

  function runMerge(mv, then) {
    BUSY = true; LAST_PROGRESS = now();
    var b = $("#rwbBoard");
    b.children[mv.from].classList.add("is-src");
    b.children[mv.to].classList.add("is-dst");
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

  function runProduce(pr, then) {
    BUSY = true; LAST_PROGRESS = now();
    var b = $("#rwbBoard");
    b.children[pr.index].classList.add("is-src");
    b.children[pr.check.dest].classList.add("is-dst");
    var out = applyProduce(pr.index, pr.check);
    if (!out) { BUSY = false; stop(); status("주머니가 비어 더 뽑을 수 없습니다"); return; }
    fly(pr.index, out.dest, out.code, function () {
      render();
      flash([out.dest], "fx-pop");
      status("수 " + LOG.length + " · 생산 cell" + pr.index + " → cell" + out.dest + " · " + nameOf(out.code)
        + " · 에너지 " + ENERGY);
      BUSY = false;
      if (then) then();
    });
  }

  /* ── 재생 ────────────────────────────────────────────────────────────── */
  function tick() {
    step(function () {
      if (!PLAYING) return;
      TIMER = setTimeout(tick, Math.max(16, stepMs() - flyMs()));
    });
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
    $("#rwbPlay").textContent = "▶ 재생";
  }

  function reset() {
    stop();
    BUSY = false; LAST_PROGRESS = now();
    S = DB.board.map(function (c) { return c ? { code: c.code, box: c.box, web: c.web } : null; });
    PROD = new Map();
    BAGS = new Map();
    ENERGY = ENERGY_MAX = DB._meta.energy;
    ENERGY_REC = DB._meta.energyRec || 0;
    CLOCK = { t: 0, wall: Date.now() / 1000 };     // 게임 시각도 같이 되감는다
    ENERGY_AT = 0;
    LOG = [];
    render();
    status("초기 상태 — 잠금 없는 칸은 cell22 · cell29 두 곳뿐입니다");
  }

  /* ── 기동 ────────────────────────────────────────────────────────────── */
  fetch(DATA_URL, { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (json) {
      DB = json;
      build();
      reset();
      $("#rwbPlay").addEventListener("click", function () { PLAYING ? stop() : play(); });
      $("#rwbStep").addEventListener("click", function () { stop(); step(); });
      $("#rwbReset").addEventListener("click", reset);
      $("#rwbSpeed").addEventListener("click", cycleSpeed);
      applySpeed();
    })
    .catch(function (e) {
      $("#rwbBoard").innerHTML = '<p class="rwb-empty" style="grid-column:1/-1">'
        + (location.protocol === "file:"
            ? "<code>file://</code> 로 열면 데이터 파일을 못 읽습니다. 허브 URL 로 열어 주세요."
            : "보드 데이터를 불러오지 못했습니다 (" + e.message + ")") + "</p>";
    });
})();
