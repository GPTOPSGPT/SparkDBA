#!/usr/bin/env python3
"""Read-only PostgreSQL evidence snapshot.

Collects the evidence a DBA looks at first when "the database is slow":
vitals, sampled wait events, blocking chains (including idle-in-transaction
holders that never show up as active), dead tuples, sequential-scan pressure,
top statements and the settings that matter for these faults.

Usage:
    snapshot.py [--samples N] [--interval SEC]      # prints JSON to stdout

Connection comes from SPARKDBA_RO_DSN (libpq DSN). The role must be read-only
(default_transaction_read_only=on, pg_monitor + pg_read_all_data).
"""
import argparse
import json
import os
import sys
import time
from collections import Counter
from decimal import Decimal

import psycopg
from psycopg.rows import dict_row

# Sessions belonging to the agent itself are never evidence.
SELF_FILTER = "pid <> pg_backend_pid() and coalesce(application_name,'') not like 'sparkdba%'"

VITALS = f"""
select
  (select count(*) from pg_stat_activity where backend_type='client backend' and {SELF_FILTER}) as connections,
  current_setting('max_connections')::int as max_connections,
  (select count(*) from pg_stat_activity where state='active' and backend_type='client backend' and {SELF_FILTER}) as active,
  (select count(*) from pg_stat_activity where state='idle' and backend_type='client backend' and {SELF_FILTER}) as idle,
  (select count(*) from pg_stat_activity where state like 'idle in transaction%' and {SELF_FILTER}) as idle_in_transaction,
  (select coalesce(max(extract(epoch from now()-state_change))::int,0)
     from pg_stat_activity where state like 'idle in transaction%' and {SELF_FILTER}) as max_idle_in_txn_sec,
  (select coalesce(max(extract(epoch from now()-xact_start))::int,0)
     from pg_stat_activity where xact_start is not null and {SELF_FILTER}) as longest_xact_sec,
  (select coalesce(max(extract(epoch from now()-query_start))::int,0)
     from pg_stat_activity where state='active' and {SELF_FILTER}) as longest_query_sec,
  (select round(100.0*sum(blks_hit)/nullif(sum(blks_hit)+sum(blks_read),0),2) from pg_stat_database) as cache_hit_pct,
  (select sum(deadlocks) from pg_stat_database) as deadlocks,
  version() as version
"""

WAIT_SAMPLE = f"""
select coalesce(wait_event_type,'CPU') || '/' || coalesce(wait_event,'running') as ev
from pg_stat_activity
where state='active' and backend_type='client backend' and {SELF_FILTER}
"""

BLOCKING = """
select a.pid, a.application_name as app, a.state, a.wait_event_type, a.wait_event,
       pg_blocking_pids(a.pid) as blocked_by,
       extract(epoch from now()-a.xact_start)::int as xact_age_sec,
       extract(epoch from now()-a.state_change)::int as state_age_sec,
       left(a.query, 200) as query
from pg_stat_activity a
where a.pid <> pg_backend_pid() and coalesce(a.application_name,'') not like 'sparkdba%'
  and (cardinality(pg_blocking_pids(a.pid)) > 0
       or a.pid in (select unnest(pg_blocking_pids(b.pid)) from pg_stat_activity b))
order by cardinality(pg_blocking_pids(a.pid)), a.pid
"""

# Lock modes held by the blockers: tells table-level (AccessExclusive on a relation)
# apart from row-level (transactionid) contention.
HELD_LOCKS = """
select l.pid, l.locktype, l.mode, l.granted, c.relname
from pg_locks l left join pg_class c on c.oid = l.relation
where l.pid = any(%s) and l.granted and l.locktype in ('relation','transactionid','tuple')
  and (c.relname is null or c.relname not like 'pg_%%')
order by l.pid
"""

DEAD_TUPLES = """
select t.schemaname||'.'||t.relname as table, greatest(t.n_live_tup, c.reltuples::bigint) as live,
       t.n_dead_tup as dead,
       round(100.0*t.n_dead_tup/nullif(greatest(t.n_live_tup, c.reltuples::bigint)+t.n_dead_tup,0),1) as dead_pct,
       t.last_autovacuum, t.last_vacuum, t.last_autoanalyze,
       coalesce(array_to_string(c.reloptions, ','),'') as reloptions,
       pg_size_pretty(pg_total_relation_size(t.relid)) as size
from pg_stat_user_tables t join pg_class c on c.oid = t.relid
where t.n_dead_tup > 0
order by t.n_dead_tup desc limit 6
"""

