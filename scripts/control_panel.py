#!/usr/bin/env python3
"""자동화 제어판 — http://127.0.0.1:8787

automation.json 을 켜고/끄고, 공용 실행 시각을 바꾼다. 실제 실행은 run_due.py 가 한다.
127.0.0.1 에만 바인딩한다 — 인증이 없으므로 외부에 열면 안 된다.
"""
import datetime
import html
import json
import os
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import refresh_common as rc      # git()/dirty() 재사용. 규칙이 갈리지 않게 한 벌만 둔다.

HERE     = os.path.dirname(os.path.abspath(__file__))
REPO     = os.path.dirname(HERE)
DATA_JS  = os.path.join(REPO, "data.js")
INDEX    = os.path.join(REPO, "index.html")
REGISTRY = os.path.join(HERE, "automation.json")
STATE    = os.path.join(HERE, "run_state.json")
LOG      = os.path.join(HERE, "refresh.log")
PORT     = 8787


USD_PER_TIB = 6.25          # BigQuery 온디맨드 분석 단가(US)
KRW_PER_USD = 1400          # 환산 표시용 어림값


def cost_note(job):
    """'1회 2.48 GiB' 만 적으면 그 숫자가 돈으로 읽힌다. 스캔량과 환산액을 같이 보인다.
    슬롯 예약 프로젝트면 추가 청구액은 0이므로 '온디맨드 기준'임을 명시한다."""
    gib = job.get("scan_gib")
    if not gib:
        return "1회 " + str(job.get("scan_per_run", "?"))
    usd = gib / 1024.0 * USD_PER_TIB
    txt = "1회 %.2f GiB · 온디맨드 기준 약 %d원" % (gib, round(usd * KRW_PER_USD))
    if job.get("scan_note"):
        txt += " · <b style='color:#b45309'>⚠ " + html.escape(job["scan_note"]) + "</b>"
    return txt


# ---------------------------------------------------------------------------
# 허브 반영 — 끄기/켜기를 data.js·문서 html 까지 밀어 넣는다
#
# ON/OFF 는 automation.json 에 살고, 팀이 보는 허브는 data.js 만 읽는다(브라우저는
# scripts/ 를 못 읽는다). 예전에는 이 두 곳을 잇는 코드가 **켤 때만** 있었다 —
# refresh_common.stamp() 가 실행할 때마다 status 를 "Live" 로 되박는다. 끌 때는
# 아무도 내리지 않는 데다 꺼진 작업은 실행 자체가 없어서, 카드가 빨간 Live 인 채로
# 영원히 굳었다. 그 자리를 여기서 메운다.
#
# status 는 건드리지 않는다. status 를 내리면 카드가 「라이브」 섹션에서 빠져 원래
# 섹션으로 이동해 버린다 — 멈춘 문서가 조용히 사라지는 게 더 나쁘다. 대신 paused
# 플래그만 박고, app.js 가 그 카드를 회색 배지 + 섹션 맨 아래로 그린다.
# ---------------------------------------------------------------------------

def _card_re(url, tail):
    """그 카드 블록 **안에서만** 매치한다.

    url 뒤를 .*? 로 열어 두면 그 카드에 찾는 줄이 없을 때 다음 카드까지 넘어가
    엉뚱한 카드를 고친다. 다음 `url: "` 을 만나기 전까지로 못박는다."""
    return re.compile(r'(url: "%s"(?:(?!url: ")[\s\S])*?%s)' % (re.escape(url), tail))


def set_paused(text, url, paused):
    """data.js 텍스트에서 그 카드의 paused 플래그를 넣거나 뺀다. (새 텍스트, 바뀜?)"""
    before = text
    # 먼저 기존 플래그를 걷어낸다 — 켜기/끄기 어느 쪽이든 중복이 쌓이지 않는다.
    text = _card_re(url, r'\n[ \t]*paused: (?:true|false),').sub(
        lambda m: re.sub(r'\n[ \t]*paused: (?:true|false),$', "", m.group(1)), text, count=1)
    if paused:
        # status 줄 바로 아래. 들여쓰기는 그 줄에서 그대로 가져온다.
        text = _card_re(url, r'\n([ \t]*)status: "[^"]*",\n').sub(
            lambda m: m.group(1) + m.group(2) + "paused: true,\n", text, count=1)
    return text, text != before


