#!/usr/bin/env python3
"""PostgreSQL workload repository: the KWR / KSH / KDDM trio, rebuilt on stock PostgreSQL 16.

  KWR  (Kingbase Workload Repository)   -> PWR: counter snapshots + interval report + DIFF
  KSH  (Kingbase Session History)       -> PSH: 1-second pg_stat_activity samples, 7-dimension slicing
  KDDM (Kingbase Diagnostic Monitor)    -> PDDM: Top-5 threshold judgment + ordered advice

Usage:
  pwr.py setup                                   # create schema repo (writer role)
  pwr.py sample [--every 1] [--keep-min 180] [--snap-every 600]   # PSH sampler + scheduled snapshots
  pwr.py snapshot                                # take a PWR snapshot now
  pwr.py list [--n 20]                           # recent snapshots
  pwr.py report --from S1 --to S2                # PWR interval report (deltas between two snapshots)
  pwr.py diff --a S1,S2 --b S3,S4                # PWR DIFF: interval A vs interval B
  pwr.py ash --minutes 10 [--ago 0] [--by wait|query|app|user|client|db|backend|session]
  pwr.py top5 --minutes 10 [--ago 0]             # PDDM: Top-5 judgment + advice

Writes (setup/sample/snapshot) use SPARKDBA_REPO_DSN; reads use SPARKDBA_RO_DSN.
Everything prints JSON.
"""
import argparse
import json
import os
import sys
import time
from decimal import Decimal

import psycopg
from psycopg.rows import dict_row

DDL = """
create schema if not exists repo;
create table if not exists repo.snapshots(snap_id serial primary key, taken_at timestamptz not null default now());
create table if not exists repo.snap_db(snap_id int references repo.snapshots on delete cascade, datname text,
  xact_commit bigint, xact_rollback bigint, blks_read bigint, blks_hit bigint, tup_returned bigint,
  tup_fetched bigint, tup_inserted bigint, tup_updated bigint, tup_deleted bigint, temp_bytes bigint,
  deadlocks bigint, numbackends int);
create table if not exists repo.snap_stmt(snap_id int references repo.snapshots on delete cascade, queryid bigint,
  query text, calls bigint, total_exec_time double precision, rows bigint, shared_blks_hit bigint,
  shared_blks_read bigint, temp_blks_written bigint);
create table if not exists repo.snap_table(snap_id int references repo.snapshots on delete cascade, relname text,
  seq_scan bigint, seq_tup_read bigint, idx_scan bigint, n_tup_upd bigint, n_live_tup bigint, n_dead_tup bigint);
create table if not exists repo.session_history(sample_time timestamptz not null, pid int, datname text,
  usename text, application_name text, client_addr text, backend_type text, state text,
  wait_event_type text, wait_event text, queryid bigint, query text);
create index if not exists session_history_time on repo.session_history(sample_time);
"""

SELF = "coalesce(application_name,'') not like 'sparkdba%'"


def _conn(var, **kw):
    dsn = os.environ.get(var)
    if not dsn:
        print(json.dumps({"error": f"{var} not set"})); sys.exit(2)
    return psycopg.connect(dsn, row_factory=dict_row, autocommit=True, application_name="sparkdba-pwr", **kw)


def _j(rows):
    def c(v):
        if isinstance(v, Decimal):
            return float(v)
        return v.isoformat() if hasattr(v, "isoformat") else v
    return [{k: c(v) for k, v in r.items()} for r in rows]


def setup(_):
    with _conn("SPARKDBA_REPO_DSN") as c:
        c.execute(DDL)
    return {"ok": True}


def sample(a):
    """PSH: one row per active or idle-in-transaction session per second (the KSH idea)."""
    with _conn("SPARKDBA_REPO_DSN") as c:
        last_purge = last_snap = 0
        while True:
            if time.time() - last_snap > a.snap_every:      # scheduled PWR snapshot, like KWR's interval
                snapshot(a)
                last_snap = time.time()
            c.execute(f"""insert into repo.session_history
                select now(), pid, datname, usename, application_name, client_addr::text, backend_type, state,
                       wait_event_type, wait_event, query_id, left(query, 300)
                from pg_stat_activity
                where pid <> pg_backend_pid() and {SELF}
                  and (state = 'active' or state like 'idle in transaction%')""")
            if time.time() - last_purge > 60:
                c.execute("delete from repo.session_history where sample_time < now() - make_interval(mins => %s)",
                          (a.keep_min,))
                last_purge = time.time()
            time.sleep(a.every)


