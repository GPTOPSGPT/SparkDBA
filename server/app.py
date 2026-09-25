"""SparkDBA API + static UI. Everything runs on the DGX Spark (gx10)."""
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse

from . import agent, chaos, config, harness, llm, plant

app = FastAPI(title="SparkDBA")
WEB = config.ROOT / "web" / "dist"
RUNS = config.DATA / "runs.jsonl"
BENCH = config.ROOT / "evals" / "results" / "summary.json"
_gpu_lock = threading.Lock()     # one agent run at a time: the model is the shared resource

TASK = ("Users report the shop API is slow and some requests time out. "
        "Diagnose database lab. Do not change anything.")
TD_TASK = ("Operators say something looks wrong on the production lines in the last minute or two. "
           "Find which device is responsible and why. Do not change anything.")


@app.middleware("http")
async def auth(request: Request, call_next):
    if not config.TOKEN:
        return await call_next(request)
    tok = request.query_params.get("token")
    if tok == config.TOKEN:
        resp = RedirectResponse(request.url.path)
        resp.set_cookie("sdb", tok, httponly=True, samesite="lax", max_age=14 * 86400)
        return resp
    if request.cookies.get("sdb") == config.TOKEN or request.headers.get("x-token") == config.TOKEN:
        return await call_next(request)
    return JSONResponse({"error": "unauthorized: open the link with ?token=..."}, status_code=401)


def _gpu():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,utilization.gpu,temperature.gpu,power.draw",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
        name, util, temp, power = [x.strip() for x in out.strip().split(",")]
        mem = {}
        for line in open("/proc/meminfo"):
            k, v = line.split(":")
            mem[k] = int(v.split()[0])
        return {"name": name, "util": util, "temp": temp, "power": power,
                "mem_total_gb": round(mem["MemTotal"] / 1048576, 1),
                "mem_used_gb": round((mem["MemTotal"] - mem["MemAvailable"]) / 1048576, 1)}
    except Exception as e:     # health endpoint must never 500
        return {"error": str(e)}


def _decode_tps():
    """Average decode speed from vLLM's own Prometheus counters."""
    try:
        txt = llm._client.get(config.LLM_URL.rsplit("/v1", 1)[0] + "/metrics", timeout=3).text
        get = lambda k: sum(float(l.rsplit(" ", 1)[1]) for l in txt.splitlines() if l.startswith(k))
        n, t = get("vllm:request_time_per_output_token_seconds_count"), get("vllm:request_time_per_output_token_seconds_sum")
        return {"decode_tok_s": round(n / t, 1) if t else None, "requests": int(n),
                "generated_tokens": int(get("vllm:generation_tokens_total")),
                "prompt_tokens": int(get("vllm:prompt_tokens_total"))}
    except Exception:
        return {}


@app.get("/api/health")
def health():
    m = llm.models()
    return {"model": (m or {}).get("data", [{}])[0].get("id") if m else None,
            "model_path": "Nemotron-3.5-Lightning-30B-A3B-NVFP4", "gpu": _gpu(), "llm": _decode_tps(),
            "chaos": chaos.status(), "busy": _gpu_lock.locked()}


@app.get("/api/scenarios")
def scenarios():
    return chaos.public()


@app.post("/api/chaos/start")
async def chaos_start(req: Request):
    b = await req.json()
    return chaos.start(b.get("id", ""), b.get("params") or {})


@app.post("/api/chaos/stop")
def chaos_stop():
    return chaos.stop()


@app.get("/api/chaos/status")
def chaos_status():
    return chaos.status()


@app.get("/api/skills")
def skills():
    out = []
    for k in agent.skill_catalog():
        d = Path(k["dir"])
        read = lambda n: (d / n).read_text() if (d / n).exists() else None
        out.append({"name": k["name"], "description": k["description"], "body": k["body"],
                    "files": sorted(str(p.relative_to(d)) for p in d.rglob("*") if p.is_file()),
                    "evals": json.loads(read("evals/evals.json") or "null"),
                    "benchmark": read("BENCHMARK.md"), "card": read("skill-card.md")})
    return out


