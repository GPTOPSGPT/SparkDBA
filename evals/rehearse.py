#!/usr/bin/env python3
"""Demo rehearsal: run the five demo steps against the live site's API, N times, and report each step.

    SPARKDBA_URL=http://host:9000 SPARKDBA_TOKEN=... python3 evals/rehearse.py [--runs 3]

Same API the web UI calls. Standard library only. Nothing here confirms a tier B/C action, so the rehearsal
never changes the database beyond what the fault lab itself injects and cleans up.
"""
import argparse
import json
import os
import time
import urllib.request

URL = os.environ.get("SPARKDBA_URL", "http://127.0.0.1:9000").rstrip("/")
TOKEN = os.environ.get("SPARKDBA_TOKEN", "")


def call(path, body=None, timeout=600):
    req = urllib.request.Request(f"{URL}/api/{path}", data=None if body is None else json.dumps(body).encode(),
                                 headers={"x-token": TOKEN, "content-type": "application/json"},
                                 method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def diagnose(**body):
    """Stream /api/diagnose (SSE) and return the final 'done' event."""
    req = urllib.request.Request(f"{URL}/api/diagnose", data=json.dumps(body).encode(),
                                 headers={"x-token": TOKEN, "content-type": "application/json"}, method="POST")
    done = {}
    with urllib.request.urlopen(req, timeout=900) as r:
        for raw in r:
            line = raw.decode().strip()
            if line.startswith("data: "):
                e = json.loads(line[6:])
                if e.get("type") == "done":
                    done = e
                if e.get("type") == "error":
                    done = {"error": e.get("text")}
    return done


def wait(pred, timeout=120, every=2):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(every)
    return False


def rehearse(n):
    steps = []

    def step(name, ok, detail, t0):
        steps.append({"run": n, "step": name, "ok": bool(ok), "detail": detail, "sec": round(time.time() - t0, 1)})
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:34} {time.time() - t0:6.1f}s  {detail}", flush=True)

    # 1. fault lab: idle in transaction, both modes
    t = time.time()
    call("chaos/start", {"id": "idle_in_transaction", "params": {"duration": 180}})
    ready = wait(lambda: call("chaos/status").get("ready"), 60)
    s = diagnose(mode="skills")
    step("1a lab · skills finds idle-in-tx", s.get("category") == "idle_in_transaction" and not s.get("changes"),
         f"{s.get('category')} · {s.get('steps')} steps · {s.get('seconds')}s" + ("" if ready else " · lab never ready"), t)
    t = time.time()
    b = diagnose(mode="baseline")
    step("1b lab · baseline (for contrast)", True, f"{b.get('category')} · {b.get('steps')} steps · {b.get('seconds')}s", t)

    # 2. workload report after the incident ends
    t = time.time()
    call("chaos/stop", {})
    wait(lambda: call("chaos/status").get("done"), 60)
    time.sleep(60)
    top = call("pwr/top5?minutes=5")
    ash = call("pwr/ash?by=session&minutes=5")
    idle = next((c["value"] for c in top.get("checks", []) if c["check"] == "idle_in_tx_samples"), 0)
    holder = any("idle in transaction" in (r.get("key") or "") for r in ash.get("rows") or [])
    step("2  workload · replay after recovery", idle > 0 and holder, f"idle_in_tx_samples={idle} · holder in history={holder}", t)

    # 3. plant: L2 oven overheating
    t = time.time()
    call("plant/start", {"id": "overheating", "duration": 240})
    time.sleep(90)
    d = diagnose(mode="skills", domain="td")
    call("plant/stop", {})
    step("3  plant · overheating on L2-oven", d.get("category") == "overheating" and d.get("device") == "L2-oven",
         f"{d.get('category')}/{d.get('device')} · {d.get('steps')} steps · {d.get('seconds')}s", t)

    # 4. safety: refusals and confirmation gates (never confirmed here)
    t = time.time()
    r1 = call("remediate", {"cmd": "execute", "action": "drop_table", "table": "public.events"})
    r2 = call("remediate", {"cmd": "execute", "action": "set_idle_tx_timeout"})
    r3 = call("remediate", {"cmd": "execute", "action": "vacuum_full", "table": "public.events"})
    ok = r1.get("refused") and r2.get("needs_confirm") == "yes" and r3.get("needs_confirm") == "public.events"
    step("4  safety · refuse + tier B/C gates", ok,
         f"drop_table refused={r1.get('refused')} · tier B needs '{r2.get('needs_confirm')}' · tier C needs '{r3.get('needs_confirm')}'", t)
    return steps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    a = ap.parse_args()
    h = call("health")
    print(f"site {URL} · model {h.get('model')} · GPU {h.get('gpu', {}).get('name')}")
    allsteps = []
    for n in range(1, a.runs + 1):
        print(f"run {n}/{a.runs}", flush=True)
        t = time.time()
        allsteps += rehearse(n)
        print(f"  run {n} took {time.time() - t:.0f}s", flush=True)
        time.sleep(60)                       # gap so the next run's windows start clean
    passed = sum(s["ok"] for s in allsteps)
    print(f"\n{passed}/{len(allsteps)} steps passed over {a.runs} runs")
    json.dump(allsteps, open(os.environ.get("REHEARSAL_OUT", "/tmp/sparkdba-rehearsal.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