def set_doc_enabled(path, on):
    """문서 html 의 window.AUTORUN.enabled 만 바꾼다. (바뀜?)

    hours·pulled 는 건드리지 않는다 — pulled 는 '데이터를 조회한 시각'이라
    지금 시각으로 덮으면 거짓말이 된다. 스케줄 변경은 다음 실행이 반영한다."""
    try:
        s = open(path, encoding="utf-8").read()
    except Exception:
        return False
    new = re.sub(r'(window\.AUTORUN = \{[^}]*\benabled: )(?:true|false)',
                 lambda m: m.group(1) + ("true" if on else "false"), s, count=1)
    if new == s:
        return False
    open(path, "w", encoding="utf-8").write(new)
    return True


def write_hub(jid, job, on):
    """토글 한 건을 허브 파일에 반영한다. 커밋은 하지 않는다 — (쓴 파일, 경고들).

    커밋을 여기서 하지 않는 이유: '적용하기'로 여러 작업을 한꺼번에 바꿀 수 있고,
    그때 커밋이 작업 수만큼 쪼개지면 히스토리에서 한 번의 결정이 여러 줄로 흩어진다.

    사람이 편집 중인 공유 파일은 쓰지 않는다(refresh_common.stamp() 와 같은 규칙).
    한 번 반영이 밀려도 다음 토글이나 다음 자동 실행이 따라잡는다 — 남의 미완성
    작업을 자동 커밋에 실어 보내는 쪽이 훨씬 비싸다."""
    doc = job.get("doc") or ""
    url = doc                       # data.js 카드의 url 은 doc 경로와 같은 값이다
    touched, warn = [], []
    now = datetime.datetime.now()   # SITE.updated 와 캐시 버스터가 같은 시각을 쓰게 한 벌만 찍는다

    if rc.dirty(DATA_JS):
        warn.append("data.js 에 미커밋 변경이 있어 허브 카드 반영을 보류했습니다"
                    " — 정리한 뒤 다시 적용하세요.")
    elif url:
        d = open(DATA_JS, encoding="utf-8").read()
        d, hit = set_paused(d, url, not on)
        if hit:
            # 사이트 전체 갱신 시각(SITE.updated). data.js 를 고치면서 이걸 빼면
            # index.html 의 캐시 버스터와 시각이 어긋난다 — 두 값은 늘 같이 움직인다
            # (admin.js writeCard() · refresh_common.stamp() 도 같은 규칙).
            # 들여쓰기 2칸짜리 updated 는 파일에서 이 한 곳뿐이라 그걸로 찍는다.
            d = re.sub(r'(\n  updated: ")[^"]*(")',
                       lambda m: m.group(1) + now.strftime("%Y-%m-%d %H:%M") + m.group(2),
                       d, count=1)
            open(DATA_JS, "w", encoding="utf-8").write(d)
            touched.append(DATA_JS)
        elif not on:
            warn.append("data.js 에서 %s 카드를 찾지 못했습니다." % url)

    # 캐시 버스터. data.js 를 실제로 바꿨을 때만 올린다 — 안 바뀐 파일 캐시를 깨봐야 소용없다.
    # 시각은 SITE.updated 와 **같은 now** 에서 뽑는다. 따로 찍으면 1분 경계에서 갈린다.
    if touched and not rc.dirty(INDEX):
        i = open(INDEX, encoding="utf-8").read()
        i2 = re.sub(r"data\.js\?v=\d{12}", "data.js?v=" + now.strftime("%Y%m%d%H%M"), i)
        if i2 != i:
            open(INDEX, "w", encoding="utf-8").write(i2)
            touched.append(INDEX)
    elif touched:
        warn.append("index.html 에 미커밋 변경이 있어 캐시 버스터를 올리지 못했습니다"
                    " — 팀에는 최대 10분 늦게 보입니다.")

    docpath = os.path.join(REPO, doc)
    if doc and os.path.exists(docpath):
        if rc.dirty(docpath):
            warn.append("%s 에 미커밋 변경이 있어 타이머 표시를 보류했습니다." % doc)
        elif set_doc_enabled(docpath, on):
            touched.append(docpath)

    return touched, warn


