#!/usr/bin/env python3
"""Root-cause advisor for plant telemetry: rank device-level fault hypotheses and verify each against the data.

Usage:
  rca.py rank [--minutes 1] [--baseline 30] [--ago 0] [--line L2]

Prints {"hypotheses": [{device, category, confidence, evidence[]}], "sql_trace": [...]} — every number
in the evidence comes from one of the queries in sql_trace, so the conclusion can be re-run.
Categories: overheating, bearing_wear, low_pressure, device_offline, stuck_sensor, healthy.
"""
import argparse
import json

import tdlib


def rank(minutes, baseline, ago, line=None):
    c = tdlib.connect()
    trace = []
    w = minutes * 60
    cur, base, ycur, ybase = tdlib.window_stats(c, w, baseline * 60, ago * 60, trace)
    ydrop = {l: round((ybase.get(l) or 0) - (ycur.get(l) or 0), 2) for l in ycur}
    hyps = []
    for dev in sorted(set(base) | set(cur)):
        x, y0 = cur.get(dev), base.get(dev)
        ln = (x or y0 or {}).get("line")
        if line and ln != line:
            continue
        ev, cands = [], []
        drop = ydrop.get(ln, 0)
        yield_ev = f"line {ln} yield {ybase.get(ln)}% -> {ycur.get(ln)}% ({-drop:+.1f} pt)"
        # Offline: missing rows. The gap is the evidence; process metrics are simply absent.
        if not x or x["n"] < 0.5 * w:
            n = x["n"] if x else 0
            cands.append(("device_offline", 0.85 + (0.1 if drop > 2 else 0),
                          [f"{dev}: {n} rows in the {w}s window (expected ~{w})"] + ([yield_ev] if drop > 2 else [])))
        elif x["n"] > 10 and all((x.get(f"{m}_sd") or 0) < 1e-6 for m in tdlib.METRICS):
            # Stuck sensor: a data-quality fault, not a process fault. Yield usually unaffected.
            cands.append(("stuck_sensor", 0.9, [f"{dev}: stddev of all four metrics is 0 over {x['n']} rows",
                                                f"{yield_ev}: {'unchanged' if drop <= 2 else 'also dropped'}"]))
        elif y0:
            r = lambda m: x[m] / y0[m] if y0[m] else 1.0
            dt = x["temperature"] - y0["temperature"]
            if dt > 8:
                cands.append(("overheating", 0.7 + (0.2 if drop > 2 else 0),
                              [f"{dev}: temperature {y0['temperature']:.1f} -> {x['temperature']:.1f} (+{dt:.1f})"]
                              + ([yield_ev] if drop > 2 else [])))
            if r("vibration") > 1.8:
                s = 0.6 + (0.1 if r("current") > 1.1 else 0) + (0.1 if (x.get("max_status") or 0) >= 2 else 0) \
                    + (0.15 if drop > 2 else 0)
                cands.append(("bearing_wear", s, [f"{dev}: vibration x{r('vibration'):.2f}, current x{r('current'):.2f}",
                                                  f"max status {x.get('max_status')}"] + ([yield_ev] if drop > 2 else [])))
            if r("pressure") < 0.8:
                cands.append(("low_pressure", 0.7 + (0.2 if drop > 2 else 0),
                              [f"{dev}: pressure {y0['pressure']:.2f} -> {x['pressure']:.2f} (x{r('pressure'):.2f})"]
                              + ([yield_ev] if drop > 2 else [])))
        for cat, conf, e in cands:
            hyps.append({"device": dev, "line": ln, "category": cat, "confidence": round(min(conf, 1.0), 2), "evidence": e})
    hyps.sort(key=lambda h: -h["confidence"])
    if not hyps or hyps[0]["confidence"] < 0.4:
        hyps.insert(0, {"device": None, "category": "healthy", "confidence": 0.7,
                        "evidence": [f"no device outside baseline over {minutes} min; yield drop max "
                                     f"{max(ydrop.values() or [0]):.1f} pt"]})
    return {"window_minutes": minutes, "hypotheses": hyps[:5], "yield_pct": {"window": ycur, "baseline": ybase},
            "sql_trace": trace}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["rank"])
    ap.add_argument("--minutes", type=int, default=1)
    ap.add_argument("--baseline", type=int, default=30)
    ap.add_argument("--ago", type=int, default=0)
    ap.add_argument("--line")
    a = ap.parse_args()
    try:
        res = rank(max(1, min(a.minutes, 120)), max(5, min(a.baseline, 720)), max(0, min(a.ago, 720)), a.line)
    except Exception as e:
        res = {"error": f"{e.__class__.__name__}: {str(e)[:300]}"}
    print(json.dumps(res, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
