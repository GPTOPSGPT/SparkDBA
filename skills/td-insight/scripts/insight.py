#!/usr/bin/env python3
"""Data insight advisor: health of every device and line over a window, against the baseline before it.

Usage:
  insight.py health [--minutes 1] [--baseline 30] [--ago 0]

Finds: metric shifts (|z| > 4 vs baseline), flatlined sensors (zero variance), data gaps,
non-zero status codes, and line yield changes. Prints JSON findings sorted by severity + a one-line summary.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

import tdlib


def health(minutes, baseline, ago):
    c = tdlib.connect()
    w, b = minutes * 60, baseline * 60
    cur, base, ycur, ybase = tdlib.window_stats(c, w, b, ago * 60)
    findings = []
    now = datetime.now(timezone.utc).timestamp()
    for dev in sorted(set(base) | set(cur)):
        x, y0 = cur.get(dev), base.get(dev)
        if not x:
            findings.append({"severity": 3, "device": dev, "kind": "no_data", "detail": f"no rows in the last {minutes} min"})
            continue
        if x["n"] < 0.8 * w and not ago:
            findings.append({"severity": 3, "device": dev, "kind": "data_gap",
                             "detail": f"{x['n']} rows in {w}s window (expected ~{w})"})
        if x["n"] > 10 and all((x.get(f"{m}_sd") or 0) < 1e-6 for m in tdlib.METRICS):
            findings.append({"severity": 2, "device": dev, "kind": "flatline",
                             "detail": "all four metrics have zero variance: the sensor is repeating one reading"})
        if (x.get("max_status") or 0) > 0:
            findings.append({"severity": 2, "device": dev, "kind": "status", "detail": f"status code {x['max_status']} reported"})
        if not y0:
            continue
        for m in tdlib.METRICS:
            sd = max(y0.get(f"{m}_sd") or 0, abs(y0[m]) * 0.01, 1e-3)
            z = (x[m] - y0[m]) / sd
            if abs(z) > 4:
                findings.append({"severity": 2 if abs(z) < 10 else 3, "device": dev, "kind": "shift", "metric": m,
                                 "detail": f"{m} {y0[m]:.2f} -> {x[m]:.2f} (z={z:+.1f})"})
    for line in sorted(ycur):
        d = (ycur[line] or 0) - (ybase.get(line) or 0)
        if ybase.get(line) is not None and d < -3:
            findings.append({"severity": 2, "line": line, "kind": "yield_drop",
                             "detail": f"yield {ybase[line]}% -> {ycur[line]}% ({d:+.1f} pt)"})
    findings.sort(key=lambda f: -f["severity"])
    summary = (f"{len(findings)} finding(s) in the last {minutes} min" if findings
               else f"all {len(cur)} devices and {len(ycur)} lines within baseline over the last {minutes} min")
    return {"window_minutes": minutes, "baseline_minutes": baseline, "ago_minutes": ago,
            "yield_pct": {"window": ycur, "baseline": ybase}, "findings": findings, "summary": summary}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["health"])
    ap.add_argument("--minutes", type=int, default=1)
    ap.add_argument("--baseline", type=int, default=30)
    ap.add_argument("--ago", type=int, default=0)
    a = ap.parse_args()
    try:
        res = health(max(1, min(a.minutes, 120)), max(5, min(a.baseline, 720)), max(0, min(a.ago, 720)))
    except Exception as e:
        res = {"error": f"{e.__class__.__name__}: {str(e)[:300]}"}
    print(json.dumps(res, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
