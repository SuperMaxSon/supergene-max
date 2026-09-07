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


def load(p, d):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return d


def save_registry(reg):
    json.dump(reg, open(REGISTRY, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1, sort_keys=False)


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
            html.escape(j.get("scan_per_run", "?")),
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
  input[type=text]{font:inherit;padding:7px 10px;border:1px solid var(--bd);border-radius:8px;width:180px}
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
    <form method="post" action="/hours">
      <input type="text" name="hours" value="{{HOURS}}" placeholder="9, 12, 18">
      <button class="on">저장</button>
    </form>
    <div class="note">0~23 시(KST), 쉼표로 구분. 개별 시각이 지정된 작업은 그 값이 우선합니다.</div>
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
</div></body></html>"""
    for k, v in (
        ("{{NOW}}",   datetime.datetime.now().strftime("%Y-%m-%d %H:%M")),
        ("{{HOURS}}", html.escape(", ".join(map(str, hours)))),
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
            if hs:
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