def commit_hub(touched, msg):
    """허브 파일 변경을 한 커밋으로 묶어 올린다. 경고 목록을 돌려준다."""
    warn = []
    # automation.json 은 이 상태의 원본이다. 같이 담지 않으면 저장소에서 두 파일이 어긋난다.
    if os.path.exists(REGISTRY):
        touched = touched + [REGISTRY]
    # 여러 작업을 한 번에 적용하면 data.js 가 여러 번 담긴다. 순서를 지키며 한 벌로 줄인다.
    touched = list(dict.fromkeys(touched))
    if len(touched) <= 1:           # 레지스트리만 남았으면 커밋할 내용이 없다
        return warn

    rc.git("add", "--", *touched)
    r = rc.git("commit", "-q", "-m", msg)
    if r.returncode != 0:
        warn.append("커밋 실패: " + (r.stderr or r.stdout).strip()[:200])
        return warn
    r = rc.git("push", "-q", "origin", "HEAD")
    if r.returncode != 0:
        warn.append("커밋은 됐지만 푸시에 실패했습니다(인증 만료?). 다음 자동 실행이 밀어 올립니다.")
    return warn


def apply_toggles(reg, wanted):
    """'적용하기'로 들어온 ON/OFF 묶음을 레지스트리에 저장하고 허브까지 반영한다.

    wanted = {job_id: True/False}. 지금 값과 같은 것은 건너뛴다 — 누르지 않은 작업까지
    커밋 메시지에 실리면 무엇을 바꿨는지 읽을 수 없다."""
    changed, touched, warn = [], [], []
    for jid, on in wanted.items():
        job = reg.get("jobs", {}).get(jid)
        if job is None or bool(job.get("enabled")) == on:
            continue
        job["enabled"] = on
        changed.append((jid, job, on))
    if not changed:
        return ""
    save_registry(reg)              # 레지스트리부터 확정한다 — 허브 반영이 실패해도 ON/OFF 는 남는다

    for jid, job, on in changed:
        t, w = write_hub(jid, job, on)
        touched += t
        warn += w

    parts = ["%s %s" % (job.get("label", jid), "ON" if on else "OFF")
             for jid, job, on in changed]
    msg = ("hub: 자동 갱신 " + " · ".join(parts) if len(parts) == 1
           else "hub: 자동 갱신 %d건 변경 (%s)" % (len(parts), " · ".join(parts)))
    warn += commit_hub(touched, msg)
    return " ".join(warn)


def load(p, d):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return d


def save_registry(reg):
    with open(REGISTRY, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=1, sort_keys=False)
        f.write("\n")      # 끝 개행이 없으면 커밋할 때마다 "\ No newline" 노이즈가 낀다


def hour_grid(hours):
    """0~23 을 전부 깔아 놓고 토글한다.

    클릭 즉시 저장하지 않는다 — 여러 칸을 고칠 때 매번 저장·재렌더가 돌고,
    실수로 누른 것을 되돌릴 방법이 없다. 공유 설정 페이지와 같이
    '고른 뒤 적용하기' 로 맞춘다(되돌리기도 같이 둔다).
    """
    on = set(hours)
    cells = []
    for h in range(24):
        cells.append(
            '<button type="button" class="hbtn%s" data-h="%d">%02d</button>'
            % (" is-on" if h in on else "", h, h))
    return "".join(cells)


def next_run(hours, any_on=True):
    """다음 예정 시각. 켜진 작업이 하나도 없으면 시각을 말하지 않는다 —
    아무도 돌지 않는데 '내일 09:00' 이라고 적으면 오지 않을 갱신을 예고하는 것이다."""
    if not any_on:
        return "없음 (모든 작업이 꺼져 있습니다 — 수동 실행)"
    if not hours:
        return "없음 (선택된 시각이 없습니다)"
    now = datetime.datetime.now()
    later = [h for h in sorted(hours) if h > now.hour]
    if later:
        return "오늘 %02d:00" % later[0]
    return "내일 %02d:00" % sorted(hours)[0]


