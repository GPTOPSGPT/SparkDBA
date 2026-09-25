#!/usr/bin/env python3
"""Tiered, guarded PostgreSQL remediation (ported from the kb2026 auto_exec tiers).

Usage:
    remediate.py catalog
    remediate.py preview  <action> [--table T] [--pid P]
    remediate.py execute  <action> [--table T] [--pid P] [--confirm TOKEN]

Tiers:
  A  runs directly, then journaled (reversible, cheap: ANALYZE / plain VACUUM / EXPLAIN)
  B  needs --confirm yes after a preview (terminate an idle-in-transaction blocker,
     CREATE INDEX CONCURRENTLY, set idle_in_transaction_session_timeout)
  C  irreversible or disruptive; --confirm must repeat the exact target (the pid or table)
     after reading the impact (VACUUM FULL, terminate an ACTIVE session)

Anything not in the catalog is refused. There is no free-form SQL entry point.
Connection: SPARKDBA_OPS_DSN (pg_monitor + pg_signal_backend + member of the table owner).
"""
import argparse
import json
import os
import re
import sys
import time

import psycopg

IDENT = re.compile(r"^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$")
JOURNAL = os.environ.get("SPARKDBA_JOURNAL", "/opt/sparkdba/data/remediation.jsonl")

CATALOG = {
    "find_blocker": {"tier": "A", "needs": [], "what": "List blocking chains (read-only)."},
    "explain_hot_query": {"tier": "A", "needs": [], "what": "EXPLAIN the top statement (no ANALYZE)."},
    "vacuum_analyze": {"tier": "A", "needs": ["table"], "what": "VACUUM (ANALYZE) one table; non-blocking."},
    "connection_pool_advice": {"tier": "A", "needs": [], "what": "Report idle connections per app; no change."},
    "terminate_blocker": {"tier": "B", "needs": ["pid"],
                          "what": "pg_terminate_backend(pid) for a blocker that is idle in transaction; "
                                  "its open transaction rolls back."},
    "create_index": {"tier": "B", "needs": ["table", "column"],
                     "what": "CREATE INDEX CONCURRENTLY on table(column); no table lock."},
    "set_idle_tx_timeout": {"tier": "B", "needs": [],
                            "what": "ALTER SYSTEM idle_in_transaction_session_timeout='5min' + reload."},
    "vacuum_full": {"tier": "C", "needs": ["table"],
                    "what": "VACUUM FULL rewrites the table under ACCESS EXCLUSIVE; blocks all access."},
    "terminate_active": {"tier": "C", "needs": ["pid"],
                         "what": "pg_terminate_backend(pid) for an ACTIVE session; its work is lost."},
}


def _conn():
    return psycopg.connect(os.environ["SPARKDBA_OPS_DSN"], application_name="sparkdba-remediate",
                           autocommit=True)


def _check_args(action, a):
    need = CATALOG[action]["needs"]
    if "table" in need and not (a.table and IDENT.match(a.table)):
        return "table must be a plain identifier like public.events"
    if "column" in need and not (a.column and IDENT.match(a.column) and "." not in a.column):
        return "column must be a plain identifier"
    if "pid" in need and not (a.pid and a.pid.isdigit()):
        return "pid must be an integer"
    return None


def _session(c, pid):
    return c.execute("select pid, state, application_name, left(query,120), "
                     "extract(epoch from now()-xact_start)::int from pg_stat_activity where pid=%s",
                     (int(pid),)).fetchone()


