#!/usr/bin/env python3
"""Dashboard advisor: turn an analysis into a saved panel that the SparkDBA UI renders and refreshes.

Usage:
  dash.py create --title T --sql "SELECT _wstart, avg(temperature) FROM sensors WHERE ... INTERVAL(10s)" [--chart line|bar] [--refresh 10]
  dash.py list
  dash.py delete --id ID
  dash.py render --id ID        # run the panel's SQL, return columns + rows

The first column is the x axis; every other column is a series. SQL goes through the same read-only guard.
"""
import argparse
import hashlib
import json
import os
import time

import tdlib

DATA = os.environ.get("SPARKDBA_DATA", "/opt/sparkdba/data")
STORE = os.path.join(DATA, "td_dashboards.json")


def _load():
    try:
        return json.load(open(STORE))
    except (OSError, ValueError):
        return {}


def _save(d):
    tmp = STORE + ".tmp"
    json.dump(d, open(tmp, "w"), indent=2, ensure_ascii=False)
    os.replace(tmp, STORE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["create", "list", "delete", "render"])
    ap.add_argument("--title"); ap.add_argument("--sql"); ap.add_argument("--id")
    ap.add_argument("--chart", default="line"); ap.add_argument("--refresh", type=int, default=10)
    a = ap.parse_args()
    try:
        d = _load()
        if a.cmd == "create":
            why = tdlib.check(a.sql or "")
            if why or not a.title or a.chart not in ("line", "bar"):
                res = {"ok": False, "error": why or "need --title and --chart line|bar"}
            else:
                cols, rows = tdlib.rows(tdlib.connect(), a.sql, limit=5)     # prove it runs before saving
                pid = hashlib.sha1((a.title + a.sql).encode()).hexdigest()[:8]
                d[pid] = {"title": a.title[:80], "sql": a.sql, "chart": a.chart,
                          "refresh": max(5, min(a.refresh, 300)), "created": time.strftime("%Y-%m-%dT%H:%M:%S")}
                _save(d)
                res = {"ok": True, "id": pid, "columns": cols, "sample_rows": rows}
        elif a.cmd == "list":
            res = d
        elif a.cmd == "delete":
            res = {"ok": d.pop(a.id or "", None) is not None}; _save(d)
        else:
            p = d.get(a.id or "")
            if not p:
                res = {"error": f"no panel {a.id}"}
            else:
                cols, rows = tdlib.rows(tdlib.connect(), p["sql"], limit=1000)
                res = {**p, "columns": cols, "rows": rows}
    except Exception as e:
        res = {"error": f"{e.__class__.__name__}: {str(e)[:300]}"}
    print(json.dumps(res, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