def snapshot(_):
    """PWR: archive cumulative counters; two snapshots make an interval report (the KWR idea)."""
    with _conn("SPARKDBA_REPO_DSN") as c:
        sid = c.execute("insert into repo.snapshots default values returning snap_id").fetchone()["snap_id"]
        c.execute("""insert into repo.snap_db select %s, datname, xact_commit, xact_rollback, blks_read, blks_hit,
              tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, temp_bytes, deadlocks, numbackends
              from pg_stat_database where datname is not null""", (sid,))
        c.execute("""insert into repo.snap_stmt select %s, queryid, left(query,300), calls, total_exec_time, rows,
              shared_blks_hit, shared_blks_read, temp_blks_written from pg_stat_statements
              where query not ilike '%%pg_stat%%' and query not ilike '%%repo.%%'""", (sid,))
        c.execute("""insert into repo.snap_table select %s, schemaname||'.'||relname, seq_scan, seq_tup_read,
              coalesce(idx_scan,0), n_tup_upd, n_live_tup, n_dead_tup from pg_stat_user_tables
              where schemaname <> 'repo'""", (sid,))
        c.execute("delete from repo.snapshots where taken_at < now() - interval '7 days'")
    return {"ok": True, "snap_id": sid}


def list_snaps(a):
    with _conn("SPARKDBA_RO_DSN") as c:
        return _j(c.execute("select snap_id, taken_at from repo.snapshots order by snap_id desc limit %s",
                            (a.n,)).fetchall())


def _d(new, old):
    """Counter delta; a negative delta means stats were reset in between, so the new value is the delta."""
    if old is None:
        return new
    return new - old if new >= old else new


def _interval(c, s1, s2):
    t = c.execute("select snap_id, taken_at from repo.snapshots where snap_id in (%s,%s) order by snap_id",
                  (s1, s2)).fetchall()
    if len(t) != 2:
        return {"error": f"snapshots {s1},{s2} not found"}
    secs = (t[1]["taken_at"] - t[0]["taken_at"]).total_seconds() or 1
    db = {}
    for r in c.execute("""select b.datname, b.xact_commit bc, a.xact_commit ac, b.xact_rollback br, a.xact_rollback ar,
            b.blks_read bread, a.blks_read aread, b.blks_hit bhit, a.blks_hit ahit, b.tup_updated bu, a.tup_updated au,
            b.temp_bytes bt, a.temp_bytes at, b.deadlocks bd, a.deadlocks ad
            from repo.snap_db b left join repo.snap_db a on a.datname=b.datname and a.snap_id=%s
            where b.snap_id=%s""", (s1, s2)).fetchall():
        read, hit = _d(r["bread"], r["aread"]), _d(r["bhit"], r["ahit"])
        db[r["datname"]] = {"commits_per_sec": round(_d(r["bc"], r["ac"]) / secs, 1),
                            "rollbacks": _d(r["br"], r["ar"]), "rows_updated": _d(r["bu"], r["au"]),
                            "buffer_hit_pct": round(100 * hit / (hit + read), 2) if hit + read else None,
                            "temp_bytes": _d(r["bt"], r["at"]), "deadlocks": _d(r["bd"], r["ad"])}
    stmts = []
    for r in c.execute("""select b.queryid, b.query, b.calls bc, a.calls ac, b.total_exec_time bt, a.total_exec_time at,
            b.shared_blks_read br, a.shared_blks_read ar
            from repo.snap_stmt b left join repo.snap_stmt a on a.queryid=b.queryid and a.snap_id=%s
            where b.snap_id=%s""", (s1, s2)).fetchall():
        calls = _d(r["bc"], r["ac"])
        if calls <= 0:
            continue
        ms = _d(r["bt"], r["at"])
        stmts.append({"queryid": r["queryid"], "calls": calls, "total_ms": round(ms, 1),
                      "mean_ms": round(ms / calls, 2), "blks_read": _d(r["br"], r["ar"]), "query": r["query"][:160]})
    stmts.sort(key=lambda x: -x["total_ms"])
    tables = []
    for r in c.execute("""select b.relname, b.seq_scan bs, a.seq_scan as_, b.seq_tup_read bst, a.seq_tup_read ast,
            b.idx_scan bi, a.idx_scan ai, b.n_dead_tup dead, b.n_live_tup live
            from repo.snap_table b left join repo.snap_table a on a.relname=b.relname and a.snap_id=%s
            where b.snap_id=%s""", (s1, s2)).fetchall():
        seq, idx = _d(r["bs"], r["as_"]), _d(r["bi"], r["ai"])
        if seq or idx:
            tables.append({"table": r["relname"], "seq_scan": seq, "seq_tup_read": _d(r["bst"], r["ast"]),
                           "idx_scan": idx, "index_scan_pct": round(100 * idx / (seq + idx), 1),
                           "dead_tup": r["dead"], "live_tup": r["live"]})
    tables.sort(key=lambda x: -x["seq_tup_read"])
    return {"from": t[0]["taken_at"].isoformat(), "to": t[1]["taken_at"].isoformat(), "seconds": int(secs),
            "databases": db, "top_statements": stmts[:8], "tables": tables[:8]}


