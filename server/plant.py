"""Plant lab: a simulated production plant writing 1-second telemetry into TDengine, with injectable faults.

Same idea as chaos.py for PostgreSQL: every fault is self-ending and has a known ground truth
(which device, which kind), so the TDengine advisors can be scored with and without skills.

Layout (database `plant`):
  STABLE sensors(ts, temperature, vibration, pressure, current, status) TAGS(device_id, line, kind)
  STABLE output(ts, produced, good) TAGS(line)
  3 lines x 5 devices; each line's yield depends on its devices' health.

Device and line names are neutral; nothing in the data names the fault.
"""
import json
import math
import random
import time

import taos

from . import config

LINES = ["L1", "L2", "L3"]
KINDS = ["press", "oven", "compressor", "conveyor", "robot"]
DEVICES = [(f"{l}-{k}", l, k) for l in LINES for k in KINDS]
# normal operating point per kind: temperature, vibration, pressure, current
BASE = {"press": (45, 2.0, 6.0, 30), "oven": (180, 1.0, 1.0, 55), "compressor": (60, 3.0, 8.0, 40),
        "conveyor": (35, 1.5, 1.0, 12), "robot": (40, 1.2, 5.0, 20)}


def _conn():
    return taos.connect(user="sparkdba_sim", password=config.env("TD_SIM_PASS"), database="plant")


def setup():
    c = taos.connect(user="sparkdba_sim", password=config.env("TD_SIM_PASS"))
    c.execute("create database if not exists plant keep 30 duration 1")
    c.execute("use plant")
    c.execute("create stable if not exists sensors (ts timestamp, temperature float, vibration float, "
              "pressure float, current float, status int) tags (device_id nchar(16), line nchar(4), kind nchar(12))")
    c.execute("create stable if not exists output (ts timestamp, produced int, good int) tags (line nchar(4))")
    for dev, line, kind in DEVICES:
        c.execute(f"create table if not exists s_{dev.replace('-', '_').lower()} using sensors tags ('{dev}', '{line}', '{kind}')")
    for line in LINES:
        c.execute(f"create table if not exists o_{line.lower()} using output tags ('{line}')")
    c.close()
    return {"ok": True, "devices": len(DEVICES)}


# fault id -> (description, target device, effect(device, t_since_start, value dict) -> value dict | None)
def _drift(v, t, dur):
    v["temperature"] += 40 * min(1.0, t / (0.6 * dur))          # slow overheating
    return v


def _bearing(v, t, dur):
    v["vibration"] *= 1 + 3 * min(1.0, t / (0.5 * dur)) + random.random()
    v["current"] *= 1.25
    if t > 0.7 * dur:
        v["status"] = 2                                           # fault state near the end
    return v


def _pressure(v, t, dur):
    v["pressure"] *= 0.55                                         # compressor underperforming
    return v


FAULTS = {
    "overheating": {"name": "设备过热（温度漂移）", "en": "Overheating (temperature drift)",
                    "device": "L2-oven", "effect": _drift, "yield_hit": 0.18},
    "stuck_sensor": {"name": "传感器卡死（数据冻结）", "en": "Stuck sensor (flatline)",
                     "device": "L1-press", "effect": None, "yield_hit": 0.0},
    "bearing_wear": {"name": "轴承磨损（振动升高）", "en": "Bearing wear (vibration rise)",
                     "device": "L3-conveyor", "effect": _bearing, "yield_hit": 0.12},
    "device_offline": {"name": "设备离线（数据中断）", "en": "Device offline (data gap)",
                       "device": "L1-robot", "effect": None, "yield_hit": 0.08},
    "low_pressure": {"name": "气压不足（压缩机）", "en": "Low pressure (compressor)",
                     "device": "L2-compressor", "effect": _pressure, "yield_hit": 0.15},
    "healthy": {"name": "健康对照（无故障）", "en": "Healthy control", "device": None, "effect": None, "yield_hit": 0.0},
}

CONTROL = config.DATA / "plant_control.json"      # written by start()/stop() in any process
BEAT = config.DATA / "plant_heartbeat.json"       # written by the writer daemon every second


