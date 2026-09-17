/* ============================================================================
   rosewood-board.js — 초기 보드를 스스로 풀어 보이는 판 하나.

   판정은 클라 구현(`IngameVM` · `MergeRules`)을 그대로 옮긴 것이고, 여기서 규칙을
   새로 만들지 않는다. 옮긴 것은 넷뿐이다.
     canPick      집기는 상자·거미줄을 **둘 다** 막는다
     mergeCheckAt 놓기는 상자만 막는다 — 거미줄 칸은 도착지로 **연다**
     mergeCheck   같은 체인·같은 단계 + 다음 단계가 있을 것
     shock        4방향 · 상자만 반응 · 드러난 칸이 움직일 수 있으면 연쇄

   사람이 끌어다 놓는 대신 **재생**이 가능한 머지를 찾아 연달아 둔다. 후보를
   출발 칸 · 도착 칸 오름차순으로 고르면 정본 튜토리얼 3수와 같은 순서가 나온다.
   ========================================================================== */
(function () {
  "use strict";

  var DATA_URL = "data/rosewood-board.json";
  var COLS = 7, ROWS = 9, CELLS = COLS * ROWS;
  var STEP_MS = 620;                               // 한 수와 다음 수 사이
  var FLY_MS = 300;                                // 칩이 날아가는 시간

  var DB = null;     // { board, items }
  var S = null;      // 현재 보드 — [{code,box,web}|null] × 63
  var LOG = [];
  var PLAYING = false, TIMER = null, BUSY = false;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  /* ── 조회 ────────────────────────────────────────────────────────────── */
  function spec(code) { return DB.items[String(code)] || null; }
  function nameOf(code) { var s = spec(code); return s ? s.name : String(code); }
  function imgOf(code) { return "img/items/" + code + ".png"; }

  /* ── 판정 (클라 이식) ────────────────────────────────────────────────── */
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

  /* 둘 수 있는 머지 한 수. 출발 · 도착 오름차순이라 같은 보드에서 늘 같은 순서가 나온다.
     이동(`move`)은 후보로 보지 않는다 — 보드를 푸는 건 머지뿐이라 빈 칸으로 옮겨 봐야
     상태가 제자리를 돈다. */
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

  /* 적용. 돌려주는 값이 그대로 로그 한 줄이 된다. */
  function apply(from, to) {
    var r = mergeCheckAt(from, to);
    if (!r.ok) return r;
    S[from] = null;
    S[to] = { code: r.code, box: false, web: false };
    var popped = [];
    shock(to, [], popped);                         // 합치기에만 걸린다 — 이동은 트리거가 아니다
    popped.sort(function (a, b) { return a - b; });
    r.popped = popped;
    LOG.push({ from: from, to: to, code: r.code, popped: popped });
    return r;
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
    return "cell " + i + " · " + xy + " · " + c.code + " " + (s.name || "")
      + " · 체인 " + s.chain + "-" + s.step + " · " + lock;
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
      el.innerHTML = '<span class="bc-c">' + i + "</span>"
        + (c ? '<img src="' + imgOf(c.code) + '" alt="" loading="lazy" draggable="false" />'
             + '<span class="bc-code">' + c.code + "</span>"
             + '<span class="bc-nm">' + (s.name || "") + "</span>"
             + (s.gen ? '<span class="bc-gen" title="생성기">⚡</span>' : "")
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
    set("#rwbNmv", LOG.length);
  }

  function set(sel, v) { var e = $(sel); if (e) e.textContent = String(v); }

  function renderLog() {
    var box = $("#rwbLog");
    if (!LOG.length) {
      box.innerHTML = '<p class="rwb-empty">재생을 누르면 둘 수 있는 머지를 찾아 연달아 둡니다.</p>';
      return;
    }
    var out = [];
    for (var i = LOG.length - 1; i >= 0; i--) {
      var m = LOG[i];
      out.push('<div class="rwb-l"><b>수 ' + (i + 1) + " · cell" + m.from + " → cell" + m.to
        + "</b> <code>" + m.code + "</code> " + nameOf(m.code)
        + (m.popped.length
            ? ' <span class="rwb-pop">상자 걷힘 ' + m.popped.map(function (c) { return "cell" + c; }).join(" · ") + "</span>"
            : ' <span class="rwb-dim">걷힌 상자 없음</span>') + "</div>");
    }
    box.innerHTML = out.join("");
  }

  function status(msg) { set("#rwbStatus", msg); }

  function flash(list, cls) {
    var b = $("#rwbBoard");
    list.forEach(function (i) {
      var el = b.children[i];
      el.classList.remove(cls);
      void el.offsetWidth;                         // 같은 칸이 연속으로 맞을 때 애니를 다시 태운다
      el.classList.add(cls);
      setTimeout(function () { el.classList.remove(cls); }, 620);
    });
  }

  /* 출발 칸의 그림이 도착 칸으로 날아간다. 판정과 무관한 연출이라 상태를 만지지 않는다. */
  function fly(from, to, done) {
    var b = $("#rwbBoard");
    var a = b.children[from].getBoundingClientRect();
    var z = b.children[to].getBoundingClientRect();
    var host = b.getBoundingClientRect();
    var el = document.createElement("div");
    el.className = "rwb-fly";
    el.style.width = a.width + "px";
    el.style.height = a.height + "px";
    el.style.transform = "translate(" + (a.left - host.left) + "px," + (a.top - host.top) + "px)";
    el.innerHTML = '<img src="' + imgOf(S[from].code) + '" alt="" />';
    b.appendChild(el);
    void el.offsetWidth;
    el.style.transition = "transform " + FLY_MS + "ms cubic-bezier(.2,.7,.3,1)";
    el.style.transform = "translate(" + (z.left - host.left) + "px," + (z.top - host.top) + "px)";
    setTimeout(function () { el.remove(); done(); }, FLY_MS);
  }

  /* ── 재생 ────────────────────────────────────────────────────────────── */
  function step(then) {
    if (BUSY) return;
    var mv = findMerge();
    if (!mv) {
      stop();
      status("더 둘 수 있는 머지가 없습니다 — 여기서부터는 생성기가 돌아야 합니다");
      return;
    }
    BUSY = true;
    $("#rwbBoard").children[mv.from].classList.add("is-src");
    $("#rwbBoard").children[mv.to].classList.add("is-dst");
    fly(mv.from, mv.to, function () {
      var r = apply(mv.from, mv.to);
      render();
      flash([mv.to], "fx-pop");
      if (r.popped.length) flash(r.popped, "fx-shock");
      status("수 " + LOG.length + " · cell" + mv.from + " → cell" + mv.to + " · " + nameOf(r.code)
        + (r.popped.length ? " · 상자 " + r.popped.length + "칸 걷힘" : ""));
      BUSY = false;
      if (then) then();
    });
  }

  function tick() {
    step(function () {
      if (!PLAYING) return;
      TIMER = setTimeout(tick, STEP_MS - FLY_MS);
    });
  }

  function play() {
    if (PLAYING) return;
    if (!findMerge()) { status("더 둘 수 있는 머지가 없습니다 — 초기화 후 다시 재생하세요"); return; }
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
    BUSY = false;
    S = DB.board.map(function (c) { return c ? { code: c.code, box: c.box, web: c.web } : null; });
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
    })
    .catch(function (e) {
      $("#rwbBoard").innerHTML = '<p class="rwb-empty" style="grid-column:1/-1">'
        + (location.protocol === "file:"
            ? "<code>file://</code> 로 열면 데이터 파일을 못 읽습니다. 허브 URL 로 열어 주세요."
            : "보드 데이터를 불러오지 못했습니다 (" + e.message + ")") + "</p>";
    });
})();