def report(a):
    with _conn("SPARKDBA_RO_DSN") as c:
        return _interval(c, a.from_, a.to)


def diff(a):
    """PWR DIFF: is it more work (load grew) or slower work (efficiency dropped)?"""
    (a1, a2), (b1, b2) = [map(int, x.split(",")) for x in (a.a, a.b)]
    with _conn("SPARKDBA_RO_DSN") as c:
        A, B = _interval(c, a1, a2), _interval(c, b1, b2)
    if "error" in A or "error" in B:
        return {"error": A.get("error") or B.get("error")}
    out = {"A": {"from": A["from"], "to": A["to"]}, "B": {"from": B["from"], "to": B["to"]}, "databases": {}, "statements": []}
    for db in B["databases"]:
        x, y = A["databases"].get(db, {}), B["databases"][db]
        out["databases"][db] = {k: {"A": x.get(k), "B": y[k]} for k in y}
    am = {s["queryid"]: s for s in A["top_statements"]}
    for s in B["top_statements"]:
        p = am.get(s["queryid"])
        out["statements"].append({"query": s["query"], "calls": {"A": p and p["calls"], "B": s["calls"]},
                                  "mean_ms": {"A": p and p["mean_ms"], "B": s["mean_ms"]},
                                  "verdict": ("new in B" if not p else "slower" if s["mean_ms"] > 2 * p["mean_ms"]
                                              else "more calls" if s["calls"] > 2 * p["calls"] else "similar")})
    return out


DIMS = {"wait": "coalesce(wait_event_type,'CPU')||'/'||coalesce(wait_event,'running')", "query": "left(query,120)",
        "app": "application_name", "user": "usename", "client": "coalesce(client_addr,'local')", "db": "datname",
        "backend": "backend_type", "session": "pid::text||' '||coalesce(state,'')"}


def ash(a):
    """PSH slice: average active sessions over a past window, by one of 7 dimensions (+ wait)."""
    col = DIMS.get(a.by)
    if not col:
        return {"error": f"--by must be one of {sorted(DIMS)}"}
    with _conn("SPARKDBA_RO_DSN") as c:
        w = c.execute("""select min(sample_time) t0, max(sample_time) t1, count(distinct sample_time) n
            from repo.session_history where sample_time between now()-make_interval(mins=>%s+%s) and now()-make_interval(mins=>%s)""",
                      (a.minutes, a.ago, a.ago)).fetchone()
        if not w["n"]:
            return {"window": None, "note": "no samples in this window (is the sampler running?)"}
        rows = c.execute(f"""select {col} as key, count(*) as samples, round(count(*)::numeric/%s, 2) as aas,
            count(*) filter (where state like 'idle in transaction%%') as idle_in_tx_samples
            from repo.session_history where sample_time between %s and %s
            group by 1 order by 2 desc limit 10""", (w["n"], w["t0"], w["t1"])).fetchall()
    return {"window": {"from": w["t0"].isoformat(), "to": w["t1"].isoformat(), "samples": w["n"]},
            "by": a.by, "rows": _j(rows)}


