/* Yard 데코 터치영역 - 구멍 메우기 + 부풀리기 미리보기 (yard-deco-style-compare.html 의 #tz-fill 블록 전용).
   데이터: data/yard-deco-touch-fill.json (클라이언트 레포 _ignore/deco-touch-fill 이 touch_mask.json 비트에서 뽑은 것: 막힌 구멍이 있는 프레임만),
   그림: img/yard-deco-touch/fill/<id>.png (불투명 영역 썸네일). 메우기 / 부풀리기는 브라우저에서 바로 계산한다.
   장면 수치(stats)는 월드 4px 격자에서 미리 계산해 둔 값이다. */
(function () {
  "use strict";

  var root = document.getElementById("tz-fill");
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var PAD = 4;

  function decode(b64, n) {
    var bin = atob(b64), g = new Uint8Array(n);
    for (var i = 0; i < n; i++) g[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
    return g;
  }

  /* 바깥(가장자리)에서 닿을 수 없는 빈 칸 = 막힌 구멍 -> 채운다. */
  function fillHoles(g, cols, rows) {
    var reach = new Uint8Array(g.length), st = [];
    function push(i) { if (!g[i] && !reach[i]) { reach[i] = 1; st.push(i); } }
    for (var c = 0; c < cols; c++) { push(c); push((rows - 1) * cols + c); }
    for (var r = 0; r < rows; r++) { push(r * cols); push(r * cols + cols - 1); }
    while (st.length) {
      var i = st.pop(), x = i % cols, y = (i - x) / cols;
      if (x > 0) push(i - 1);
      if (x < cols - 1) push(i + 1);
      if (y > 0) push(i - cols);
      if (y < rows - 1) push(i + cols);
    }
    var o = new Uint8Array(g.length);
    for (var k = 0; k < g.length; k++) o[k] = reach[k] ? 0 : 1;
    return o;
  }

  /* 반지름 r칸 원 모양으로 키운다. */
  function dilate(g, cols, rows, r) {
    if (r <= 0) return g;
    var o = new Uint8Array(g);
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        if (!g[y * cols + x]) continue;
        for (var dy = -r; dy <= r; dy++) {
          for (var dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            o[ny * cols + nx] = 1;
          }
        }
      }
    }
    return o;
  }

  fetch("data/yard-deco-touch-fill.json").then(function (r) { return r.json(); }).then(init).catch(function (e) {
    $("tzf-grid").textContent = "데이터를 불러오지 못했습니다: " + e;
  });

  function init(D) {
    var CELL = D.cell, grid = $("tzf-grid");
    var frames = D.frames.map(function (f) {
      var cols = Math.ceil(f.tw / CELL), rows = Math.ceil(f.th / CELL);
      var base = decode(f.bits, cols * rows), filled = fillHoles(base, cols, rows);
      var im = new Image();
      im.src = "img/yard-deco-touch/fill/" + f.id + ".png";
      return { f: f, cols: cols, rows: rows, base: base, filled: filled, im: im };
    });

    function layers(fr, useFill, r) {
      var W = fr.cols + PAD * 2, H = fr.rows + PAD * 2;
      function pad(a) {
        var o = new Uint8Array(W * H);
        for (var y = 0; y < fr.rows; y++) for (var x = 0; x < fr.cols; x++) o[(y + PAD) * W + x + PAD] = a[y * fr.cols + x];
        return o;
      }
      var base = pad(fr.base), mid = useFill ? pad(fr.filled) : base;
      return { W: W, H: H, base: base, mid: mid, fin: dilate(mid, W, H, r) };
    }

    function draw(card) {
      var fr = card.fr, f = fr.f, L = layers(fr, $("tzf-fill").checked, +$("tzf-dil").value);
      card.L = L;
      var cs = CELL * f.s, ox = PAD * cs, oy = PAD * cs, cv = card.cv;
      var iw = fr.im.naturalWidth || Math.round(f.tw * f.s), ih = fr.im.naturalHeight || Math.round(f.th * f.s);
      cv.width = Math.round(iw + ox * 2);
      cv.height = Math.round(ih + oy * 2);
      var x = cv.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, cv.width, cv.height);
      x.fillStyle = "#eef1f5";
      for (var yy = 0; yy < cv.height; yy += 10) for (var xx = (yy / 10 % 2) * 10; xx < cv.width; xx += 20) x.fillRect(xx, yy, 10, 10);
      if ($("tzf-img").checked) x.drawImage(fr.im, ox, oy, iw, ih);
      var nb = 0, nf = 0;
      for (var gy = 0; gy < L.H; gy++) {
        for (var gx = 0; gx < L.W; gx++) {
          var i = gy * L.W + gx, col = null;
          if (L.base[i]) { col = "rgba(46,160,67,.45)"; nb++; }
          else if (L.mid[i]) col = "rgba(30,120,255,.5)";
          else if (L.fin[i]) col = "rgba(255,140,0,.5)";
          if (L.fin[i]) nf++;
          if (col) { x.fillStyle = col; x.fillRect(gx * cs, gy * cs, Math.ceil(cs), Math.ceil(cs)); }
        }
      }
      var A = CELL * CELL;
      card.gain = (nf - nb) * A;
      card.m.textContent = "지금 " + (nb * A).toLocaleString() + " -> " + (nf * A).toLocaleString() + " px2 (+" + Math.round(card.gain / (nb * A) * 100) + "%)";
    }

    var cards = frames.map(function (fr) {
      var el = document.createElement("div");
      el.className = "tzf-card";
      el.innerHTML = "<h4>" + fr.f.name + " <span class=\"tz-dim\">" + fr.f.tw + "x" + fr.f.th + "</span></h4><canvas></canvas><div class=\"tz-dim tzf-m\"></div><div class=\"tzf-r\"></div>";
      var card = { fr: fr, el: el, cv: el.querySelector("canvas"), m: el.querySelector(".tzf-m"), r: el.querySelector(".tzf-r"), gain: 0, L: null };
      card.cv.addEventListener("click", function (e) {
        var rc = card.cv.getBoundingClientRect(), k = card.cv.width / rc.width, cs = CELL * fr.f.s, L = card.L;
        var cx = Math.floor((e.clientX - rc.left) * k / cs), cy = Math.floor((e.clientY - rc.top) * k / cs);
        if (cx < 0 || cy < 0 || cx >= L.W || cy >= L.H) { card.r.textContent = ""; return; }
        var i = cy * L.W + cx, was = !!L.base[i], now = !!L.fin[i];
        card.r.innerHTML = "지금 <b class=\"" + (was ? "tzf-ok" : "tzf-no") + "\">" + (was ? "눌림" : "안 눌림") + "</b> -> 바뀐 뒤 <b class=\"" + (now ? "tzf-ok" : "tzf-no") + "\">" + (now ? "눌림" : "안 눌림") + "</b>";
      });
      grid.appendChild(el);
      return card;
    });

    function drawStats() {
      var rows = D.stats[$("tzf-var").value], useFill = $("tzf-fill").checked, d = +$("tzf-dil").value;
      var key = !useFill && d === 0 ? "now" : (d === 0 ? "fill" : "f" + (d * 4));
      var h = "";
      rows.forEach(function (s) {
        h += "<tr class=\"" + (s.key === key ? "tz-sel" : "") + "\"><td>" + s.label + "</td><td class=\"tz-n\">" + s.le5 + " / " + s.n + "</td><td class=\"tz-n\">" + s.lt50 +
          "</td><td class=\"tz-n\">" + s.lt100 + "</td><td class=\"tz-n\">" + (s.area / 10000).toFixed(1) + "</td><td class=\"tz-n\">" + (s.overlap / 10000).toFixed(1) + "</td></tr>";
      });
      $("tzf-st").querySelector("tbody").innerHTML = h;
    }

    function refresh() {
      var q = $("tzf-q").value.trim().toLowerCase();
      cards.forEach(draw);
      var vis = cards.filter(function (c) { return !q || c.fr.f.name.toLowerCase().indexOf(q) >= 0; });
      vis.sort($("tzf-sort").value === "gain" ? function (a, b) { return b.gain - a.gain; } : function (a, b) { return a.fr.f.name.localeCompare(b.fr.f.name); });
      cards.forEach(function (c) { c.el.style.display = "none"; });
      vis.forEach(function (c) { c.el.style.display = ""; grid.appendChild(c.el); });
      $("tzf-cnt").textContent = vis.length;
    }

    ["tzf-fill", "tzf-dil", "tzf-sort", "tzf-img"].forEach(function (id) {
      $(id).addEventListener("change", function () { refresh(); drawStats(); });
    });
    $("tzf-q").addEventListener("input", refresh);
    $("tzf-var").addEventListener("change", drawStats);
    var pending = frames.length;
    frames.forEach(function (fr) {
      function done() { if (--pending === 0) refresh(); }
      if (fr.im.complete) done(); else { fr.im.onload = done; fr.im.onerror = done; }
    });
    drawStats();
  }
})();
