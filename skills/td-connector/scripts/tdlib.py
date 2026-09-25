"""Shared by the TDengine skills: guarded read-only access to database `plant`.

TDengine OSS has no GRANT (Enterprise only), so read-only is enforced here, server-side,
the same way the PostgreSQL read path is guarded.
"""
import os
import re

import taos

_READ_OK = re.compile(r"^\s*(select|show|describe|desc)\b", re.I)
_DENY = re.compile(r"\b(insert|delete|drop|alter|create|grant|revoke|flush|kill|balance|trim|compact|"
                   r"redistribute|merge|split|restore|import|update)\b", re.I)


def check(sql: str):
    s = (sql or "").strip().rstrip(";").strip()
    if not s:
        return "empty statement"
    if ";" in s:
        return "one statement per call"
    if not _READ_OK.match(s):
        return "read path accepts SELECT / SHOW / DESCRIBE only"
    m = _DENY.search(s)
    if m:
        return f"keyword not allowed on the read path: {m.group(1)}"
    return None


def connect():
    return taos.connect(user="sparkdba_ro", password=os.environ.get("TD_RO_PASS", ""), database="plant")


def rows(conn, sql, limit=500):
    """Run a guarded query; returns (columns, rows)."""
    why = check(sql)
    if why:
        raise ValueError(f"blocked: {why}")
    r = conn.query(sql)
    cols = [f.name for f in r.fields]
    out = []
    for row in r:
        out.append([v.isoformat() if hasattr(v, "isoformat") else (v.decode() if isinstance(v, bytes) else v)
                    for v in row])
        if len(out) >= limit:
            break
    return cols, out


def dicts(conn, sql, limit=500):
    cols, rs = rows(conn, sql, limit)
    return [dict(zip(cols, r)) for r in rs]


METRICS = ("temperature", "vibration", "pressure", "current")


def window_stats(conn, window_s: int, baseline_s: int, ago_s: int = 0, trace=None):
    """Per-device stats for the window [now-ago-window, now-ago] and the baseline just before it."""
    agg = ", ".join(f"avg({m}) as {m}, stddev({m}) as {m}_sd" for m in METRICS)
    def q(lo, hi):
        sql = (f"select device_id, line, kind, {agg}, count(*) as n, max(status) as max_status, last(ts) as last_ts "
               f"from sensors where ts > now - {lo}s and ts <= now - {hi}s partition by device_id, line, kind")
        if trace is not None:
            trace.append(sql)
        return {d["device_id"]: d for d in dicts(conn, sql)}
    cur = q(ago_s + window_s, ago_s)
    base = q(ago_s + window_s + baseline_s, ago_s + window_s)
    ysql = lambda lo, hi: (f"select line, sum(good) as good, sum(produced) as produced from output "
                           f"where ts > now - {lo}s and ts <= now - {hi}s partition by line")
    ycur, ybase = ysql(ago_s + window_s, ago_s), ysql(ago_s + window_s + baseline_s, ago_s + window_s)
    if trace is not None:
        trace += [ycur, ybase]
    y = lambda sql: {r["line"]: round(100.0 * r["good"] / r["produced"], 2) if r["produced"] else None
                     for r in dicts(conn, sql)}
    return cur, base, y(ycur), y(ybase)