def _read(p, default):
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return default


def _write(p, obj):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj))
    tmp.replace(p)


def _normal(kind, t):
    tb, vb, pb, cb = BASE[kind]
    wave = math.sin(t / 300.0)                                    # slow shift pattern
    return {"temperature": tb + 2 * wave + random.gauss(0, 0.6), "vibration": max(0.1, vb + random.gauss(0, 0.15)),
            "pressure": pb + random.gauss(0, 0.08), "current": cb + 1.5 * wave + random.gauss(0, 0.5), "status": 0}


def serve():
    """Writer daemon: one row per device per second plus per-line output, forever."""
    c = _conn()
    frozen, seen, log = {}, None, []

    def note(msg):
        log.append(f"{time.strftime('%H:%M:%S')} {msg}")
        del log[:-15]

    note("telemetry writer started")
    while True:
        now = time.time()
        ms = int(now * 1000)
        ctl = _read(CONTROL, {})
        f = ctl.get("fault")
        started, dur = ctl.get("started", 0), ctl.get("duration", 0)
        if f and now - started >= dur:
            f = None
        key = (f, started)
        if key != seen:
            note(f"fault {f} injected for {dur}s" if f else "no fault active")
            frozen, seen = {}, key
        spec = FAULTS.get(f) if f else None
        rows = []
        line_health = {l: 1.0 for l in LINES}
        for dev, line, kind in DEVICES:
            v = _normal(kind, now)
            if spec and spec["device"] == dev:
                t = now - started
                if f == "device_offline":
                    line_health[line] -= spec["yield_hit"]
                    continue                                      # no row: the gap is the evidence
                if f == "stuck_sensor":
                    v = frozen.setdefault(dev, v)                 # same reading every second
                else:
                    v = spec["effect"](v, t, dur)
                    line_health[line] -= spec["yield_hit"] * min(1.0, t / (0.5 * dur))
            tbl = "s_" + dev.replace("-", "_").lower()
            rows.append(f"{tbl} values ({ms}, {v['temperature']:.2f}, {v['vibration']:.3f}, "
                        f"{v['pressure']:.3f}, {v['current']:.2f}, {v['status']})")
        for line in LINES:
            produced = 10 + random.randint(-1, 1)
            good = max(0, round(produced * min(1.0, max(0.0, 0.97 * line_health[line] + random.gauss(0, 0.01)))))
            rows.append(f"o_{line.lower()} values ({ms}, {produced}, {good})")
        try:
            c.execute("insert into " + " ".join(rows))
        except taos.Error as e:
            note(f"write error: {e}")
        _write(BEAT, {"ts": now, "fault": f, "log": log})
        time.sleep(max(0.0, 1.0 - (time.time() - now)))


def start(fault: str, duration: int = 180) -> dict:
    if fault not in FAULTS:
        return {"ok": False, "error": f"unknown fault {fault}"}
    st = status()
    if st["active"]:
        return {"ok": False, "error": f"fault {st['active']} still active"}
    _write(CONTROL, {"fault": fault if fault != "healthy" else None, "started": time.time(),
                     "duration": max(30, min(int(duration), 900)), "label": fault})
    return {"ok": True, **status()}


def stop() -> dict:
    _write(CONTROL, {"fault": None, "started": time.time(), "duration": 0})
    return status()


def status() -> dict:
    ctl, beat = _read(CONTROL, {}), _read(BEAT, {})
    now = time.time()
    active = ctl.get("fault") if ctl.get("fault") and now - ctl.get("started", 0) < ctl.get("duration", 0) else None
    return {"writer": now - beat.get("ts", 0) < 5, "active": active,
            "elapsed": int(now - ctl.get("started", now)) if active else 0,
            "duration": ctl.get("duration", 0) if active else 0, "log": beat.get("log", [])}


def wait_done():
    while status()["active"]:
        time.sleep(1)


def public():
    return [{"id": k, "name": v["name"], "en": v["en"], "device": v["device"]} for k, v in FAULTS.items()]


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["serve"]:
        setup()
        serve()
    elif sys.argv[1:] == ["setup"]:
        print(setup())