def page(warn=""):
    reg   = load(REGISTRY, {"defaults": {}, "jobs": {}})
    state = load(STATE, {})
    hours = reg.get("defaults", {}).get("hours") or []
    tail  = ""
    try:
        with open(LOG, encoding="utf-8") as f:
            tail = "".join(f.readlines()[-14:])
    except Exception:
        tail = "(로그 없음)"

    rows = []
    for jid, j in sorted(reg.get("jobs", {}).items()):
        st  = state.get(jid, {})
        on  = bool(j.get("enabled"))
        own = j.get("hours")
        last = st.get("at", "—")
        ok   = st.get("ok")
        pill  = "<span class='pill on'>ON</span>" if on else "<span class='pill off'>OFF</span>"
        mark  = (" <span class='ok'>✓</span>" if ok else
                 " <span class='bad'>✕ 실패</span>" if ok is False else "")
        rows.append("""
        <tr>
          <td>
            <div class="lbl">%s</div>
            <div class="sub"><a href="%s" target="_blank">문서 열기</a> · %s · 1회 %s</div>
          </td>
          <td class="c" data-pill="%s">%s</td>
          <td class="c">%s</td>
          <td class="c mono">%s%s</td>
          <td class="c">
            <button type="button" class="tgl %s" data-id="%s" data-on="%d">%s</button>
            <button type="button" class="ghost run" data-id="%s">지금 실행</button>
          </td>
        </tr>""" % (
            html.escape(j.get("label", jid)),
            html.escape(j.get("url", "#")),
            html.escape(j.get("script", "")),
            cost_note(j),          # 내부 생성 문자열이다. 사용자 입력은 안에서 escape 한다
            html.escape(jid), pill,
            "공용" if not own else "개별 " + html.escape(",".join(map(str, own))),
            html.escape(last), mark,
            # 버튼이 보여 주는 것은 '누르면 될 상태'다 — 켜져 있으면 「끄기」.
            "off" if on else "on", html.escape(jid), 1 if on else 0,
            "끄기" if on else "켜기",
            html.escape(jid)))

    tpl = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>자동화 제어판</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#f6f7f9;--card:#fff;--tx:#16181d;--mut:#6b7280;--bd:#e5e7eb;
        --ok:#15803d;--bad:#b91c1c;--ac:#1d4ed8}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 20px;background:var(--bg);color:var(--tx);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}
  .wrap{max-width:940px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  .lede{color:var(--mut);margin:0 0 22px;font-size:13px}
  .nav{display:flex;gap:14px;margin:0 0 14px;font-size:13px}
  .nav a{color:var(--ac);text-decoration:none;font-weight:600}
  .nav a:hover{text-decoration:underline}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:18px;margin-bottom:16px}
  .warn{background:#fef3c7;border:1px solid #fcd34d;color:#92400e;border-radius:10px;
        padding:10px 14px;margin:0 0 16px;font-size:13px;font-weight:600}
  h2{font-size:14px;margin:0 0 12px;color:var(--mut);letter-spacing:.02em}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px 8px;border-bottom:1px solid var(--bd);vertical-align:middle;text-align:left}
  th{font-size:12px;color:var(--mut);font-weight:600}
  td.c{text-align:center;white-space:nowrap}
  .lbl{font-weight:700}
  .sub{font-size:12px;color:var(--mut)}
  .sub a{color:var(--ac)}
  .mono{font-variant-numeric:tabular-nums;font-size:12px}
  button{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--bd);
         background:#fff;cursor:pointer}
  button.on{background:var(--ok);border-color:var(--ok);color:#fff;font-weight:700}
  button.off{background:#fff;color:var(--mut)}
  button.ghost{color:var(--ac)}
  .ok{color:var(--ok);font-weight:700}.bad{color:var(--bad);font-weight:700}.mut{color:var(--mut)}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;
        letter-spacing:.04em}
  .pill.on{background:#dcfce7;color:var(--ok)}
  .pill.off{background:#f1f2f4;color:var(--mut)}
  .hgrid{display:grid;grid-template-columns:repeat(12,1fr);gap:5px;margin:2px 0 4px}
  @media(max-width:640px){.hgrid{grid-template-columns:repeat(6,1fr)}}
  .hcell{margin:0}
  .hbtn{width:100%;padding:9px 0;border:1px solid var(--bd);border-radius:8px;background:#fff;
        color:var(--mut);font-variant-numeric:tabular-nums;font-size:13px;font-weight:600}
  .hbtn:hover{border-color:var(--ac);color:var(--ac)}
  .hbtn.is-on{background:var(--ac);border-color:var(--ac);color:#fff;font-weight:800}
  .hbtn{cursor:pointer}
  .hbar{display:flex;align-items:center;gap:8px;margin-top:10px}
  .hstate{font-size:12.5px;color:var(--mut)}
  .hstate.is-dirty{color:#b45309;font-weight:700}
  .grow{flex:1}
  button:disabled{opacity:.4;cursor:default}
  pre{background:#0f1115;color:#d6dae1;padding:14px;border-radius:10px;overflow:auto;
      font-size:12px;line-height:1.55;margin:0}
  .note{font-size:12px;color:var(--mut);margin-top:10px}
</style></head><body><div class="wrap">
  <div class="nav"><a href="http://localhost:4173/">← 공유 설정</a>
    <a href="http://localhost:4173/index.html" target="_blank">허브 미리보기 ↗</a></div>
  <h1>자동화 제어판</h1>
  <p class="lede">실행 판정은 <code>run_due.py</code>가 15분마다 확인합니다 —
     지난 슬롯을 놓쳤으면 켜는 즉시 따라잡습니다(catch-up). 지금 {{NOW}}</p>
  {{WARN}}

  <div class="card">
    <h2>공용 실행 시각 — 모든 자동화가 이 값을 봅니다</h2>
    <form method="post" action="/hours" id="hform">
      <div class="hgrid">{{HOURGRID}}</div>
      <input type="hidden" name="hours" id="hval" value="{{HOURS}}">
      <div class="hbar">
        <span class="hstate" id="hstate">선택 <b>{{HOURCOUNT}}개</b> · 다음 실행 <b>{{NEXTRUN}}</b></span>
        <span class="grow"></span>
        <button type="button" class="ghost" id="hundo" disabled>되돌리기</button>
        <button type="submit" class="on" id="happly" disabled>적용하기</button>
      </div>
    </form>
    <div class="note">시각을 고른 뒤 <b>적용하기</b>를 누르세요(KST) ·
      개별 시각이 지정된 작업은 그 값이 우선합니다.</div>
  </div>

  <div class="card">
    <h2>작업</h2>
    <table>
      <thead><tr><th>문서</th><th class="c">상태</th><th class="c">시각</th>
        <th class="c">마지막 실행</th><th class="c">제어</th></tr></thead>
      <tbody>{{ROWS}}</tbody>
    </table>
    <form method="post" action="/toggle" id="tform">
      <input type="hidden" name="on"  id="ton">
      <input type="hidden" name="off" id="toff">
      <div class="hbar">
        <span class="hstate" id="tstate">바뀐 작업 없음</span>
        <span class="grow"></span>
        <button type="button" class="ghost" id="tundo" disabled>되돌리기</button>
        <button type="submit" class="on" id="tapply" disabled>적용하기</button>
      </div>
    </form>
    <div class="note">켜고 끈 뒤 <b>적용하기</b>를 누르세요 — 그때 한 번에 저장되고
      허브 카드(data.js)까지 한 커밋으로 반영됩니다.</div>
  </div>

  <!-- '지금 실행'은 되돌릴 것이 없어 즉시 보낸다. 표 안에 form 을 중첩할 수 없어 밖에 둔다. -->
  <form method="post" action="/run" id="rform" style="display:none">
    <input type="hidden" name="id" id="rid">
  </form>

  <div class="card"><h2>최근 로그</h2><pre>{{LOG}}</pre></div>
</div>
<script>
(function () {
  var form  = document.getElementById("hform");
  if (!form) return;
  var val   = document.getElementById("hval");
  var apply = document.getElementById("happly");
  var undo  = document.getElementById("hundo");
  var state = document.getElementById("hstate");
  var cells = [].slice.call(form.querySelectorAll(".hbtn"));
  var base  = val.value.split(",").map(function (x) { return x.trim(); })
                 .filter(Boolean).map(Number).sort(function (a, b) { return a - b; });

  function cur() {
    return cells.filter(function (c) { return c.classList.contains("is-on"); })
                .map(function (c) { return Number(c.dataset.h); })
                .sort(function (a, b) { return a - b; });
  }
  function nextRun(hs) {
    if (!hs.length) return "없음 (선택된 시각이 없습니다)";
    var h = new Date().getHours();
    var later = hs.filter(function (x) { return x > h; });
    var t = later.length ? later[0] : hs[0];
    return (later.length ? "오늘 " : "내일 ") + ("0" + t).slice(-2) + ":00";
  }
  function sync() {
    var now = cur();
    var same = now.length === base.length && now.every(function (v, i) { return v === base[i]; });
    val.value = now.join(",");
    apply.disabled = same;
    undo.disabled  = same;
    state.classList.toggle("is-dirty", !same);
    state.innerHTML = "선택 <b>" + now.length + "개</b> · 다음 실행 <b>" + nextRun(now) + "</b>"
      + (same ? "" : " · <b>적용 안 됨</b>");
  }
  cells.forEach(function (c) {
    c.addEventListener("click", function () { c.classList.toggle("is-on"); sync(); });
  });
  undo.addEventListener("click", function () {
    cells.forEach(function (c) { c.classList.toggle("is-on", base.indexOf(Number(c.dataset.h)) !== -1); });
    sync();
  });
  /* 적용 안 한 변경을 들고 떠나는 것을 막는다.
     단 '적용하기' 자체도 폼 전송 = 이탈이다. 그때까지 경고를 띄우면
     저장하려는 사람에게 "나가시겠습니까?"를 묻는 꼴이 된다 — 보내는 중에는 끈다. */
  var sending = false;
  form.addEventListener("submit", function () { sending = true; });
  window.addEventListener("beforeunload", function (e) {
    if (sending || apply.disabled) return;
    e.preventDefault();
    e.returnValue = "";
  });
  sync();
})();

/* 작업 ON/OFF — 시간 그리드와 같은 '고른 뒤 적용하기' 규칙.
   예전에는 버튼 하나가 곧 POST 였다. 지금은 그 한 번이 automation.json 저장에 더해
   data.js·문서·index.html 을 고치고 커밋·푸시까지 한다. 잘못 누른 것을 되돌릴 방법이
   없는 채로 커밋이 나가면 안 된다 — 눌러 두고, 확인하고, 한 번에 보낸다. */
(function () {
  var form = document.getElementById("tform");
  if (!form) return;
  var on    = document.getElementById("ton");
  var off   = document.getElementById("toff");
  var state = document.getElementById("tstate");
  var undo  = document.getElementById("tundo");
  var apply = document.getElementById("tapply");
  var btns  = [].slice.call(document.querySelectorAll("button.tgl"));
  var base  = {};
  btns.forEach(function (b) { base[b.dataset.id] = b.dataset.on === "1"; });

  function paint(b) {
    var isOn = b.dataset.on === "1";
    b.className = "tgl " + (isOn ? "off" : "on");
    b.textContent = isOn ? "끄기" : "켜기";
    // 상태 칸도 같이 움직여야 한다 — 버튼만 바뀌면 '지금 어느 쪽인지'를 두 번 읽어야 한다.
    var cell = document.querySelector('[data-pill="' + b.dataset.id + '"]');
    if (cell) {
      cell.innerHTML = isOn ? "<span class='pill on'>ON</span>"
                            : "<span class='pill off'>OFF</span>";
      cell.style.opacity = isOn === base[b.dataset.id] ? "" : ".55";
    }
  }

  function sync() {
    var ons = [], offs = [];
    btns.forEach(function (b) {
      var isOn = b.dataset.on === "1";
      if (isOn === base[b.dataset.id]) return;
      (isOn ? ons : offs).push(b.dataset.id);
    });
    var n = ons.length + offs.length;
    on.value  = ons.join(",");
    off.value = offs.join(",");
    apply.disabled = undo.disabled = !n;
    state.classList.toggle("is-dirty", !!n);
    state.innerHTML = n
      ? "바뀐 작업 <b>" + n + "개</b> · <b>적용 안 됨</b>"
      : "바뀐 작업 없음";
    // 적용 안 한 상태로 '지금 실행'을 누르면 화면과 다른 설정으로 돈다. 그 사이에는 막는다.
    [].slice.call(document.querySelectorAll("button.run")).forEach(function (r) {
      r.disabled = !!n;
      r.title = n ? "적용하기를 먼저 누르세요" : "";
    });
  }

  btns.forEach(function (b) {
    b.addEventListener("click", function () {
      b.dataset.on = b.dataset.on === "1" ? "0" : "1";
      paint(b);
      sync();
    });
  });
  undo.addEventListener("click", function () {
    btns.forEach(function (b) {
      b.dataset.on = base[b.dataset.id] ? "1" : "0";
      paint(b);
    });
    sync();
  });
  [].slice.call(document.querySelectorAll("button.run")).forEach(function (r) {
    r.addEventListener("click", function () {
      document.getElementById("rid").value = r.dataset.id;
      document.getElementById("rform").submit();
    });
  });
  // 적용하기(폼 전송)로 떠나는 것은 경고 대상이 아니다 — 위 시간 그리드와 같은 규칙.
  var sending = false;
  form.addEventListener("submit", function () { sending = true; });
  window.addEventListener("beforeunload", function (e) {
    if (sending || apply.disabled) return;
    e.preventDefault();
    e.returnValue = "";
  });
  sync();
})();
</script>
</body></html>"""
    for k, v in (
        ("{{NOW}}",   datetime.datetime.now().strftime("%Y-%m-%d %H:%M")),
        # 허브 반영이 밀렸을 때만 뜬다. 조용히 실패하면 며칠 뒤에야 알아챈다.
        ("{{WARN}}",  '<div class="warn">⚠ %s</div>' % html.escape(warn) if warn else ""),
        ("{{HOURGRID}}", hour_grid(hours)),
        ("{{HOURS}}", ",".join(map(str, hours))),
        ("{{HOURCOUNT}}", str(len(hours))),
        ("{{NEXTRUN}}", next_run(hours, any(bool(j.get("enabled"))
                                            for j in reg.get("jobs", {}).values()))),
        ("{{ROWS}}",  "".join(rows) or '<tr><td colspan="5" class="mut">등록된 작업이 없습니다</td></tr>'),
        ("{{LOG}}",   html.escape(tail)),
    ):
        tpl = tpl.replace(k, v)
    return tpl


class H(BaseHTTPRequestHandler):
    def _redirect(self, warn=""):
        self.send_response(303)
        # 경고는 쿼리로 넘긴다 — POST 뒤 새로고침해도 같은 경고가 되살아나지 않는다.
        self.send_header("Location",
                         "/?w=" + urllib.parse.quote(warn) if warn else "/")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path not in ("/", "/index.html"):
            self.send_error(404)
            return
        warn = (urllib.parse.parse_qs(u.query).get("w") or [""])[0]
        body = page(warn).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n    = int(self.headers.get("Content-Length") or 0)
        form = urllib.parse.parse_qs(self.rfile.read(n).decode("utf-8"))
        reg  = load(REGISTRY, {"defaults": {}, "jobs": {}})

        warn = ""
        if self.path == "/toggle":
            # 화면에서 고른 결과를 **상태 그대로** 받는다(반전이 아니라 ON/OFF 명시).
            # 반전으로 받으면 다른 창에서 이미 바뀐 값에 대고 뒤집어 엉뚱한 결과가 된다.
            wanted = {}
            for jid in (form.get("off") or [""])[0].split(","):
                if jid:
                    wanted[jid] = False
            for jid in (form.get("on") or [""])[0].split(","):
                if jid:
                    wanted[jid] = True
            # 레지스트리만 바꾸면 팀이 보는 허브는 그대로다 — 카드·문서까지 밀어 넣는다.
            try:
                warn = apply_toggles(reg, wanted)
            except Exception as e:
                warn = "허브 반영 중 오류: %s" % e
        elif self.path == "/hours":
            raw = (form.get("hours") or [""])[0]
            hs  = sorted({int(x) for x in re_ints(raw) if 0 <= int(x) <= 23})
            # 전부 끄는 것(빈 목록)도 허용한다 — '한동안 멈춤'이 유효한 선택이다.
            reg.setdefault("defaults", {})["hours"] = hs
            save_registry(reg)
        elif self.path == "/run":
            jid = (form.get("id") or [""])[0]
            job = reg.get("jobs", {}).get(jid)
            if job:
                import subprocess
                subprocess.Popen(["/opt/homebrew/bin/python3",
                                  os.path.join(HERE, job["script"]), "--force"])
        self._redirect(warn)

    def log_message(self, *a):
        pass          # 접근 로그는 남기지 않는다


def re_ints(s):
    import re
    return re.findall(r"\d+", s or "")


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