@app.post("/api/diagnose")
async def diagnose(req: Request):
    b = await req.json()
    mode = b.get("mode") if b.get("mode") in ("baseline", "skills") else "skills"
    domain = "td" if b.get("domain") == "td" else "pg"
    which = b.get("harness") if b.get("harness") in ("builtin", "openclaw", "hermes") else "builtin"
    task = (b.get("task") or (TD_TASK if domain == "td" else TASK))[:2000]
    q: queue.Queue = queue.Queue()

    def work():
        if not _gpu_lock.acquire(blocking=False):
            q.put({"type": "error", "text": "another diagnosis is running"}); q.put(None); return
        try:
            if domain == "td":
                scen = plant.status().get("active")
            else:
                st = chaos.status()
                scen = st.get("active") if not st.get("done") else None
            if which == "builtin":
                r = agent.Run(task, mode, user_confirm=b.get("confirm", ""), thinking=bool(b.get("thinking")),
                              on_event=q.put, domain=domain).go()
            else:    # OpenClaw / Hermes: same skills and model, final answer only
                q.put({"type": "start", "mode": which, "task": task, "t": 0})
                r = harness.run(which, task, domain)
                q.put({"type": "answer", "text": r["answer"], "t": r["seconds"]})
                r.update(mode=which, steps=None, prompt_tokens=0, completion_tokens=0, changes=[], skills_used=[],
                         traceability=None)
                q.put({"type": "done", **{k: v for k, v in r.items() if k != "answer"}, "t": r["seconds"]})
            r.update(ts=time.strftime("%Y-%m-%dT%H:%M:%S"), scenario=scen, task=task, harness=which)
            with open(RUNS, "a") as f:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        except Exception as e:
            q.put({"type": "error", "text": f"{e.__class__.__name__}: {e}"})
        finally:
            _gpu_lock.release()
            q.put(None)

    threading.Thread(target=work, daemon=True).start()

    def stream():
        while (e := q.get()) is not None:
            yield f"data: {json.dumps(e, ensure_ascii=False, default=str)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/remediate")
async def remediate(req: Request):
    """Human path: the operator in the UI supplies --confirm, never the agent."""
    b = await req.json()
    argv = [b.get("cmd", "preview"), str(b.get("action", ""))]
    for k in ("table", "column", "pid", "confirm"):
        if b.get(k):
            argv += [f"--{k}", str(b[k])]
    if argv[0] not in ("preview", "execute", "catalog"):
        return {"ok": False, "error": "bad cmd"}
    p = subprocess.run([f"{config.SKILLS_DIR}/pg-safe-remediation/scripts/run.sh", *argv],
                       capture_output=True, text=True, timeout=300)
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {"ok": False, "error": (p.stderr or p.stdout)[-500:]}


PWR = config.SKILLS_DIR / "pg-workload-report" / "scripts" / "run.sh"


def _pwr(*argv):
    p = subprocess.run([str(PWR), *map(str, argv)], capture_output=True, text=True, timeout=60)
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {"error": (p.stderr or p.stdout)[-400:]}


@app.get("/api/pwr/top5")
def pwr_top5(minutes: int = 10, ago: int = 0):
    return _pwr("top5", "--minutes", max(1, min(minutes, 180)), "--ago", max(0, min(ago, 180)))


@app.get("/api/pwr/ash")
def pwr_ash(by: str = "wait", minutes: int = 10, ago: int = 0):
    return _pwr("ash", "--by", by, "--minutes", max(1, min(minutes, 180)), "--ago", max(0, min(ago, 180)))


@app.get("/api/pwr/list")
def pwr_list():
    return _pwr("list", "--n", 30)


