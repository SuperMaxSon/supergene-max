/* ==========================================================================
   app.js — 렌더링 / 프로젝트 필터 / 검색 / 스크롤스파이
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

  /* 프로젝트를 안 적은 카드도 필터 축에서 갈 곳이 있어야 한다 —
     안 그러면 검색으로만 닿는 문서가 된다. */
  var NOPROJ = "__none__";

  /* ---------- 상태 우선순위 ----------
     섹션 안에서 손이 필요한 문서가 위로 오게 한다: 진행중 > 초안 > 완료.
     Live 는 매주 갱신되는 상시 문서라 그보다 위. 목록에 없는 값은 맨 뒤로 보낸다 —
     새 상태 값이 생겨도 카드가 사라지지 않고 아래에 쌓이기만 한다. */
  var STATUS_ORDER = { Live: 0, "진행중": 1, "초안": 2, "완료": 3 };

  function statusRank(card) {
    var r = STATUS_ORDER[card.status];
    return r == null ? 90 : r;
  }

  /* pinned 는 사람이 직접 올린 것이라 자동 정렬이 끌어내리면 안 된다 — 상태보다 우선.
     sort 는 안정 정렬이라 순위가 같으면 data.js 선언 순서가 그대로 유지된다. */
  function byStatus(cards) {
    return cards.slice().sort(function (a, b) {
      var pa = a.pinned ? 0 : 1;
      var pb = b.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return statusRank(a) - statusRank(b);
    });
  }

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

    /* 필터는 이 값으로, 검색은 dataset.search 로 판정한다 — 두 축을 안 섞는다. */
    a.dataset.project = proj ? card.project : NOPROJ;

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

  /* pill 을 섹션 id 로 찾아 두면 필터로 빈 섹션이 됐을 때 같이 숨길 수 있다. */
  var pillById = {};

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
    pillById[sec.id] = pill;

    var s = el("section", "section");
    s.id = sec.id;
    s.style.setProperty("--acc", "var(--" + sec.accent + ")");

    var head = el("div", "section-head");
    head.appendChild(el("h2", "section-title", sec.label));
    if (sec.desc) head.appendChild(el("p", "section-desc", sec.desc));
    s.appendChild(head);

    /* 정렬은 렌더 직전 한 번뿐이다. 검색·프로젝트 필터는 is-hidden 토글이라
       DOM 순서에 관여하지 않는다 — 필터를 걸어도 이 순서가 유지된다. */
    var list = el("div", "cards");
    byStatus(cards).forEach(function (c) {
      list.appendChild(buildCard(c, sec.accent, sec.label));
    });
    s.appendChild(list);
    main.appendChild(s);
  });

  /* ---------- 프로젝트 필터 ----------
     타이틀 아래 버튼 한 줄. 누르면 그 프로젝트 문서만 남고, 남은 문서는 종전대로
     섹션별로 그려진다. **좁히기만 하고 늘리지 않는다** — 한 카드는 언제나 한 번만 나온다.

     축을 프로젝트 하나로 정한 이유:
       · 섹션은 이미 결과의 뼈대(제목 + nav pill)라 또 고를 필요가 없다.
         프로젝트를 하나 고르면 남는 문서가 1~4장이라 더 좁힐 것도 없다.
       · 태그는 축이 못 된다 — 노출 카드에 붙은 태그 19종 중 13종이 1장짜리라
         버튼 줄이 문서 목록보다 길어진다. 태그는 검색 색인에만 남긴다. */

  var projbar = document.getElementById("projbar");

  /* 버튼 목록은 **데이터에서 만든다.** PROJECTS 를 그대로 다 그리면 눌러도 아무것도
     안 나오는 버튼이 생긴다 — 설정탭(share:false)에 따라 노출 카드가 0인 프로젝트가
     생기기 때문이다. 지금은 bbl(블록블라스트) · tpz(더퍼즐) 이 0이다. */
  var counts = {};
  var total = 0;
  main.querySelectorAll(".card").forEach(function (c) {
    counts[c.dataset.project] = (counts[c.dataset.project] || 0) + 1;
    total++;
  });

  var curProj = "";

  function buildProjbar() {
    if (!projbar) return;

    function addBtn(key, label, count, token) {
      var b = el("button", "projbtn", label);
      b.type = "button";
      b.dataset.proj = key;
      if (token) b.style.setProperty("--acc", "var(" + token + ")");
      b.appendChild(el("span", "projbtn-n", String(count)));
      b.setAttribute("aria-pressed", "false");
      projbar.appendChild(b);
    }

    addBtn("", "전체", total, null);

    /* 순서는 PROJECTS **선언 순서 고정**이다 (개수 순 아님).
       자리가 고정돼야 눈이 위치를 기억한다. multi(다중대조)는 프로젝트가 아니지만
       선언 순서상 이미 끝이라 그대로 두고, project 가 없는 카드는 그 뒤에 붙인다. */
    if (typeof PROJECTS !== "undefined") {
      Object.keys(PROJECTS).forEach(function (k) {
        if (!counts[k]) return;
        addBtn(k, PROJECTS[k].name, counts[k], PROJECTS[k].token);
      });
    }
    if (counts[NOPROJ]) addBtn(NOPROJ, "공통", counts[NOPROJ], "--text-dim");
  }

  function setProj(next, writeHash) {
    // 같은 버튼을 다시 누르면 전체로 돌아온다.
    curProj = next === curProj ? "" : next;
    if (projbar) {
      Array.prototype.slice.call(projbar.children).forEach(function (b) {
        var on = b.dataset.proj === curProj;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    if (writeHash) {
      // replaceState 라 뒤로가기가 필터 이력으로 채워지지 않는다.
      // 링크를 팀에 던지는 것이 목적이지 되돌리는 것이 아니다.
      var h = curProj ? "#p=" + curProj : "";
      history.replaceState(null, "", location.pathname + location.search + h);
    }
    applySearch();
  }

  if (projbar) {
    buildProjbar();
    projbar.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-proj]");
      if (b) setProj(b.dataset.proj, true);
    });
  }

  /* ---------- 검색 ----------
     필터와 검색을 여기 한 곳에서 AND 로 겹친다. 경로가 둘이면 반드시 어긋난다. */

  var search = document.getElementById("search");
  var empty = document.getElementById("empty");

  function applySearch() {
    var q = search ? search.value.trim().toLowerCase() : "";
    var anyVisible = false;

    main.querySelectorAll(".section").forEach(function (sec) {
      var shown = 0;
      sec.querySelectorAll(".card").forEach(function (c) {
        var hit =
          (!q || c.dataset.search.indexOf(q) !== -1) &&
          (!curProj || c.dataset.project === curProj);
        c.classList.toggle("is-hidden", !hit);
        if (hit) shown++;
      });
      sec.classList.toggle("is-hidden", shown === 0);
      /* 빈 섹션은 제목뿐 아니라 nav pill 도 같이 숨긴다. 남겨 두면 눌러도 아무 데도
         안 가는 pill 이 되어 "안 먹는 필터"로 읽힌다 — 이게 원래 문제였다. */
      var pill = pillById[sec.id];
      if (pill) pill.classList.toggle("is-hidden", shown === 0);
      if (shown) anyVisible = true;
    });

    if (empty) empty.style.display = anyVisible ? "none" : "block";
  }

  if (search) search.addEventListener("input", applySearch);

  /* 해시로 들어온 상태를 복원한다 — "#p=sol" 링크를 팀에 그대로 던질 수 있다.
     setProj 가 토글이라 현재값과 같으면 꺼진다. 초기화는 curProj 를 비우고 부른다. */
  function readHash() {
    var m = /[#&]p=([^&]+)/.exec(location.hash);
    var key = m ? decodeURIComponent(m[1]) : "";
    if (key && !counts[key]) key = ""; // 없는 프로젝트를 가리키는 낡은 링크
    curProj = "";
    setProj(key, false);
  }
  readHash();
  window.addEventListener("hashchange", readHash);

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