SEQ_SCANS = """
select schemaname||'.'||relname as table, seq_scan, seq_tup_read, coalesce(idx_scan,0) as idx_scan,
       greatest(n_live_tup, (select reltuples::bigint from pg_class where oid=relid)) as live,
       (select count(*) from pg_index i where i.indrelid=relid) as index_count,
       case when seq_scan>0 then seq_tup_read/seq_scan else 0 end as avg_rows_per_seq_scan
from pg_stat_user_tables
where seq_scan > 0
order by seq_tup_read desc limit 6
"""

TOP_STATEMENTS = """
select calls, round(total_exec_time::numeric,1) as total_ms, round(mean_exec_time::numeric,2) as mean_ms,
       rows, shared_blks_hit, shared_blks_read, left(regexp_replace(query,'\\s+',' ','g'),200) as query
from pg_stat_statements
where query not ilike '%%pg_stat%%' and query not ilike '%%pg_catalog%%'
  and userid not in (select oid from pg_roles where rolname like 'sparkdba_ro')
order by total_exec_time desc limit 6
"""

APPS = f"""
select coalesce(nullif(application_name,''),'(none)') as app, state, count(*) as n
from pg_stat_activity where backend_type='client backend' and {SELF_FILTER}
group by 1,2 order by n desc limit 12
"""

SETTINGS = """
select name, setting, unit from pg_settings where name in
('max_connections','idle_in_transaction_session_timeout','statement_timeout','lock_timeout',
 'autovacuum','autovacuum_vacuum_scale_factor','work_mem','shared_buffers','random_page_cost')
order by name
"""


def _rows(cur, sql, params=None):
    cur.execute(sql, params)
    def conv(v):
        if isinstance(v, Decimal):
            return float(v)
        return v.isoformat() if hasattr(v, "isoformat") else v
    return [{k: conv(v) for k, v in r.items()} for r in cur.fetchall()]


def collect(dsn: str, samples: int = 10, interval: float = 0.5) -> dict:
    t0 = time.time()
    with psycopg.connect(dsn, row_factory=dict_row, application_name="sparkdba-snapshot",
                         autocommit=True) as conn, conn.cursor() as cur:
        vitals = _rows(cur, VITALS)[0]
        waits = Counter()
        for i in range(samples):
            for r in _rows(cur, WAIT_SAMPLE):
                waits[r["ev"]] += 1
            if i < samples - 1:
                time.sleep(interval)
        blocking = _rows(cur, BLOCKING)
        holders = sorted({p for b in blocking for p in (b["blocked_by"] or [])})
        held = _rows(cur, HELD_LOCKS, (holders,)) if holders else []
        try:
            top = _rows(cur, TOP_STATEMENTS)
        except psycopg.Error:
            top = []
        ev = {
            "vitals": vitals,
            "wait_samples": {"samples": samples, "interval_sec": interval,
                             "counts": dict(waits.most_common(10))},
            "blocking": blocking,
            "blocker_locks": held,
            "dead_tuples": _rows(cur, DEAD_TUPLES),
            "seq_scans": _rows(cur, SEQ_SCANS),
            "top_statements": top,
            "connections_by_app": _rows(cur, APPS),
            "settings": {r["name"]: (r["setting"] + (r["unit"] or "")) for r in _rows(cur, SETTINGS)},
        }
    ev["collect_ms"] = int((time.time() - t0) * 1000)
    return ev


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--samples", type=int, default=10)
    ap.add_argument("--interval", type=float, default=0.5)
    a = ap.parse_args()
    dsn = os.environ.get("SPARKDBA_RO_DSN")
    if not dsn:
        print(json.dumps({"error": "SPARKDBA_RO_DSN not set"}))
        sys.exit(2)
    print(json.dumps(collect(dsn, max(1, min(a.samples, 40)), max(0.1, min(a.interval, 2.0))),
                     ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
