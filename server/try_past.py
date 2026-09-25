"""python -m server.try_past <scenario> <thinking 0|1>: past-incident probe, skills mode."""
import json
import sys
import time

from . import agent, chaos

sid, think = sys.argv[1], sys.argv[2] == "1"
chaos.start(sid, {"duration": 60})
while not chaos.status().get("done"):
    time.sleep(1)
time.sleep(60)
r = agent.Run("About 2 minutes ago users saw requests time out for roughly a minute; it has cleared since. "
              "Find what caused it. Do not change anything.", "skills", thinking=think,
              on_event=lambda e: print("  ", e["t"], e.get("tool"), json.dumps(e.get("args"))[:140]) if e["type"] == "tool" else None).go()
print(r["category"], r["seconds"], r["skills_used"])
