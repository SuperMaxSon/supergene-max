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
        if state.get(job_id, {}).get("slot") == slot:
            continue                                  # 이 슬롯은 이미 돌았다

        script = os.path.join(HERE, job["script"])
        if not os.path.exists(script):
            log("%s: 스크립트가 없다 (%s)" % (job_id, job["script"]))
            continue
        log("%s 실행 (슬롯 %s시)" % (job_id, due[-1]))
        r = subprocess.run([PYTHON, script], capture_output=True, text=True, timeout=1800)
        ok = r.returncode == 0
        if not ok:
            log("%s 실패 rc=%d %s" % (job_id, r.returncode, (r.stderr or "").strip()[:200]))
        # 실패도 슬롯을 소비한다 — 안 그러면 15분마다 같은 실패를 반복한다.
        # 다음 슬롯에서 다시 시도하고, 실패 알림은 갱신 스크립트가 띄운다.
        state.setdefault(job_id, {})
        state[job_id].update(slot=slot, at=now.strftime("%Y-%m-%d %H:%M:%S"), ok=ok)

    json.dump(state, open(STATE, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
