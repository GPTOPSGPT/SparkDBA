"""Smoke check: inject each scenario, snapshot, classify. python -m server.smoke [ids...]"""
import json
import subprocess
import sys
import time

from . import chaos, config

ids = sys.argv[1:] or [s["id"] for s in chaos.SCENARIOS]
ok = 0
for sid in ids:
    st = chaos.start(sid, {"duration": 45})
    assert st.get("ok"), st
    chaos.wait_ready()
    time.sleep(3)
    snap = subprocess.run([f"{config.SKILLS_DIR}/pg-evidence-snapshot/scripts/run.sh"],
                          capture_output=True, text=True, timeout=60)
    if snap.returncode:
        print("SNAPSHOT ERROR", sid, snap.stderr[-600:]); chaos.stop(); continue
    snap = snap.stdout
    cls = subprocess.run([f"{config.SKILLS_DIR}/pg-root-cause/scripts/run.sh"], input=snap,
                         capture_output=True, text=True, timeout=60).stdout
    top = json.loads(cls)["hypotheses"]
    hit = top[0]["category"] == sid
    ok += hit
    print(f"{'PASS' if hit else 'FAIL'} {sid:22} -> " + ", ".join(f"{h['category']}:{h['confidence']}" for h in top[:3]))
    if not hit:
        print("   ", top[0]["evidence"], json.loads(snap)["wait_samples"])
    chaos.stop()
    while not chaos.status().get("done"):
        time.sleep(1)
print(f"{ok}/{len(ids)}")
