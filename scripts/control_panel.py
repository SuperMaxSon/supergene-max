#!/usr/bin/env python3
"""자동화 제어판 — http://127.0.0.1:8787

automation.json 을 켜고/끄고, 공용 실행 시각을 바꾼다. 실제 실행은 run_due.py 가 한다.
127.0.0.1 에만 바인딩한다 — 인증이 없으므로 외부에 열면 안 된다.
"""
import datetime
import html
import json
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE     = os.path.dirname(os.path.abspath(__file__))
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


def load(p, d):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return d


def save_registry(reg):
    json.dump(reg, open(REGISTRY, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1, sort_keys=False)


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


def next_run(hours):
    if not hours:
        return "없음 (선택된 시각이 없습니다)"
    now = datetime.datetime.now()
    later = [h for h in sorted(hours) if h > now.hour]
    if later:
        return "오늘 %02d:00" % later[0]
    return "내일 %02d:00" % sorted(hours)[0]


def page():
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
          <td class="c">%s</td>
          <td class="c">%s</td>
          <td class="c mono">%s%s</td>
          <td class="c">
            <form method="post" action="/toggle" style="display:inline">
              <input type="hidden" name="id" value="%s">
              <button class="%s">%s</button>
            </form>
            <form method="post" action="/run" style="display:inline">
              <input type="hidden" name="id" value="%s">
              <button class="ghost">지금 실행</button>
            </form>
          </td>
        </tr>""" % (
            html.escape(j.get("label", jid)),
            html.escape(j.get("url", "#")),
            html.escape(j.get("script", "")),
            cost_note(j),          # 내부 생성 문자열이다. 사용자 입력은 안에서 escape 한다
            pill,
            "공용" if not own else "개별 " + html.escape(",".join(map(str, own))),
            html.escape(last), mark,
            html.escape(jid), "off" if on else "on", "끄기" if on else "켜기",
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
  </div>

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
  // 적용 안 한 변경을 들고 떠나는 것을 막는다
  window.addEventListener("beforeunload", function (e) {
    if (!apply.disabled) { e.preventDefault(); e.returnValue = ""; }
  });
  sync();
})();
</script>
</body></html>"""
    for k, v in (
        ("{{NOW}}",   datetime.datetime.now().strftime("%Y-%m-%d %H:%M")),
        ("{{HOURGRID}}", hour_grid(hours)),
        ("{{HOURS}}", ",".join(map(str, hours))),
        ("{{HOURCOUNT}}", str(len(hours))),
        ("{{NEXTRUN}}", next_run(hours)),
        ("{{ROWS}}",  "".join(rows) or '<tr><td colspan="5" class="mut">등록된 작업이 없습니다</td></tr>'),
        ("{{LOG}}",   html.escape(tail)),
    ):
        tpl = tpl.replace(k, v)
    return tpl


class H(BaseHTTPRequestHandler):
    def _redirect(self):
        self.send_response(303)
        self.send_header("Location", "/")
        self.end_headers()

    def do_GET(self):
        if self.path not in ("/", "/index.html"):
            self.send_error(404)
            return
        body = page().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n    = int(self.headers.get("Content-Length") or 0)
        form = urllib.parse.parse_qs(self.rfile.read(n).decode("utf-8"))
        reg  = load(REGISTRY, {"defaults": {}, "jobs": {}})

        if self.path == "/toggle":
            jid = (form.get("id") or [""])[0]
            if jid in reg.get("jobs", {}):
                reg["jobs"][jid]["enabled"] = not reg["jobs"][jid].get("enabled")
                save_registry(reg)
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
        self._redirect()

    def log_message(self, *a):
        pass          # 접근 로그는 남기지 않는다


def re_ints(s):
    import re
    return re.findall(r"\d+", s or "")


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