# PDDM Top-5, same five checks and thresholds as the kb2026 KDDM judgment (Pareto: ~80% of common bottlenecks).
def top5(a):
    with _conn("SPARKDBA_RO_DSN") as c:
        hit = c.execute("""select round(100.0*sum(blks_hit)/nullif(sum(blks_hit)+sum(blks_read),0),2) v
                           from pg_stat_database""").fetchone()["v"]
        win = c.execute("""select count(distinct sample_time) n,
              count(*) filter (where wait_event_type='Lock') lock_s,
              count(*) filter (where wait_event_type='IO') io_s,
              count(*) filter (where state like 'idle in transaction%%') idle_s,
              count(*) filter (where state='active') act_s
            from repo.session_history where sample_time between now()-make_interval(mins=>%s+%s) and now()-make_interval(mins=>%s)""",
                        (a.minutes, a.ago, a.ago)).fetchone()
        idx = c.execute("""select round(100.0*sum(coalesce(idx_scan,0))/nullif(sum(coalesce(idx_scan,0))+sum(seq_scan),0),1) v
                           from pg_stat_user_tables where schemaname<>'repo' and n_live_tup > 10000""").fetchone()["v"]
    act = max(win["act_s"] or 0, 1)
    checks = [
        ("buffer_hit_pct", float(hit or 0), ">=", 98, "Buffer cache hit ratio", "raise shared_buffers or find the scan that floods the cache"),
        ("lock_wait_pct", round(100 * win["lock_s"] / act, 1), "<", 5, "Share of active samples waiting on Lock", "find the blocker (pg-root-cause); set lock_timeout on DDL"),
        ("io_wait_pct", round(100 * win["io_s"] / act, 1), "<", 15, "Share of active samples waiting on IO", "look for seq scans on large tables; check storage latency"),
        ("idle_in_tx_samples", int(win["idle_s"] or 0), "==", 0, "Samples of sessions idle in transaction", "fix missing commit in the app; set idle_in_transaction_session_timeout"),
        ("index_scan_pct", float(idx or 100), ">=", 80, "Index scans / all scans on tables >10k rows", "EXPLAIN the hot statement; create the missing index concurrently"),
    ]
    res = []
    for key, v, op, th, what, advice in checks:
        ok = {">=": v >= th, "<": v < th, "==": v == th}[op]
        res.append({"check": key, "value": v, "threshold": f"{op} {th}", "status": "ok" if ok else "warn",
                    "what": what, **({} if ok else {"advice": advice})})
    return {"window_minutes": a.minutes, "ago_minutes": a.ago, "samples": win["n"],
            "checks": res, "warnings": [r["check"] for r in res if r["status"] != "ok"]}


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("setup"); sp.add_parser("snapshot")
    s = sp.add_parser("sample"); s.add_argument("--every", type=float, default=1.0); s.add_argument("--keep-min", type=int, default=180); s.add_argument("--snap-every", type=int, default=600)
    s = sp.add_parser("list"); s.add_argument("--n", type=int, default=20)
    s = sp.add_parser("report"); s.add_argument("--from", dest="from_", type=int, required=True); s.add_argument("--to", type=int, required=True)
    s = sp.add_parser("diff"); s.add_argument("--a", required=True); s.add_argument("--b", required=True)
    for name in ("ash", "top5"):
        s = sp.add_parser(name); s.add_argument("--minutes", type=int, default=10); s.add_argument("--ago", type=int, default=0)
        if name == "ash":
            s.add_argument("--by", default="wait")
    a = ap.parse_args()
    fn = {"setup": setup, "sample": sample, "snapshot": snapshot, "list": list_snaps, "report": report,
          "diff": diff, "ash": ash, "top5": top5}[a.cmd]
    try:
        out = fn(a)
    except psycopg.Error as e:
        out = {"error": f"{e.__class__.__name__}: {str(e).strip()[:300]}"}
    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
