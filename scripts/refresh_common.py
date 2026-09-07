#!/usr/bin/env python3
"""두 자동 갱신 스크립트(refresh_sol_slot_ab.py / refresh_coin_match_ab.py)의 공통부.

문서마다 다른 것은 '쿼리 -> 상태 병합 -> JS 블록 생성' 까지고, 그 뒤
'멱등 검사 -> 파일 쓰기 -> 스탬프 -> 커밋 -> 푸시' 는 완전히 같다.
같은 쪽을 두 벌 들고 있으면 한쪽만 고쳐지고 갈라진다 — 실제로 그렇게 갈라져 있었다.

쓰는 법
    import refresh_common as C
    from refresh_common import Guard, git, j, log, notify, merge_by_key
    C.configure(job_id=..., log_prefix=..., notify_title=..., html=...,
                state=..., doc_url=..., commit_msg=...)
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

REPO     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_JS  = os.path.join(REPO, "data.js")
INDEX    = os.path.join(REPO, "index.html")
LOG      = os.path.join(REPO, "scripts", "refresh.log")
REGISTRY = os.path.join(REPO, "scripts", "automation.json")

# 작업별 설정. configure() 로만 바꾼다.
#   commit_msg 는 (last_day, rng) 두 값을 받는 %-템플릿이다.
_C = {"job_id": "", "log_prefix": "", "notify_title": "자동 갱신 실패",
      "html": "", "state": "", "doc_url": "", "commit_msg": "%s (%s)"}


def configure(**kw):
    unknown = sorted(set(kw) - set(_C))
    if unknown:
        raise KeyError("모르는 설정: " + ", ".join(unknown))
    _C.update(kw)


class Guard(Exception):
    pass


def log(msg):
    line = "%s  %s%s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                         _C["log_prefix"], msg)
    print(line)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def notify(msg):
    """실패했을 때만 맥 알림을 띄운다. 로그만 남기면 아무도 안 본다.
    ensure_ascii=False 가 필요하다 — 기본값이면 한글이 \\uXXXX 로 나가
    AppleScript 가 syntax error 로 죽고 알림이 조용히 사라진다."""
    try:
        subprocess.run(["/usr/bin/osascript", "-e",
                        'display notification %s with title "%s"'
                        % (json.dumps(msg[:200], ensure_ascii=False),
                           _C["notify_title"])], timeout=20)
    except Exception:
        pass


def j(v):
    return json.dumps(v, ensure_ascii=False)


def merge_by_key(old, new, keys):
    """같은 키의 행은 덮어쓰고 새 키는 추가한다."""
    idx = {tuple(str(r[k]) for k in keys): r for r in old}
    for r in new:
        idx[tuple(str(r[k]) for k in keys)] = r
    return [idx[k] for k in sorted(idx)]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="꺼져 있어도 실행")
    return ap.parse_args()


def enabled():
    """제어판(scripts/control_panel.py)이 끈 작업은 아무것도 하지 않는다.
    launchd 를 껐다 켜는 것보다 이쪽이 안전하다 — 스케줄 정의를 건드리지 않는다."""
    try:
        reg = json.load(open(REGISTRY, encoding="utf-8"))
        return bool(reg["jobs"][_C["job_id"]]["enabled"])
    except Exception:
        return True          # 레지스트리가 깨졌으면 멈추지 않는다


def git(*args):
    return subprocess.run(["git", "-C", REPO] + list(args),
                          capture_output=True, text=True, timeout=300)


def push_pending(a):
    """데이터가 안 바뀌어도, 지난 실행에서 푸시하지 못한 커밋이 남아 있으면 올린다.
    이게 없으면 '커밋은 됐고 푸시만 실패' 상태를 재시도가 복구하지 못한다 —
    두 번째 실행은 멱등 검사에서 '변화 없음'으로 끝나 push 까지 가지 않는다."""
    if a.no_push:
        return 0
    r = git("rev-list", "--count", "@{u}..HEAD")
    n = r.stdout.strip()
    ahead = int(n) if r.returncode == 0 and n.isdigit() else 0
    if ahead == 0:
        return 0
    log("미푸시 커밋 %d개 — 밀어 올린다" % ahead)
    r = git("push", "-q", "origin", "HEAD")
    if r.returncode != 0:
        log("푸시 실패: %s" % (r.stderr or r.stdout).strip()[:300])
        notify("푸시 실패 — 인증이 만료됐을 수 있습니다")
        return 1
    log("미푸시 커밋 푸시 완료")
    return 0


def stamp(now, bust, rng):
    """문서 머리의 갱신 시각·기간, 허브 카드(data.js), 캐시 버스터(index.html)."""
    s = open(_C["html"], encoding="utf-8").read()
    s = re.sub(r"문서 갱신 <b>[^<]*</b> KST", "문서 갱신 <b>%s</b> KST" % now, s, count=1)
    s = re.sub(r"데이터 <b>[^<]*</b>", "데이터 <b>%s</b>" % rng, s, count=1)
    open(_C["html"], "w", encoding="utf-8").write(s)

    url = re.escape(_C["doc_url"])
    d = open(DATA_JS, encoding="utf-8").read()
    # 사이트 전체 갱신 시각(SITE.updated). 들여쓰기 2칸이 이 한 곳뿐이라 그걸로 찍는다.
    d = re.sub(r'(\n  updated: ")[^"]*(")', r"\g<1>%s\g<2>" % now, d, count=1)
    m = re.search(r'(url: "%s".*?)version: "v(\d+)\.(\d+)"' % url, d, re.S)
    if m:
        ver = 'version: "v%s.%d"' % (m.group(2), int(m.group(3)) + 1)
        d = d[:m.start()] + m.group(1) + ver + d[m.end():]
    # 카드의 updated (url 뒤쪽 블록 안) 갱신
    d = re.sub(r'(url: "%s".*?updated: ")[^"]*(")' % url,
               r"\g<1>%s\g<2>" % now, d, count=1, flags=re.S)
    # 자동 갱신되는 문서는 Live 다. 허브에서 Live 배지(빨강)는 '이 자동화가 돌고 있다'는
    # 뜻이므로 사람이 카드를 손대다 상태를 되돌려도 다음 실행에 복구되게 한다.
    d = re.sub(r'(url: "%s".*?status: ")[^"]*(")' % url,
               r"\g<1>Live\g<2>", d, count=1, flags=re.S)
    open(DATA_JS, "w", encoding="utf-8").write(d)

    i = open(INDEX, encoding="utf-8").read()
    i = re.sub(r"data\.js\?v=\d{12}", "data.js?v=" + bust, i)
    open(INDEX, "w", encoding="utf-8").write(i)


def finish(a, state, rng, old, new, dry_dump=None):
    """멱등 검사부터 커밋·푸시까지. 두 스크립트에서 완전히 같던 꼬리다."""
    # PULLED(조회 시각)는 매 실행마다 바뀐다. 그것만 다르면 데이터는 그대로라는 뜻이므로
    # 커밋하지 않는다 — 안 그러면 같은 값을 매일 새 커밋으로 쌓는다.
    strip = lambda t: re.sub(r'\n *const PULLED = "[^"]*";', "", t)
    if strip(old) == strip(new):
        log("변화 없음 — 커밋하지 않는다 (last_day=%s)" % state["last_day"])
        return push_pending(a)
    if a.dry_run:
        log("dry-run: 변화 있음 (last_day=%s, 기간=%s) — 파일은 건드리지 않았다"
            % (state["last_day"], rng))
        if dry_dump:
            sys.stdout.write(dry_dump + "\n")
        return 0

    os.makedirs(os.path.dirname(_C["state"]), exist_ok=True)
    json.dump(state, open(_C["state"], "w", encoding="utf-8"),
              ensure_ascii=False, indent=1, sort_keys=True)
    open(_C["html"], "w", encoding="utf-8").write(new)
    now = datetime.datetime.now()
    stamp(now.strftime("%Y-%m-%d %H:%M"), now.strftime("%Y%m%d%H%M"), rng)

    # 저장소 전체(-A)가 아니라 이 작업이 쓰는 파일만 담는다 —
    # 09시에 작업 중인 미커밋 파일이 자동화 커밋에 휩쓸리지 않게.
    git("add", "--", _C["html"], _C["state"], DATA_JS, INDEX)
    msg = _C["commit_msg"] % (state["last_day"], rng)
    r = git("commit", "-q", "-m", msg)
    if r.returncode != 0:
        log("커밋 실패: %s" % (r.stderr or r.stdout).strip()[:300])
        notify("커밋 실패")
        return 1
    if a.no_push:
        log("커밋 완료(푸시 생략): %s" % msg)
        return 0
    r = git("push", "-q", "origin", "HEAD")
    if r.returncode != 0:
        log("푸시 실패: %s" % (r.stderr or r.stdout).strip()[:300])
        notify("푸시 실패 — 인증이 만료됐을 수 있습니다")
        return 1
    log("갱신 완료: %s" % msg)
    return 0