def preview(action, a):
    with _conn() as c:
        if action in ("terminate_blocker", "terminate_active"):
            s = _session(c, a.pid)
            if not s:
                return {"ok": False, "error": f"pid {a.pid} not found"}
            if s[2] and s[2].startswith("sparkdba"):
                return {"ok": False, "error": "refusing to terminate the agent's own sessions"}
            idle_tx = (s[1] or "").startswith("idle in transaction")
            if action == "terminate_blocker" and not idle_tx:
                return {"ok": False, "error": f"pid {a.pid} is '{s[1]}', not idle in transaction; "
                                               f"terminating an active session is tier C (terminate_active)"}
            return {"ok": True, "impact": f"pid {s[0]} ({s[2]}, {s[1]}, xact {s[4]}s) will be disconnected; "
                                          f"uncommitted work rolls back. Query: {s[3]}"}
        if action in ("vacuum_full", "vacuum_analyze"):
            r = c.execute("select pg_size_pretty(pg_total_relation_size(%s::regclass)), n_dead_tup "
                          "from pg_stat_user_tables where relid=%s::regclass", (a.table, a.table)).fetchone()
            lock = "ACCESS EXCLUSIVE for the whole rewrite" if action == "vacuum_full" else "SHARE UPDATE EXCLUSIVE (reads/writes continue)"
            return {"ok": True, "impact": f"{a.table}: size {r[0] if r else '?'}, dead tuples {r[1] if r else '?'}; lock: {lock}"}
        if action == "create_index":
            return {"ok": True, "impact": f"CREATE INDEX CONCURRENTLY on {a.table}({a.column}); "
                                          f"no write lock, takes longer, extra disk"}
        if action == "set_idle_tx_timeout":
            cur = c.execute("show idle_in_transaction_session_timeout").fetchone()[0]
            return {"ok": True, "impact": f"idle_in_transaction_session_timeout {cur} -> 5min, cluster-wide"}
    return {"ok": True, "impact": CATALOG[action]["what"]}


def execute(action, a):
    tier = CATALOG[action]["tier"]
    pv = preview(action, a)
    if not pv.get("ok"):
        return pv
    target = a.pid or a.table or action
    if tier == "B" and a.confirm != "yes":
        return {"ok": False, "needs_confirm": "yes", "tier": tier, "impact": pv["impact"]}
    if tier == "C" and a.confirm != str(target):
        return {"ok": False, "needs_confirm": str(target), "tier": tier, "impact": pv["impact"],
                "note": "tier C: repeat the exact target to confirm"}
    with _conn() as c:
        if action == "find_blocker":
            out = c.execute("select pid, state, pg_blocking_pids(pid) from pg_stat_activity "
                            "where cardinality(pg_blocking_pids(pid))>0").fetchall()
        elif action == "explain_hot_query":
            q = c.execute("select query from pg_stat_statements where query ilike 'select%%' "
                          "and query not ilike '%%pg_%%' order by total_exec_time desc limit 1").fetchone()
            out = "no statement" if not q else "\n".join(
                r[0] for r in c.execute("explain " + q[0].replace("$1", "1")).fetchall())
        elif action == "connection_pool_advice":
            out = c.execute("select application_name, state, count(*) from pg_stat_activity "
                            "group by 1,2 order by 3 desc limit 8").fetchall()
        elif action == "vacuum_analyze":
            c.execute(f"vacuum (analyze) {a.table}"); out = "done"
        elif action == "vacuum_full":
            c.execute(f"vacuum full {a.table}"); out = "done"
        elif action in ("terminate_blocker", "terminate_active"):
            out = c.execute("select pg_terminate_backend(%s)", (int(a.pid),)).fetchone()[0]
        elif action == "create_index":
            name = f"{a.table.split('.')[-1]}_{a.column}_idx"
            c.execute(f"create index concurrently if not exists {name} on {a.table}({a.column})"); out = name
        elif action == "set_idle_tx_timeout":
            c.execute("alter system set idle_in_transaction_session_timeout = '5min'")
            c.execute("select pg_reload_conf()"); out = "5min"
    entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "action": action, "tier": tier,
             "target": target, "impact": pv["impact"], "result": str(out)[:500]}
    try:
        os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
        with open(JOURNAL, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return {"ok": True, **entry}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["catalog", "preview", "execute"])
    ap.add_argument("action", nargs="?")
    ap.add_argument("--table"); ap.add_argument("--column"); ap.add_argument("--pid")
    ap.add_argument("--confirm")
    a = ap.parse_args()
    if a.cmd == "catalog":
        print(json.dumps(CATALOG, ensure_ascii=False)); return
    if a.action not in CATALOG:
        print(json.dumps({"ok": False, "refused": True,
                          "error": f"'{a.action}' is not in the remediation catalog; free-form changes are refused"}))
        sys.exit(1)
    bad = _check_args(a.action, a)
    if bad:
        print(json.dumps({"ok": False, "error": bad})); sys.exit(1)
    try:
        res = preview(a.action, a) if a.cmd == "preview" else execute(a.action, a)
    except psycopg.Error as e:
        res = {"ok": False, "error": f"{e.__class__.__name__}: {str(e).strip()[:300]}"}
    print(json.dumps(res, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
