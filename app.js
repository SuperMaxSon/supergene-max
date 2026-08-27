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

  function buildCard(card, accent) {
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

    a.dataset.search = [
      card.title,
      card.desc,
      proj ? proj.name : "",
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
      list.appendChild(buildCard(c, sec.accent));
    });
    s.appendChild(list);
    main.appendChild(s);
  });

  /* ---------- 검색 ---------- */

  var search = document.getElementById("search");
  var empty = document.getElementById("empty");

  if (search) {
    search.addEventListener("input", function () {
      var q = search.value.trim().toLowerCase();
      var anyVisible = false;

      document.querySelectorAll(".section").forEach(function (sec) {
        var shown = 0;
        sec.querySelectorAll(".card").forEach(function (card) {
          var hit = !q || card.dataset.search.indexOf(q) !== -1;
          card.classList.toggle("is-hidden", !hit);
          if (hit) shown++;
        });
        sec.classList.toggle("is-hidden", shown === 0);
        if (shown) anyVisible = true;
      });

      if (empty) empty.style.display = anyVisible ? "none" : "block";
    });
  }

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
