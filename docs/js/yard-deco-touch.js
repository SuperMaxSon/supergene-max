/* Yard 데코 터치영역 겹침 - yard-deco-style-compare.html 의 #touch-overlap 섹션 전용.
   데이터: data/yard-deco-touch.json (클라이언트 레포 _ignore/deco-touch-overlap 의 추출기가 만든 격자),
   배경: img/yard-deco-touch/area_bg.jpg. 격자 = 칸마다 어느 꾸미기가 덮는지 비트마스크(PNG RGB 3장 x 변형 x 방식).
   위아래 순서는 에리어 프리팹 트리 순서(나중 = 위)로 잡은 추정이다(엔진 동작은 실기 확인 전). */
(function () {
  "use strict";

  var root = document.getElementById("touch-overlap");
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var cv = $("tz-cv"), tip = $("tz-tip");
  if (!cv) return;
  var ctx = cv.getContext("2d");

  var MODES = [
    { id: "bbox", name: "1. 지금 (스프라이트 사각형)",
      what: "켜진 스프라이트마다 그 노드 사각형(앵커, 크기, 회전 반영한 외접 사각형)을 터치영역 노드 하나씩으로 깐다.",
      how: "지금 코드 그대로. <code>DecorateStageUtil.getVisibleSpriteRects</code> 가 사각형을 만들고 <code>DecorateTouchArea.attach</code> 가 노드를 붙인다. 변경 없음.",
      data: "없음.", cost: "터치영역 노드 수 = 보이는 스프라이트 수(87개). 히트 테스트는 사각형 안/밖 비교뿐.",
      limit: "투명 여백과 마스크 밖까지 터치영역이다. 벽, 바닥, cover 같은 큰 스프라이트가 다른 꾸미기를 덮는다." },
    { id: "mask", name: "2. 마스크 자르기",
      what: "1번과 같되, cc.Mask 안에 든 스프라이트는 그 마스크 노드 사각형과 겹치는 부분만 터치영역으로 쓴다.",
      how: "<code>getVisibleSpriteRects</code> 에서 스프라이트의 조상 중 <code>cc.Mask</code> 가 있으면 사각형을 그 마스크 사각형과 교집합으로 줄인다. 런타임 계산만 추가, 한 함수 안에서 끝난다.",
      data: "없음.", cost: "스프라이트마다 조상 탐색 한 번(붙일 때 1회). 이후 비용은 1번과 같다.",
      limit: "영향받는 건 70122 water_tile 하나(마스크 330x290인데 스프라이트 1920x1536). 나머지 큰 스프라이트 문제는 그대로다." },
    { id: "trim", name: "3. trim 박스",
      what: "스프라이트프레임의 trim 정보(투명 여백을 뺀 불투명 영역 박스)만큼 사각형을 줄인다. 마스크 자르기도 같이 적용.",
      how: "<code>spriteFrame.getRect()</code> / <code>getOffset()</code> / <code>getOriginalSize()</code> 로 런타임에 계산한다. 베이크 도구 필요 없음.",
      data: "없음(에셋 메타에 이미 있음).", cost: "붙일 때 프레임 정보 읽기뿐. 이후 비용은 1번과 같다.",
      limit: "여전히 박스라 대각선 물건이나 빈 구석은 그대로다. 효과가 2번과 거의 같다." },
    { id: "alpha", name: "4. 알파 픽셀 (alpha 32 이상)",
      what: "알파가 32 이상인 픽셀만 터치영역이다. 눈에 보이는 윤곽 안만 누를 수 있다.",
      how: "오프라인 베이크 도구가 PNG 알파에서 윤곽(저해상 비트맵)을 JSON 으로 만들어 번들에 동봉한다. 터치영역 노드의 <code>_hitTest</code> 를 덮어 그 윤곽 안에서만 통과시킨다. 엔진은 히트 테스트를 통과한 맨 위 노드 하나만 받으니 '눈에 보이는 맨 위 물건이 받는다'가 된다. 런타임에 텍스처 픽셀을 읽는 방식은 빌드 압축 텍스처 때문에 기기에서 못 쓴다. 엔진이 터치를 뗄 때도 <code>_hitTest</code> 를 다시 돌려 거짓이면 TOUCH_CANCEL 로 바꾸므로, 알파 판정은 터치 시작 때만 쓰고 닿아 있는 동안은 사각형 판정만 쓴다.",
      data: "스프라이트프레임별 윤곽 JSON(베이크 산출물, 4px 격자 기준 gzip 약 35KB).", cost: "탭 한 번에 +0.35us(데스크톱 마이크로 벤치, 모바일 4배 가정 +1.3us), 메모리 약 88KB.",
      limit: "가는 물건(가로등, 꽃)은 손가락으로 누르기 어렵다. 그림이 바뀌면 재베이크가 필요하다(재가공 파이프라인에 붙여야 한다)." }
  ];

  var BG, C, GW, GH, decos, N, DATA;
  var mode = "alpha", variant = "a", subFilter = "", selected = null, clicked = null;
  var planes = {}, cache = {};
  var img = new Image();
  var overlay = document.createElement("canvas");
  var tmp = document.createElement("canvas"), tctx;
  var view = { s: 1, tx: 0, ty: 0 };
  var dpr = window.devicePixelRatio || 1;
  var TIP = "드래그 이동 / Ctrl(Cmd)+휠 확대 / 클릭 = 그 자리를 탭하면 누가 받나";

  function hue(i) { return (i * 47) % 360; }
  function hslToRgb(h, s, l) {
    function f(n) { var k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }
  function hiBit(v) { return 31 - Math.clz32(v); }
  function pop(v) { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  function decode(b64) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () {
        tctx.clearRect(0, 0, GW, GH); tctx.drawImage(im, 0, 0);
        res(new Uint32Array(tctx.getImageData(0, 0, GW, GH).data.buffer.slice(0)));
      };
      im.onerror = rej;
      im.src = "data:image/png;base64," + b64;
    });
  }
  function ensure(v) {
    if (planes[MODES[0].id] && planes[MODES[0].id][v]) return Promise.resolve();
    return Promise.all(MODES.map(function (m) {
      return Promise.all(DATA.grids[m.id][v].map(decode)).then(function (p) {
        planes[m.id] = planes[m.id] || {}; planes[m.id][v] = p;
      });
    }));
  }

  function allowed() {
    var a = [0, 0, 0];
    decos.forEach(function (d, i) { if (!subFilter || d.sub === subFilter) a[Math.floor(i / 24)] |= (1 << (i % 24)); });
    return a;
  }

  function analyze(mid) {
    var p = planes[mid][variant], al = allowed(), n = GW * GH;
    var owner = new Int16Array(n).fill(-1), count = new Uint8Array(n);
    var total = new Int32Array(N), win = new Int32Array(N), blocked = new Int32Array(N * N);
    for (var i = 0; i < n; i++) {
      var v0 = p[0][i] & 0xFFFFFF & al[0], v1 = p[1][i] & 0xFFFFFF & al[1], v2 = p[2][i] & 0xFFFFFF & al[2];
      if ((v0 | v1 | v2) === 0) continue;
      var o = v2 ? 48 + hiBit(v2) : v1 ? 24 + hiBit(v1) : hiBit(v0);
      owner[i] = o; count[i] = pop(v0) + pop(v1) + pop(v2);
      for (var k = 0; k < 3; k++) {
        var v = k === 0 ? v0 : k === 1 ? v1 : v2;
        while (v) {
          var b = hiBit(v); v ^= (1 << b);
          var di = k * 24 + b; total[di]++;
          if (di === o) win[di]++; else blocked[di * N + o]++;
        }
      }
    }
    var stats = [];
    for (var d = 0; d < N; d++) {
      if (!total[d]) continue;
      var tb = -1, tn = 0;
      for (var q = 0; q < N; q++) if (blocked[d * N + q] > tn) { tn = blocked[d * N + q]; tb = q; }
      stats.push({ di: d, key: decos[d].key, sub: decos[d].sub, area: total[d] * C * C, pct: win[d] / total[d] * 100, top: tb });
    }
    stats.sort(function (a, b) { return a.pct - b.pct; });
    return { owner: owner, count: count, stats: stats };
  }

  function analyzeAll() {
    cache = {};
    MODES.forEach(function (m) { cache[m.id] = analyze(m.id); });
    renderCmp(); renderDef(); renderRank(); paint(); draw();
  }

  function paint() {
    var a = cache[mode], octx = overlay.getContext("2d"), od = octx.createImageData(GW, GH);
    var showOwn = $("tz-showown").checked, showRed = $("tz-showred").checked;
    var p = planes[mode][variant];
    var sk = selected === null ? -1 : Math.floor(selected / 24), sb = selected === null ? 0 : (1 << (selected % 24));
    var rgb = []; for (var i = 0; i < N; i++) rgb.push(hslToRgb(hue(i) / 360, 0.75, 0.5));
    for (var c = 0; c < GW * GH; c++) {
      var o = a.owner[c]; if (o < 0) continue;
      var r = 0, g = 0, b = 0, al = 0;
      if (showOwn) { r = rgb[o][0]; g = rgb[o][1]; b = rgb[o][2]; al = 105; }
      if (showRed && a.count[c] >= 2) { r = 211; g = 47; b = 47; al = Math.min(215, 120 + a.count[c] * 25); }
      if (sk >= 0 && (p[sk][c] & 0xFFFFFF & sb)) { r = 40; g = 120; b = 255; al = 190; }
      od.data[c * 4] = r; od.data[c * 4 + 1] = g; od.data[c * 4 + 2] = b; od.data[c * 4 + 3] = al;
    }
    octx.putImageData(od, 0, 0);
  }

  function modeIdx(id) { for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return i; return 0; }

  function renderCmp() {
    var tb = document.querySelector("#tz-cmp tbody"); tb.innerHTML = "";
    MODES.forEach(function (m) {
      var s = cache[m.id].stats;
      var le5 = s.filter(function (x) { return x.pct <= 5; }).length;
      var lt50 = s.filter(function (x) { return x.pct < 50; }).length;
      var lt100 = s.filter(function (x) { return x.pct < 99.5; }).length;
      var area = s.reduce(function (t, x) { return t + x.area; }, 0) / 10000;
      var tr = document.createElement("tr"); tr.className = "tz-hit" + (m.id === mode ? " tz-sel" : "");
      tr.innerHTML = "<td>" + m.name + "</td><td class=\"tz-n\">" + le5 + "/" + s.length + "</td><td class=\"tz-n\">" + lt50 + "</td><td class=\"tz-n\">" + lt100 + "</td><td class=\"tz-n\">" + area.toFixed(0) + "</td>";
      tr.onclick = function () { mode = m.id; refresh(); };
      tb.appendChild(tr);
    });
  }
  function renderDef() {
    var m = MODES[modeIdx(mode)];
    $("tz-def").innerHTML = "<div class=\"note-title\">" + m.name + "</div>" +
      "<p><strong>정의</strong> " + m.what + "</p><p><strong>구현 방식</strong> " + m.how + "</p>" +
      "<p><strong>필요한 데이터</strong> " + m.data + "</p><p><strong>런타임 비용</strong> " + m.cost + "</p><p><strong>한계</strong> " + m.limit + "</p>";
  }
  function renderRank() {
    var tb = document.querySelector("#tz-rank tbody"); tb.innerHTML = "";
    cache[mode].stats.filter(function (s) { return s.pct < 99.5; }).slice(0, 40).forEach(function (s) {
      var tr = document.createElement("tr"); tr.className = "tz-hit" + (selected === s.di ? " tz-sel" : "");
      tr.innerHTML = "<td><i class=\"tz-chip\" style=\"background:hsl(" + hue(s.di) + ",70%,48%)\"></i>" + s.key + " <span class=\"tz-dim\">" + s.sub.replace("area_", "") + "</span></td>" +
        "<td class=\"tz-n\">" + s.pct.toFixed(0) + "%</td><td>" + (s.top < 0 ? "-" : decos[s.top].key) + "</td>";
      tr.onclick = function () { selected = selected === s.di ? null : s.di; if (selected !== null) focusDeco(selected); renderRank(); paint(); draw(); };
      tb.appendChild(tr);
    });
  }
  function refresh() { renderCmp(); renderDef(); renderRank(); paint(); draw(); refreshStack(); }

  function fit() {
    var r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    view.s = Math.min(cv.width / BG.w, cv.height / BG.h);
    view.tx = (cv.width - BG.w * view.s) / 2; view.ty = (cv.height - BG.h * view.s) / 2;
  }
  function focusDeco(di) {
    var p = planes[mode][variant], k = Math.floor(di / 24), b = 1 << (di % 24);
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var i = 0; i < GW * GH; i++) if (p[k][i] & 0xFFFFFF & b) {
      var x = i % GW, y = (i / GW) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return;
    var w = (x1 - x0) * C * 1.6 + 300, h = (y1 - y0) * C * 1.6 + 300;
    view.s = Math.min(cv.width / w, cv.height / h);
    view.tx = cv.width / 2 - ((x0 + x1) / 2 * C) * view.s; view.ty = cv.height / 2 - ((y0 + y1) / 2 * C) * view.s;
  }
  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(view.s, 0, 0, view.s, view.tx, view.ty);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, BG.w, BG.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(overlay, 0, 0, GW * C, GH * C);
    if (clicked) {
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2 / view.s;
      ctx.beginPath(); ctx.arc(clicked[0], clicked[1], 7 / view.s, 0, 7); ctx.fill(); ctx.stroke();
    }
  }
  function toImgPt(e) {
    var b = cv.getBoundingClientRect();
    return [((e.clientX - b.left) * dpr - view.tx) / view.s, ((e.clientY - b.top) * dpr - view.ty) / view.s];
  }
  function zoomAt(px, py, f) {
    var ns = Math.min(10, Math.max(0.1, view.s * f));
    view.tx = px - (px - view.tx) * ns / view.s; view.ty = py - (py - view.ty) * ns / view.s; view.s = ns; draw();
  }

  function refreshStack() {
    var box = $("tz-stack");
    if (!clicked) return;
    var cx = Math.floor(clicked[0] / C), cy = Math.floor(clicked[1] / C);
    if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) { box.textContent = "배경 밖."; return; }
    var i = cy * GW + cx, p = planes[mode][variant], al = allowed(), hit = [];
    for (var k = 0; k < 3; k++) { var v = p[k][i] & 0xFFFFFF & al[k]; while (v) { var b = hiBit(v); v ^= (1 << b); hit.push(k * 24 + b); } }
    hit.sort(function (a, b) { return b - a; });
    box.innerHTML = hit.length === 0 ? "이 방식에선 아무 터치영역도 없다." :
      hit.map(function (di, n) {
        return "<div><i class=\"tz-chip\" style=\"background:hsl(" + hue(di) + ",70%,48%)\"></i>" + (n === 0 ? "<span class=\"tz-recv\">받음</span>" : "가려짐") + " / " + esc(decos[di].key) + " <span class=\"tz-dim\">" + esc(decos[di].sub) + "</span></div>";
      }).join("") + "<div class=\"tz-dim\" style=\"margin-top:4px\">겹친 꾸미기 " + hit.length + "개</div>";
  }

  function bind() {
    var drag = null, moved = false;
    cv.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; moved = false; try { cv.setPointerCapture(e.pointerId); } catch (x) { /* 캡처 실패는 무시 */ } });
    cv.addEventListener("pointermove", function (e) {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) moved = true;
      if (!moved) return;
      view.tx = drag.tx + (e.clientX - drag.x) * dpr; view.ty = drag.ty + (e.clientY - drag.y) * dpr; draw();
    });
    cv.addEventListener("pointerup", function (e) { if (drag && !moved) { clicked = toImgPt(e); refreshStack(); draw(); } drag = null; });
    cv.addEventListener("pointercancel", function () { drag = null; });
    cv.addEventListener("wheel", function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;     // 일반 휠은 페이지 스크롤에 양보
      e.preventDefault();
      var b = cv.getBoundingClientRect();
      zoomAt((e.clientX - b.left) * dpr, (e.clientY - b.top) * dpr, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    $("tz-zin").onclick = function () { zoomAt(cv.width / 2, cv.height / 2, 1.5); };
    $("tz-zout").onclick = function () { zoomAt(cv.width / 2, cv.height / 2, 1 / 1.5); };
    $("tz-zfit").onclick = function () { fit(); draw(); };
    Array.prototype.forEach.call(root.querySelectorAll("input[name=tz-v]"), function (r) {
      r.onchange = function () { variant = r.value; tip.textContent = "불러오는 중..."; ensure(variant).then(function () { tip.textContent = TIP; analyzeAll(); refreshStack(); }); };
    });
    $("tz-sub").onchange = function () { subFilter = this.value; analyzeAll(); refreshStack(); };
    ["tz-showown", "tz-showred"].forEach(function (id) { $(id).onchange = function () { paint(); draw(); }; });
    window.addEventListener("resize", function () { fit(); draw(); });
  }

  fetch("data/yard-deco-touch.json").then(function (r) { return r.json(); }).then(function (d) {
    DATA = d; BG = d.bg; C = d.cell; GW = d.gw; GH = d.gh; decos = d.decos; N = decos.length;
    tmp.width = GW; tmp.height = GH; tctx = tmp.getContext("2d", { willReadFrequently: true });
    overlay.width = GW; overlay.height = GH;
    $("tz-cnt").textContent = N;
    $("tz-ident").textContent = decos.filter(function (x) { return x.identical; }).length;
    var subs = []; decos.forEach(function (x) { if (subs.indexOf(x.sub) < 0) subs.push(x.sub); }); subs.sort();
    subs.forEach(function (s) { var o = document.createElement("option"); o.value = s; o.textContent = s; $("tz-sub").appendChild(o); });
    img.onload = draw; img.src = "img/yard-deco-touch/area_bg.jpg";
    bind(); fit();
    return ensure(variant);
  }).then(function () { tip.textContent = TIP; analyzeAll(); }).catch(function (e) {
    tip.textContent = "불러오기 실패: " + e;
  });
})();
