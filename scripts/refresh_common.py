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
import uuid

REPO     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_JS  = os.path.join(REPO, "data.js")
INDEX    = os.path.join(REPO, "index.html")
LOG      = os.path.join(REPO, "scripts", "refresh.log")
REGISTRY = os.path.join(REPO, "scripts", "automation.json")

BQ       = "/opt/homebrew/bin/bq"
PROJECT  = "game-log-359704"

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


def log_scan(job_id):
    """방금 돌린 쿼리가 실제로 읽은 양을 로그에 남긴다.

    --job_id 를 직접 지정하고 bq show -j 로 되받는다. 이 경로는 bigquery.jobs.get
    만 쓴다 — 이 프로젝트에서 막혀 있는 jobs.list 와 다르다(실측 확인).
    추정(--dry_run)이 아니라 실제 실행된 잡의 값이다.

    네 값을 다 남기는 이유: 이 프로젝트는 reservation(edition=STANDARD)이 붙어 있어
    바이트 청구와 슬롯 과금 중 무엇이 실제 비용인지 확정되지 않았다. 한쪽만 적으면
    나중에 요금을 대조할 수 없다.

    측정이 실패해도 예외를 올리지 않는다 — 비용 기록 때문에 갱신이 멈추면 안 된다.
    """
    r = subprocess.run([BQ, "show", "--format=json", "-j", job_id],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        log("스캔량 조회 실패(갱신은 계속): %s" % (r.stderr or r.stdout).strip()[:150])
        return
    try:
        st = json.loads(r.stdout).get("statistics", {})
        q  = st.get("query", {})
        pick = lambda k: st.get(k) or q.get(k) or 0
        gib  = lambda v: int(v) / 1024.0 ** 3
        log("스캔 %.3f GiB · 청구 %.3f GiB · 슬롯 %.1f초 · 파티션 %s%s"
            % (gib(pick("totalBytesProcessed")), gib(pick("totalBytesBilled")),
               int(pick("totalSlotMs")) / 1000.0, pick("totalPartitionsProcessed"),
               " · 캐시 적용(청구 없음)" if q.get("cacheHit") else ""))
    except Exception as e:
        log("스캔량 파싱 실패(갱신은 계속): %s: %s" % (type(e).__name__, e))


def bq_query(sql):
    """쿼리를 돌려 파싱된 행을 준다. 읽은 양은 log_scan() 이 로그에 남긴다."""
    jid = "auto_%s_%s" % (_C["job_id"].replace("-", "_"), uuid.uuid4().hex[:10])
    out = subprocess.run(
        [BQ, "query", "--use_legacy_sql=false", "--format=json", "--quiet",
         "--project_id=" + PROJECT, "--max_rows=100", "--job_id=" + jid],
        input=sql, capture_output=True, text=True, timeout=900)
    if out.returncode != 0:
        raise Guard("bq query 실패: " + (out.stderr or out.stdout).strip()[:500])
    log_scan(jid)
    return json.loads(out.stdout)


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


def dirty(path):
    """이 파일에 우리가 건드리기 전부터 미커밋 변경이 있었나.

    data.js · index.html 은 허브 공유 파일이라 사람이 편집 중일 수 있다. 그대로
    git add 하면 남의 미완성 작업이 자동화 커밋에 실려 푸시된다 — 2026-09-07 에
    실제로 그렇게 됐다(라이브 섹션 정의만 먼저 커밋되고 그걸 채우는 app.js 는 빠졌다).

    판정 불가(리턴코드 2 이상)는 '더럽다'로 본다. 못 믿을 때는 건드리지 않는 쪽이 안전하다.
    """
    r = git("diff", "--quiet", "HEAD", "--", path)
    return r.returncode != 0


def push_pending(a):
    """데이터가 안 바뀌어도, 지난 실행에서 푸시하지 못한 커밋이 남아 있으면 올린다.
    이게 없으면 '커밋은 됐고 푸시만 실패' 상태를 재시도가 복구하지 못한다 —
    두 번째 실행은 멱등 검사에서 '변화 없음'으로 끝나 push 까지 가지 않는다.

    단 --dry-run 에서는 올리지 않는다. dry-run 은 '아무것도 바깥으로 내보내지 않는다'는
    약속인데, 지난 실행이 남긴 커밋이라도 여기서 밀면 그 약속이 깨진다. 손으로 확인하려고
    dry-run 을 돌렸다가 푸시가 나가면 놀랄 수밖에 없다 — 있다는 사실만 로그로 알린다."""
    r = git("rev-list", "--count", "@{u}..HEAD")
    n = r.stdout.strip()
    ahead = int(n) if r.returncode == 0 and n.isdigit() else 0
    if ahead == 0:
        return 0
    if a.no_push or a.dry_run:
        log("미푸시 커밋 %d개가 있다 — %s 이므로 올리지 않는다"
            % (ahead, "--dry-run" if a.dry_run else "--no-push"))
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
    """문서 머리의 갱신 시각·기간, 허브 카드(data.js), 캐시 버스터(index.html).

    **실제로 쓴 공유 파일 목록을 돌려준다.** 사람이 편집 중인 파일은 쓰지도, 담지도 않는다.
    카드가 한 번 낡은 채로 남지만 다음 실행이 따라잡는다 — 남의 작업을 실어 보내는 쪽이
    훨씬 비싸다. 문서 본문(_C["html"])은 이 작업 전용 파일이고 splice 가 마커 밖을
    보존하며 병합하므로 이 판정에서 뺀다.
    """
    s = open(_C["html"], encoding="utf-8").read()
    s = re.sub(r"문서 갱신 <b>[^<]*</b> KST", "문서 갱신 <b>%s</b> KST" % now, s, count=1)
    s = re.sub(r"데이터 <b>[^<]*</b>", "데이터 <b>%s</b>" % rng, s, count=1)
    open(_C["html"], "w", encoding="utf-8").write(s)

    touched = []
    if dirty(DATA_JS):
        log("⚠ data.js 에 미커밋 변경이 있다 — 허브 카드 갱신을 건너뛴다"
            " (남의 편집을 자동화 커밋에 싣지 않기 위해). 다음 실행이 따라잡는다.")
        return touched

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
    touched.append(DATA_JS)

    # 캐시 버스터는 data.js 를 실제로 바꿨을 때만 올린다. 위에서 건너뛰었으면
    # 여기까지 오지 않는다 — 바뀌지도 않은 파일의 캐시를 깨봐야 얻는 게 없다.
    if dirty(INDEX):
        log("⚠ index.html 에 미커밋 변경이 있다 — 캐시 버스터를 건너뛴다."
            " data.js 는 갱신됐으므로 팀에는 최대 10분 늦게 보인다.")
        return touched
    i = open(INDEX, encoding="utf-8").read()
    i = re.sub(r"data\.js\?v=\d{12}", "data.js?v=" + bust, i)
    open(INDEX, "w", encoding="utf-8").write(i)
    touched.append(INDEX)
    return touched


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
    shared = stamp(now.strftime("%Y-%m-%d %H:%M"), now.strftime("%Y%m%d%H%M"), rng)

    # 저장소 전체(-A)가 아니라 이 작업이 실제로 쓴 파일만 담는다 —
    # 09시에 작업 중인 미커밋 파일이 자동화 커밋에 휩쓸리지 않게.
    # shared 는 stamp() 가 정말로 고친 공유 파일만 들어 있다(더러운 것은 빠진다).
    git("add", "--", _C["html"], _C["state"], *shared)
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
