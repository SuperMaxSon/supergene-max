/* ============================================================================
   rosewood-autoplay-view.js — 순수 렌더 레이어.

   RwView.render(snap) 하나만 내놓는다. 상태를 들고 있지 않고, 판단도 하지 않는다
   (판단은 rosewood-econ.js · rosewood-board.js 쪽 일). snap 모양은 계획서 부록 B3.

   렌더은 배속 8배에서도 매 수 불린다. 그래서 섹션마다 "내용 키"를 만들어 두고,
   지난 렌더와 키가 같으면 innerHTML을 다시 안 쓴다 — DOM 갱신이 비용의 대부분이라
   문자열을 다시 만드는 건 싸도 reflow는 안 싸다.
   ========================================================================== */
(function () {
  "use strict";

  // 섹션별 "지난번에 그린 키" — 같으면 innerHTML을 건드리지 않는다.
  var lastKey = { acc: null, stats: null, chore: null, rewardBox: null, rail: null };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 천 단위 콤마만 — 소수점·통화기호는 이 화면에서 안 쓴다.
  function fmt(n) {
    n = Math.round(Number(n) || 0);
    var neg = n < 0;
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return neg ? "-" + s : s;
  }

  function safeImg(snap, code) {
    if (!code || typeof snap.img !== "function") return "";
    var u = snap.img(code);
    return u ? esc(u) : "";
  }

  function safeName(snap, code) {
    if (!code || typeof snap.name !== "function") return code || "";
    var n = snap.name(code);
    return n || code;
  }

  function iconTag(snap, code, cls) {
    var src = safeImg(snap, code);
    var nm = esc(safeName(snap, code));
    if (!src) return '<span class="' + (cls || "") + '" title="' + nm + '">' + esc(code || "?") + "</span>";
    return '<img class="' + (cls || "") + '" src="' + src + '" alt="' + nm + '" title="' + nm + '">';
  }

  function setIfChanged(el, key, keyName, html) {
    if (!el) return;
    if (lastKey[keyName] === key) return;
    lastKey[keyName] = key;
    el.innerHTML = html;
  }

  // ---- 1) 계정 진행 KPI: 레벨(+exp 바) · 코인 · 젬 · Day(+심부름 진행) · 보상 보관함 수 ----
  function renderAccKpis(snap, el) {
    var level = snap.level || 0;
    var exp = snap.exp || 0;
    var expNeed = snap.expNeed || 0;
    var coin = snap.coin || 0;
    var gem = snap.gem || 0;
    var day = snap.day || 0;
    var lastDay = snap.lastDay || 0;
    var dayDone = snap.dayDone || 0;
    var dayTotal = snap.dayTotal || 0;
    var rewardCount = (snap.rewardBox && snap.rewardBox.length) || 0;

    var key = [level, exp, expNeed, coin, gem, day, lastDay, dayDone, dayTotal, rewardCount].join("|");
    if (lastKey.acc === key) return;
    lastKey.acc = key;

    var pct = expNeed > 0 ? Math.max(0, Math.min(100, (exp / expNeed) * 100)) : 0;

    el.innerHTML =
      '<div class="rwb-akpi lvl">' +
        '<div class="rwb-akpi-n">Lv ' + fmt(level) + "</div>" +
        '<div class="rwb-akpi-l">레벨 <span class="rwb-akpi-s">' + fmt(exp) + "/" + fmt(expNeed) + "</span></div>" +
        '<div class="rwb-expbar"><div class="rwb-expbar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
      "</div>" +
      '<div class="rwb-akpi coin">' +
        '<div class="rwb-akpi-n">' + fmt(coin) + "</div>" +
        '<div class="rwb-akpi-l">코인</div>' +
      "</div>" +
      '<div class="rwb-akpi gem">' +
        '<div class="rwb-akpi-n">' + fmt(gem) + "</div>" +
        '<div class="rwb-akpi-l">젬</div>' +
      "</div>" +
      '<div class="rwb-akpi day">' +
        '<div class="rwb-akpi-n">Day ' + fmt(day) + "<span class=\"rwb-akpi-s\">/" + fmt(lastDay) + "</span></div>" +
        '<div class="rwb-akpi-l">심부름 <span class="rwb-akpi-s">' + fmt(dayDone) + "/" + fmt(dayTotal) + "</span></div>" +
      "</div>" +
      '<div class="rwb-akpi rwd">' +
        '<div class="rwb-akpi-n">' + fmt(rewardCount) + "</div>" +
        '<div class="rwb-akpi-l">보상 보관함</div>' +
      "</div>";
  }

  // ---- 2) 누적 통계: 병합 · 에너지 소모 · 오더 클리어 · 심부름 클리어 · 충전 · 판매 · 수집 ----
  function renderStatsRow(snap, el) {
    var st = snap.stats || {};
    var merges = st.merges || 0;
    var energySpent = st.energySpent || 0;
    var orders = st.orders || 0;
    var chores = st.chores || 0;
    var choreTotal = snap.choreTotal || 0;
    var recharges = st.recharges || 0;
    var sells = st.sells || 0;
    var collects = st.collects || 0;

    var key = [merges, energySpent, orders, chores, choreTotal, recharges, sells, collects].join("|");
    if (lastKey.stats === key) return;
    lastKey.stats = key;

    el.innerHTML =
      "<span>병합 횟수 <b>" + fmt(merges) + "</b></span>" +
      "<span>에너지 소모량 <b>" + fmt(energySpent) + "</b></span>" +
      "<span>오더 클리어 <b>" + fmt(orders) + "</b></span>" +
      "<span>심부름 클리어 <b>" + fmt(chores) + "/" + fmt(choreTotal) + "</b></span>" +
      "<span>에너지 충전 횟수 <b>" + fmt(recharges) + "</b></span>" +
      "<span>판매 <b>" + fmt(sells) + "</b></span>" +
      "<span>수집 <b>" + fmt(collects) + "</b></span>";
  }

  // ---- 3) 심부름 카드 ----
  var REASON_LABEL = { Ok: "진행 가능", CoinShort: "코인 부족", AllCleared: "오늘 완료" };
  var REWARD_LABEL = { exp: "EXP", coin: "코인", gem: "젬", energy: "에너지" };

  function renderChoreCard(snap, el) {
    var chore = snap.chore || null;
    var key = chore
      ? [chore.key, chore.name, chore.cost, chore.canStart, chore.reason,
         (chore.rewards || []).map(function (r) { return r.kind + ":" + (r.code || "") + ":" + r.amount; }).join(",")].join("|")
      : "null";
    if (lastKey.chore === key) return;
    lastKey.chore = key;

    if (!chore) {
      el.innerHTML = '<p class="rwb-empty2">오늘 심부름 없음</p>';
      return;
    }

    var canStart = !!chore.canStart;
    var reasonLabel = REASON_LABEL[chore.reason] || chore.reason || "";
    var rewards = chore.rewards || [];
    var chipsHtml = rewards.map(function (r) {
      if (r.kind === "item") {
        return '<span class="rwb-chip">' + iconTag(snap, r.code) + "×" + fmt(r.amount) + "</span>";
      }
      var label = REWARD_LABEL[r.kind] || r.kind;
      return '<span class="rwb-chip">' + esc(label) + " +" + fmt(r.amount) + "</span>";
    }).join("");

    el.innerHTML =
      '<div class="rwb-chore' + (canStart ? "" : " blocked") + '">' +
        '<span class="rwb-chore-key">' + esc(chore.key || "") + "</span>" +
        '<span class="rwb-chore-name">' + esc(chore.name || "") + "</span>" +
        '<span class="rwb-chore-cost">비용 <b>' + fmt(chore.cost) + "</b></span>" +
        '<span class="rwb-chore-state' + (canStart ? " ok" : " blocked") + '">' + esc(reasonLabel) + "</span>" +
        '<div class="rwb-chore-rewards">' + (chipsHtml || '<span class="rwb-dim">보상 없음</span>') + "</div>" +
      "</div>";
  }

  // ---- 4) 보상 보관함 띠 (FIFO — 맨 앞이 다음에 내려갈 것). 한 줄로 wrap, 24개까지만 아이콘, 나머지는 +N ----
  var REWARDBOX_CAP = 24;

  function renderRewardBox(snap, el) {
    var box = snap.rewardBox || [];
    var key = box.join(",");
    if (lastKey.rewardBox === key) return;
    lastKey.rewardBox = key;

    el.className = "rwb-rewardbox";

    if (!box.length) {
      el.innerHTML = '<span class="rwb-rewardbox-l">보상 보관함 <b>0</b></span><span class="rwb-rewardbox-empty">비어있음</span>';
      return;
    }

    var shown = box.slice(0, REWARDBOX_CAP);
    var extra = box.length - shown.length;

    var items = shown.map(function (code, i) {
      var isNext = i === 0;
      return '<div class="rwb-rewardbox-item' + (isNext ? " next" : "") + '">' +
        '<div class="rwb-rewardbox-icon">' + iconTag(snap, code) + "</div>" +
        (isNext ? '<span class="rwb-rewardbox-tag">다음</span>' : "") +
      "</div>";
    }).join("");

    var moreHtml = extra > 0 ? '<div class="rwb-rewardbox-more">+' + fmt(extra) + "</div>" : "";

    el.innerHTML = '<span class="rwb-rewardbox-l">보상 보관함 <b>' + fmt(box.length) + "</b></span>" + items + moreHtml;
  }

  // ---- 5) 오더 레일 (6칸 — 6번은 special, 이 범위에선 늘 잠김) ----
  function renderRail(snap, el) {
    var rail = snap.rail || [];
    var key = JSON.stringify(rail);
    if (lastKey.rail === key) return;
    lastKey.rail = key;

    if (!rail.length) {
      el.innerHTML = "";
      return;
    }

    el.innerHTML = rail.map(function (slotInfo, idx) {
      var slotNo = (slotInfo && slotInfo.slot != null) ? slotInfo.slot : idx + 1;
      var locked = !!(slotInfo && slotInfo.locked);
      var typeRaw = slotInfo && slotInfo.type;
      var isSpecial = typeRaw === "special" || slotNo === 6;
      var typeTag = typeRaw ? '<span class="rwb-railcard-type">' + esc(typeRaw) + "</span>" : "";

      if (locked) {
        var lockText = isSpecial
          ? "special · 범위 밖"
          : "Lv " + fmt(slotInfo.unlockLevel) + " 해금";
        return '<div class="rwb-railcard locked">' +
          '<span class="rwb-railcard-slot">' + slotNo + "</span>" + typeTag +
          '<span class="rwb-railcard-lock">' + esc(lockText) + "</span>" +
        "</div>";
      }

      var card = slotInfo && slotInfo.card;
      if (!card) {
        return '<div class="rwb-railcard locked">' +
          '<span class="rwb-railcard-slot">' + slotNo + "</span>" + typeTag +
          '<span class="rwb-railcard-lock">-</span>' +
        "</div>";
      }

      var req = card.req || [];
      var have = card.have || [];
      var reqHtml = req.map(function (code, i) {
        var ok = !!have[i];
        return '<div class="rwb-railcard-req">' + iconTag(snap, code) +
          '<span class="rwb-mark ' + (ok ? "ok" : "x") + '">' + (ok ? "✓" : "×") + "</span>" +
        "</div>";
      }).join("");

      return '<div class="rwb-railcard">' +
        '<span class="rwb-railcard-slot">' + slotNo + "</span>" + typeTag +
        (card.fixed ? '<span class="rwb-tag-fixed">고정</span>' : "") +
        '<div class="rwb-railcard-reqs">' + reqHtml + "</div>" +
        '<div class="rwb-railcard-coin">+' + fmt(card.coin) + "</div>" +
      "</div>";
    }).join("");
  }

  function render(snap) {
    snap = snap || {};
    renderAccKpis(snap, document.getElementById("rwbAccKpis"));
    renderStatsRow(snap, document.getElementById("rwbStatsRow"));
    renderChoreCard(snap, document.getElementById("rwbChoreCard"));
    renderRewardBox(snap, document.getElementById("rwbRewardBox"));
    renderRail(snap, document.getElementById("rwbRail"));
  }

  window.RwView = { render: render };
})();
