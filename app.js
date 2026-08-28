/* ==========================================================================
   app.js — 렌더링 / 검색 / 스크롤스파이
   허브(index.html)와 문서 페이지에서 공용으로 로드됩니다.
   문서 페이지에는 없는 DOM 은 모두 null 가드 처리.
   테마 전환은 라이트 단일 테마로 정리하면서 제거됨.
   ========================================================================== */

(function () {
  "use strict";

  /* ---------- 허브 렌더 ---------- */

  var nav = document.getElementById("nav");
  var main = document.getElementById("main");
  if (!nav || !main || typeof SECTIONS === "undefined") return;

  var titleEl = document.getElementById("site-title");
  var subEl = document.getElementById("site-sub");
  var updEl = document.getElementById("site-updated");
  if (titleEl) titleEl.textContent = SITE.title;
  if (subEl) subEl.textContent = SITE.subtitle;
  if (updEl) updEl.textContent = "최종 업데이트 " + SITE.updated;
  document.title = SITE.title;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function isExternal(url) {
    return /^https?:\/\//.test(url);
  }

  function buildCard(card, accent, secLabel) {
    var url = card.url || "#";
    var a = el("a", "card" + (card.pinned ? " is-pinned" : ""));
    a.href = url;

    // 프로젝트가 지정된 카드는 --acc 를 프로젝트 식별색으로 덮는다.
    // 섹션은 제목과 nav pill 로 이미 구분되므로 카드 테두리는 프로젝트에 양보한다.
    // PROJECTS 가 없거나 card.project 가 없으면 종전대로 섹션 accent (기존 카드 무손상).
    var proj =
      typeof PROJECTS !== "undefined" && card.project
        ? PROJECTS[card.project]
        : null;
    a.style.setProperty(
      "--acc",
      "var(" + (proj ? proj.token : "--" + accent) + ")"
    );

    if (isExternal(url)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }

    var top = el("div", "card-top");
    // 색만으로는 어느 프로젝트인지 알 수 없으니 이름 칩을 제목 앞에 세운다.
    if (proj) top.appendChild(el("span", "card-proj", proj.name));
    top.appendChild(el("span", "card-title", card.title));
    if (isExternal(url)) top.appendChild(el("span", "card-ext", "↗"));
    if (card.status) {
      var st = el("span", "status", card.status);
      st.setAttribute("data-status", card.status);
      top.appendChild(st);
    }
    a.appendChild(top);

    if (card.desc) a.appendChild(el("p", "card-desc", card.desc));

    var foot = el("div", "card-foot");
    if (card.version) foot.appendChild(el("span", null, card.version));
    if (card.updated) foot.appendChild(el("span", null, card.updated));
    (card.tags || []).forEach(function (t) {
      foot.appendChild(el("span", "tag", t));
    });
    if (foot.childNodes.length) a.appendChild(foot);

    /* 섹션 라벨을 색인에 넣는다. "QA" · "전후비교" 처럼 섹션이 이미 말하는 태그를
       카드에서 뺐기 때문에, 이게 없으면 그 단어로 검색했을 때 카드가 사라진다. */
    a.dataset.search = [
      card.title,
      card.desc,
      proj ? proj.name : "",
      secLabel || "",
      (card.tags || []).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return a;
  }

  SECTIONS.forEach(function (sec) {
    // share:false 는 설정탭에서 숨긴 카드다. 플래그가 없으면 노출(기존 카드 무손상).
    var cards = (sec.cards || []).filter(function (c) {
      return c.share !== false;
    });

    // 보일 카드가 없는 섹션은 제목 · nav pill 둘 다 그리지 않는다.
    if (!cards.length) return;

    var pill = el("button", "nav-pill", sec.label);
    pill.style.setProperty("--acc", "var(--" + sec.accent + ")");
    pill.dataset.target = sec.id;
    pill.addEventListener("click", function () {
      var t = document.getElementById(sec.id);
      if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.appendChild(pill);

    var s = el("section", "section");
    s.id = sec.id;
    s.style.setProperty("--acc", "var(--" + sec.accent + ")");

    var head = el("div", "section-head");
    head.appendChild(el("h2", "section-title", sec.label));
    if (sec.desc) head.appendChild(el("p", "section-desc", sec.desc));
    s.appendChild(head);

    var list = el("div", "cards");
    cards.forEach(function (c) {
      list.appendChild(buildCard(c, sec.accent, sec.label));
    });
    s.appendChild(list);
    main.appendChild(s);
  });


  /* ---------- 태그 · 프로젝트 그룹 보기 ----------
     섹션 보기와 같은 카드를 다른 축으로 묶어 리스트로 편다.
     한 카드가 태그 3개면 세 그룹에 나온다 — 필터가 아니라 라벨 브라우징이라 정상이다.
     카드 그리드 대신 한 줄짜리 행을 쓰는 이유: 축을 바꿔 보는 목적이 "재고 확인"이라
     설명문보다 개수와 목록이 먼저 읽혀야 한다. */

  var grouped = document.getElementById("grouped");
  var viewtabs = document.getElementById("viewtabs");

  /* 카드 → 속한 섹션 정보. 그룹 보기에서도 섹션 accent 를 쓰기 위해 같이 들고 다닌다. */
  var ENTRIES = [];
  SECTIONS.forEach(function (sec) {
    (sec.cards || []).forEach(function (c) {
      if (c.share === false) return;
      ENTRIES.push({ card: c, sec: sec });
    });
  });

  function buildRow(e) {
    var url = e.card.url || "#";
    var a = el("a", "row");
    a.href = url;
    var proj =
      typeof PROJECTS !== "undefined" && e.card.project
        ? PROJECTS[e.card.project]
        : null;
    a.style.setProperty(
      "--acc",
      "var(" + (proj ? proj.token : "--" + e.sec.accent) + ")"
    );
    if (isExternal(url)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    if (proj) a.appendChild(el("span", "row-proj", proj.name));
    a.appendChild(el("span", "row-title", e.card.title));
    /* 섹션은 그룹 보기에서 축이 아니므로 행마다 작게 남겨 어디 문서인지 잃지 않게 한다. */
    a.appendChild(el("span", "row-sec", e.sec.label));
    if (e.card.status) {
      var st = el("span", "status", e.card.status);
      st.setAttribute("data-status", e.card.status);
      a.appendChild(st);
    }
    if (e.card.updated) a.appendChild(el("span", "row-date", e.card.updated.slice(0, 10)));
    a.dataset.search = [
      e.card.title,
      e.card.desc,
      proj ? proj.name : "",
      e.sec.label,
      (e.card.tags || []).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return a;
  }

  /* keyOf 가 카드 하나에서 그룹 키 배열을 뽑는다 (태그는 여러 개, 프로젝트는 하나). */
  function buildGroups(mode) {
    var map = {};
    var order = [];
    ENTRIES.forEach(function (e) {
      var keys =
        mode === "tag"
          ? e.card.tags || []
          : [
              typeof PROJECTS !== "undefined" && e.card.project && PROJECTS[e.card.project]
                ? PROJECTS[e.card.project].name
                : "프로젝트 없음",
            ];
      if (!keys.length) keys = ["태그 없음"];
      keys.forEach(function (k) {
        if (!map[k]) {
          map[k] = [];
          order.push(k);
        }
        map[k].push(e);
      });
    });
    /* 큰 묶음부터 — 재고 확인이 목적이라 개수가 스캔 순서가 된다. 같으면 가나다순. */
    order.sort(function (a, b) {
      return map[b].length - map[a].length || a.localeCompare(b, "ko");
    });
    return { map: map, order: order };
  }

  function renderGroups(mode) {
    grouped.innerHTML = "";
    var g = buildGroups(mode);
    g.order.forEach(function (key) {
      var sec = el("section", "group");
      var head = el("div", "group-head");
      head.appendChild(el("h2", "group-title", key));
      head.appendChild(el("span", "group-count", String(g.map[key].length)));
      sec.appendChild(head);
      var rows = el("div", "rows");
      g.map[key].forEach(function (e) {
        rows.appendChild(buildRow(e));
      });
      sec.appendChild(rows);
      grouped.appendChild(sec);
    });
  }

  var view = "section";

  function setView(next) {
    view = next;
    var isSection = next === "section";
    main.hidden = !isSection;
    grouped.hidden = isSection;
    if (nav.parentNode) nav.parentNode.hidden = !isSection; /* nav.nav — 섹션 보기 전용 */
    if (!isSection) renderGroups(next);
    if (viewtabs) {
      Array.prototype.slice.call(viewtabs.children).forEach(function (b) {
        b.classList.toggle("is-active", b.dataset.view === next);
        b.setAttribute("aria-selected", b.dataset.view === next ? "true" : "false");
      });
    }
    applySearch();
  }

  if (viewtabs) {
    viewtabs.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-view]");
      if (b) setView(b.dataset.view);
    });
  }

  /* ---------- 검색 ----------
     섹션 · 그룹 두 보기가 같은 질의를 쓴다. 보이는 쪽만 훑고, 비는 묶음은 통째로 접는다. */

  var search = document.getElementById("search");
  var empty = document.getElementById("empty");

  function applySearch() {
    var q = search ? search.value.trim().toLowerCase() : "";
    var anyVisible = false;
    var boxSel = view === "section" ? ".section" : ".group";
    var itemSel = view === "section" ? ".card" : ".row";
    var root = view === "section" ? main : grouped;

    root.querySelectorAll(boxSel).forEach(function (box) {
      var shown = 0;
      box.querySelectorAll(itemSel).forEach(function (it) {
        var hit = !q || it.dataset.search.indexOf(q) !== -1;
        it.classList.toggle("is-hidden", !hit);
        if (hit) shown++;
      });
      box.classList.toggle("is-hidden", shown === 0);
      if (shown) anyVisible = true;
    });

    if (empty) empty.style.display = anyVisible ? "none" : "block";
  }

  if (search) search.addEventListener("input", applySearch);

  /* ---------- 스크롤스파이 ---------- */

  var pills = Array.prototype.slice.call(nav.querySelectorAll(".nav-pill"));

  if ("IntersectionObserver" in window && pills.length) {
    var obs = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          pills.forEach(function (p) {
            p.classList.toggle("is-active", p.dataset.target === e.target.id);
          });
        });
      },
      { rootMargin: "-56px 0px -70% 0px", threshold: 0 }
    );
    document.querySelectorAll(".section").forEach(function (s) {
      obs.observe(s);
    });
  }
})();
