#!/usr/bin/env python3
"""자동화 러너 — launchd 가 15분마다 이걸 부르고, 실제 실행 여부는 여기서 판정한다.

왜 launchd 스케줄을 직접 쓰지 않나
    launchd 는 plist 의 StartCalendarInterval 만 읽는다. 시간을 바꾸려면 plist 를 다시 쓰고
    재등록해야 하는데, 그 과정이 실패하면 스케줄이 조용히 사라진다.
    대신 launchd 는 '자주 깨우기'만 맡고, 예정 시각 판정은 automation.json 을 읽어 여기서 한다.
    깨어나는 비용은 파이썬 기동 0.1초뿐이고, BQ 쿼리는 예정 시각에만 돈다.

catch-up
    '오늘 예정된 슬롯 중 이미 지났는데 아직 안 돈 것'이 있으면 실행한다.
    그래서 맥이 잠자기였거나 꺼져 있었어도, 켜는 순간 그날 몫을 돌린다.
"""
import datetime
import json
import os
import subprocess
import sys

HERE     = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "automation.json")
STATE    = os.path.join(HERE, "run_state.json")
LOG      = os.path.join(HERE, "refresh.log")
PYTHON   = "/opt/homebrew/bin/python3"
GCLOUD   = "/opt/homebrew/bin/gcloud"
MAX_TRIES = 2      # 실패한 슬롯의 최대 시도 횟수

# BQ 자격증명이 만료됐을 때 bq 가 뱉는 말. 이건 '실패'가 아니라 '사람이 필요함'이다.
AUTH_MARKS = ("Reauthentication failed", "gcloud auth login",
              "Your default credentials", "invalid_grant")


def log(msg):
    line = "%s  [runner] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def save(state):
    """임시 파일에 쓰고 교체한다. 쓰는 중에 죽으면 깨진 JSON 이 남고,
    load() 가 그걸 {} 로 삼켜 모든 슬롯을 잊는다."""
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, STATE)


def needs_login(out):
    return any(m in out for m in AUTH_MARKS)


def prompt_login():
    """터미널 창을 띄워 거기서 gcloud auth login 을 돌린다.

    launchd 아래에서는 gcloud 가 재인증을 물을 수 없다("cannot prompt during
    non-interactive execution"). 알림만 띄우면 사람이 로그인 명령을 직접 찾아 쳐야 하고,
    그 사이 슬롯이 지나간다 — 2026-09-08 09:07 에 실제로 그랬다.

    슬롯당 한 번만 부른다. 15분마다 창이 뜨면 아무도 안 본다.
    gcloud 는 절대경로로 부른다 — 터미널 PATH 를 믿을 수 없다.
    """
    cmd = ("%s auth login && echo '' && "
           "echo '✅ 로그인 완료 — 15분 안에 자동화가 알아서 다시 시도합니다'" % GCLOUD)
    # ensure_ascii=False 가 필요하다 — 기본값이면 한글이 \uXXXX 로 나가 AppleScript 가
    # "Expected \" but found unknown token" 으로 죽고 창이 조용히 안 뜬다.
    # refresh_common.notify() 가 같은 함정에 한 번 빠졌던 자리다.
    script = ('tell application "Terminal" to do script %s'
              % json.dumps(cmd, ensure_ascii=False))
    try:
        subprocess.run(["/usr/bin/osascript",
                        "-e", script,
                        "-e", 'tell application "Terminal" to activate'], timeout=30)
        log("BQ 인증 만료 — 터미널을 띄워 로그인을 요청했다")
    except Exception as e:
        log("로그인 창을 띄우지 못했다 %s: %s" % (type(e).__name__, str(e)[:150]))
    try:
        subprocess.run(["/usr/bin/osascript", "-e",
                        'display notification "터미널에서 로그인해 주세요" '
                        'with title "BQ 인증 만료"'], timeout=20)
    except Exception:
        pass


def main():
    reg   = load(REGISTRY, None)
    if not reg:
        log("automation.json 을 읽을 수 없다 — 아무것도 하지 않는다")
        return 1
    state = load(STATE, {})
    now   = datetime.datetime.now()
    today = now.date().isoformat()
    dflt  = reg.get("defaults", {}).get("hours") or []

    for job_id, job in sorted(reg.get("jobs", {}).items()):
        if not job.get("enabled"):
            continue
        hours = sorted(int(h) for h in (job.get("hours") or dflt))
        if not hours:
            continue
        # 오늘 이미 지난 슬롯 중 가장 늦은 것
        due = [h for h in hours if h <= now.hour]
        if not due:
            continue
        slot = "%s %02d" % (today, due[-1])
        st   = state.get(job_id, {})
        if st.get("slot") == slot:
            if st.get("ok"):
                continue
            if st.get("tries", 0) >= MAX_TRIES:
                if not st.get("gave_up"):
                    log("%s 오늘은 포기 — %d회 모두 실패" % (job_id, MAX_TRIES))
                    st["gave_up"] = True
                    save(state)
                continue
            log("%s 재시도 (%d/%d)" % (job_id, st.get("tries", 0) + 1, MAX_TRIES))

        script = os.path.join(HERE, job["script"])
        if not os.path.exists(script):
            log("%s: 스크립트가 없다 (%s)" % (job_id, job["script"]))
            continue
        log("%s 실행 (슬롯 %s시)" % (job_id, due[-1]))
        auth = False
        try:
            r  = subprocess.run([PYTHON, script],
                                capture_output=True, text=True, timeout=1800)
            ok = r.returncode == 0
            if not ok:
                auth = needs_login((r.stdout or "") + (r.stderr or ""))
                log("%s 실패 rc=%d %s"
                    % (job_id, r.returncode, (r.stderr or "").strip()[:200]))
        except Exception as e:
            # 이 except 가 없으면 시간초과가 main() 을 뚫고 나가 상태 저장을 건너뛴다.
            # 슬롯이 기록되지 않으니 15분마다 같은 시간초과를 무한 반복하게 된다.
            ok = False
            log("%s 중단 %s: %s" % (job_id, type(e).__name__, str(e)[:200]))

        # 인증 만료는 시도 횟수를 깎지 않는다. 재시도해서 풀릴 성질이 아니라 사람이
        # 로그인해야 풀리는 것이고, 로그인만 되면 다음 깨어남이 알아서 따라잡는다.
        # 여기서 tries 를 소모하면 로그인이 30분 늦었다는 이유로 그날 갱신이 통째로 날아간다.
        # 쿼리가 아예 실행되지 않으므로 재시도 비용도 0 이다.
        if auth:
            if state.get("_auth_prompt_slot") != slot:
                prompt_login()
                state["_auth_prompt_slot"] = slot
                save(state)
            continue

        tries = (st.get("tries", 0) + 1) if st.get("slot") == slot else 1
        state.setdefault(job_id, {})
        state[job_id].update(slot=slot, at=now.strftime("%Y-%m-%d %H:%M:%S"),
                             ok=ok, tries=tries)
        state[job_id].pop("gave_up", None)
        save(state)          # 다음 작업이 죽어도 이 결과는 남는다

    save(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