@app.get("/api/pwr/report")
def pwr_report(frm: int, to: int):
    return _pwr("report", "--from", frm, "--to", to)


@app.post("/api/pwr/snapshot")
def pwr_snapshot():
    return _pwr("snapshot")


def _skill(name, *argv):
    p = subprocess.run([str(config.SKILLS_DIR / name / "scripts" / "run.sh"), *map(str, argv)],
                       capture_output=True, text=True, timeout=120)
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {"error": (p.stderr or p.stdout)[-400:]}


@app.get("/api/plant/faults")
def plant_faults():
    return plant.public()


@app.get("/api/plant/status")
def plant_status():
    return plant.status()


@app.post("/api/plant/start")
async def plant_start(req: Request):
    b = await req.json()
    return plant.start(b.get("id", ""), int(b.get("duration", 300)))


@app.post("/api/plant/stop")
def plant_stop():
    return plant.stop()


@app.get("/api/td/insight")
def td_insight(minutes: int = 1):
    return _skill("td-insight", "health", "--minutes", max(1, min(minutes, 120)))


@app.get("/api/td/rca")
def td_rca(minutes: int = 1):
    return _skill("td-root-cause", "rank", "--minutes", max(1, min(minutes, 120)))


@app.get("/api/td/series")
def td_series(device: str = "L2-oven", metric: str = "temperature", minutes: int = 15):
    """Live chart data for the plant page (fixed, validated query)."""
    if metric not in ("temperature", "vibration", "pressure", "current") or not all(c.isalnum() or c == "-" for c in device):
        return {"error": "bad device or metric"}
    m = max(1, min(minutes, 120))
    dev = _skill("td-connector", "query", "--sql",
                 f"select _wstart, avg({metric}) from sensors where device_id = '{device}' and ts > now - {m}m interval(10s)")
    yld = _skill("td-connector", "query", "--sql",
                 f"select _wstart, line, sum(good)*100.0/sum(produced) from output where ts > now - {m}m "
                 f"partition by line interval(10s)")
    return {"device": dev, "yield": yld}


@app.get("/api/td/dashboards")
def td_dashboards():
    return _skill("td-dashboard", "list")


@app.get("/api/td/panel/{pid}")
def td_panel(pid: str):
    return _skill("td-dashboard", "render", "--id", pid[:16])


@app.get("/api/td/monitors")
def td_monitors():
    return {"monitors": _skill("td-realtime-monitor", "list"), "alerts": _skill("td-realtime-monitor", "alerts", "--n", 20)}


def _tail(path: Path, n: int):
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines()[-n:] if l.strip()]


@app.get("/api/runs")
def runs(n: int = 30):
    return list(reversed(_tail(RUNS, min(n, 200))))


@app.get("/api/journal")
def journal():
    return list(reversed(_tail(config.DATA / "remediation.jsonl", 50)))


@app.get("/api/bench")
def bench():
    return json.loads(BENCH.read_text()) if BENCH.exists() else {"status": "not run yet"}


MEDIA = Path(os.environ.get("SPARKDBA_HOME", "/opt/sparkdba")) / "media"
MEDIA_FILES = {"sparkdba-demo-zh.mp4", "sparkdba-demo-en.mp4", "poster-zh.jpg", "poster-en.jpg",
               "sparkdba-demo-zh.vtt", "sparkdba-demo-en.vtt"}


@app.get("/media/{name}")
def media(name: str):
    """Demo films and posters, kept out of git; whitelisted names only. FileResponse handles Range for seeking."""
    f = MEDIA / name
    if name not in MEDIA_FILES or not f.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(f)


@app.get("/{path:path}")
def spa(path: str):
    f = WEB / path
    if path and f.is_file() and WEB in f.resolve().parents:
        return FileResponse(f)
    idx = WEB / "index.html"
    return FileResponse(idx) if idx.exists() else JSONResponse({"error": "web not built"}, status_code=503)
