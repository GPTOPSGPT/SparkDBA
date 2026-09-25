#!/usr/bin/env python3
"""TDengine connector: schema discovery and guarded read-only SQL on database `plant`.

Usage:
  td.py schema                 # super tables, columns, tags, devices (with last-seen age)
  td.py query --sql "SELECT ..."   # one read-only statement, up to 500 rows
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tdlib  # noqa: E402


def schema(c):
    out = {"database": "plant", "stables": {}}
    for st in [r["stable_name"] for r in tdlib.dicts(c, "show stables")]:
        desc = tdlib.dicts(c, f"describe {st}")
        out["stables"][st] = {"columns": [d["field"] for d in desc if d.get("note") != "TAG"],
                              "tags": [d["field"] for d in desc if d.get("note") == "TAG"]}
    devs = tdlib.dicts(c, "select device_id, line, kind, last(ts) as last_ts from sensors partition by tbname, device_id, line, kind")
    now = time.time()
    for d in devs:
        d["seconds_since_last"] = round(now - _epoch(d.pop("last_ts")), 1)
    out["devices"] = sorted(devs, key=lambda d: d["device_id"])
    out["lines"] = sorted({d["line"] for d in devs})
    return out


def _epoch(v):
    from datetime import datetime
    return datetime.fromisoformat(v).timestamp() if isinstance(v, str) else v.timestamp()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["schema", "query"])
    ap.add_argument("--sql")
    a = ap.parse_args()
    try:
        c = tdlib.connect()
        if a.cmd == "schema":
            res = schema(c)
        else:
            cols, rs = tdlib.rows(c, a.sql or "")
            res = {"columns": cols, "rows": rs, "row_count": len(rs)}
    except ValueError as e:
        res = {"error": str(e)}
    except Exception as e:  # taos errors carry a code and message
        res = {"error": f"{e.__class__.__name__}: {str(e)[:300]}"}
    print(json.dumps(res, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
