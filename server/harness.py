"""Run the same task through an external agent harness (OpenClaw or Hermes Agent).

Both harnesses load the same skill directories (copied into their workspaces by deploy/install-*.sh) and
talk to the same local vLLM endpoint, so the user can switch harness without changing skills or model.
The built-in harness (agent.py) stays the one used for the benchmark, because it records every tool call.
"""
import json
import os
import subprocess
import tempfile
import time
import uuid

from . import agent

HOME = os.environ.get("SPARKDBA_HOME", "/opt/sparkdba")
OPENCLAW_HOME = os.environ.get("OPENCLAW_HOME", f"{HOME}/openclaw")
HERMES_HOME = os.environ.get("HERMES_HOME", f"{HOME}/hermes")
HERMES_BIN = f"{HOME}/hermes-venv/bin/hermes"
TIMEOUT = 600


def _prompt(task, domain):
    fmt = agent.TD_ANSWER_FORMAT if domain == "td" else agent.ANSWER_FORMAT
    return f"{task}\n\nUse the installed skills.\n\n{fmt}"


def run(harness: str, task: str, domain: str = "pg") -> dict:
    t0 = time.time()
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(_prompt(task, domain))
        path = f.name
    try:
        if harness == "openclaw":
            env = {**os.environ, "OPENCLAW_HOME": OPENCLAW_HOME}
            # The gateway (deploy/openclaw.sh) is always running, so the CLI routes the turn through it.
            p = subprocess.run(["openclaw", "agent", "--agent", "main", "--message-file", path, "--thinking", "off",
                                "--session-id", str(uuid.uuid4()), "--timeout", str(TIMEOUT), "--json"],
                               capture_output=True, text=True, timeout=TIMEOUT + 30, env=env)
            out = p.stdout.strip()
            try:
                j = json.loads(out[out.index("{"):])
                pl = (j.get("result") or {}).get("payloads") or []
                answer = "\n".join(x.get("text", "") for x in pl if isinstance(x, dict)) or \
                    j.get("reply") or j.get("text") or json.dumps(j)[:4000]
                if isinstance(answer, dict):
                    answer = answer.get("text") or json.dumps(answer)[:4000]
            except ValueError:
                answer = out or p.stderr[-2000:]
        elif harness == "hermes":
            env = {**os.environ, "HERMES_HOME": HERMES_HOME}
            p = subprocess.run([HERMES_BIN, "-z", open(path).read()], capture_output=True, text=True,
                               timeout=TIMEOUT + 30, env=env)
            answer = p.stdout.strip() or p.stderr[-2000:]
        else:
            return {"error": f"unknown harness {harness}"}
    except subprocess.TimeoutExpired:
        answer = f"(timed out after {TIMEOUT}s)"
    finally:
        os.unlink(path)
    cats = agent.TD_CATS if domain == "td" else agent.CATS
    return {"harness": harness, "domain": domain, "answer": answer, "seconds": round(time.time() - t0, 1),
            "category": agent.parse_category(answer, cats),
            "device": agent.parse_device(answer) if domain == "td" else None}
