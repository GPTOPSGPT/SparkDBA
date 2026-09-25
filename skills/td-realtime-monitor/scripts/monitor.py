#!/usr/bin/env python3
"""Real-time analysis advisor: zero-code monitors on plant telemetry.

A monitor = selector (device or line) + metric + condition + window + action. The agent turns a sentence
("alert me if any oven runs above 200 C for 30 s") into one `create` call; the evaluator checks every monitor
every few seconds and appends alerts to a journal.

Usage:
  monitor.py create --name N (--device D | --line L | --kind K) --metric M --op '>'|'<' --value V [--window 30] [--agg avg|max|min]
  monitor.py list
  monitor.py delete --name N
  monitor.py check              # evaluate all monitors once, print firing ones
  monitor.py run [--every 5]    # evaluator loop (daemon)
  monitor.py alerts [--n 20]
"""
import argparse
import json
import os
import re
import time

import tdlib

DATA = os.environ.get("SPARKDBA_DATA", "/opt/sparkdba/data")
STORE, ALERTS = os.path.join(DATA, "td_monitors.json"), os.path.join(DATA, "td_alerts.jsonl")
NAME = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
TAGVAL = re.compile(r"^[A-Za-z0-9-]{1,16}$")
METRICS = tdlib.METRICS + ("status",)


def _load():
    try:
        return json.load(open(STORE))
    except (OSError, ValueError):
        return {}


def _save(d):
    tmp = STORE + ".tmp"
    json.dump(d, open(tmp, "w"), indent=2)
    os.replace(tmp, STORE)


def create(a):
    sel = [(k, getattr(a, k)) for k in ("device", "line", "kind") if getattr(a, k)]
    if not NAME.match(a.name or ""):
        return {"ok": False, "error": "name: letters, digits, _ - (max 40)"}
    if len(sel) != 1 or not TAGVAL.match(sel[0][1]):
        return {"ok": False, "error": "give exactly one of --device / --line / --kind, a plain tag value"}
    if a.metric not in METRICS or a.op not in (">", "<") or a.agg not in ("avg", "max", "min"):
        return {"ok": False, "error": f"metric in {METRICS}, op in > <, agg in avg max min"}
    d = _load()
    d[a.name] = {"selector": {sel[0][0] if sel[0][0] != "device" else "device_id": sel[0][1]}, "metric": a.metric,
                 "agg": a.agg, "op": a.op, "value": float(a.value), "window": max(5, min(int(a.window), 3600)),
                 "action": "journal", "created": time.strftime("%Y-%m-%dT%H:%M:%S")}
    _save(d)
    return {"ok": True, "monitor": {a.name: d[a.name]}}


def check_all(conn):
    firing = []
    for name, m in _load().items():
        (col, val), = m["selector"].items()
        sql = (f"select device_id, {m['agg']}({m['metric']}) as v from sensors where {col} = '{val}' "
               f"and ts > now - {m['window']}s partition by device_id")
        for r in tdlib.dicts(conn, sql):
            v = r["v"]
            if v is not None and ((m["op"] == ">" and v > m["value"]) or (m["op"] == "<" and v < m["value"])):
                firing.append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "monitor": name, "device": r["device_id"],
                               "value": round(v, 3), "rule": f"{m['agg']}({m['metric']}) {m['op']} {m['value']} over {m['window']}s"})
    return firing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["create", "list", "delete", "check", "run", "alerts"])
    for k in ("name", "device", "line", "kind", "metric", "op", "value"):
        ap.add_argument(f"--{k}")
    ap.add_argument("--window", type=int, default=30)
    ap.add_argument("--agg", default="avg")
    ap.add_argument("--every", type=float, default=5)
    ap.add_argument("--n", type=int, default=20)
    a = ap.parse_args()
    try:
        if a.cmd == "create":
            res = create(a)
        elif a.cmd == "list":
            res = _load()
        elif a.cmd == "delete":
            d = _load(); res = {"ok": d.pop(a.name, None) is not None}; _save(d)
        elif a.cmd == "check":
            res = {"firing": check_all(tdlib.connect())}
        elif a.cmd == "alerts":
            lines = open(ALERTS).read().splitlines()[-a.n:] if os.path.exists(ALERTS) else []
            res = [json.loads(l) for l in reversed(lines)]
        else:
            conn, last = tdlib.connect(), {}
            while True:
                for f in check_all(conn):
                    key = (f["monitor"], f["device"])
                    if time.time() - last.get(key, 0) > 60:          # one alert per monitor/device per minute
                        last[key] = time.time()
                        with open(ALERTS, "a") as fh:
                            fh.write(json.dumps(f) + "\n")
                time.sleep(a.every)
    except Exception as e:
        res = {"error": f"{e.__class__.__name__}: {str(e)[:300]}"}
    print(json.dumps(res, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
