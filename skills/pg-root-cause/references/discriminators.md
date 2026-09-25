# Discriminators between look-alike PostgreSQL faults

Ported from the kb2026 KES fault knowledge base (KingbaseES is PostgreSQL-derived; `sys_*` views
map to `pg_*`). Each row: what separates the fault from its closest neighbour.

| fault | primary signal | look-alike | how to tell apart |
|---|---|---|---|
| lock_contention | waiters on `Lock/relation`; holder has `AccessExclusiveLock` on a relation | idle_in_transaction | holder usually **active** (DDL, `LOCK TABLE`, long batch); waiters are readers too, not only writers to one row |
| idle_in_transaction | holder `state = idle in transaction`, `max_idle_in_txn_sec` high; waiters on `Lock/transactionid` (first in line) and `Lock/tuple` (the rest) | lock_contention | the holder is **invisible to active-session sampling**: only `pg_blocking_pids` / `pg_stat_activity.state` show it; waiters all write the same row |
| table_bloat | `dead_pct` ≥ 50 % on a table, autovacuum disabled or never run | missing_index | it is not a wait event and not blocking; the scanned table has many dead tuples. A seq scan on a bloated table is bloat, not a missing index |
| connection_storm | connections ≥ 25 % of `max_connections` and ≥ 80 % of them `idle`, mostly one app | real high concurrency | real load has connections **active**; idle piles mean the app opens connections and never returns them (no pool) |
| missing_index | many seq scans reading ≥ 100 k rows each on a table with low dead %, `idx_scan` ≪ `seq_scan`, hot statement with high `mean_ms` filtering on one column | table_bloat | dead % low; `EXPLAIN` of the hot statement shows `Seq Scan` + `Filter` on the lookup column |
| healthy | none of the above; few active sessions, no blocking chain | any | say so. A healthy verdict with evidence is a correct answer, not a failure |

## Wait-event reading (PostgreSQL 16)

- `Lock/relation` — waiting for a table-level lock. Look for DDL, `LOCK TABLE`, `VACUUM FULL`, `REINDEX` holders.
- `Lock/transactionid` — waiting for another transaction to end (row updated by it). Find the holder's state.
- `Lock/tuple` — queued behind the first waiter for the same row.
- `IO/DataFileRead` — reading pages not in shared buffers; with high `seq_tup_read` it points to scans.
- `CPU/running` (no wait event) — on CPU; with seq scans it is scanning in memory.
- `Client/ClientRead` on an `idle in transaction` session — the app holds a transaction open and is not sending the next statement.

## Remediation mapping (by tier)

- lock_contention → `find_blocker` (A), `terminate_active` (C: the holder is active, its work is lost). Prevent with `lock_timeout` on DDL.
- idle_in_transaction → `terminate_blocker` (B), `set_idle_tx_timeout` (B). Fix the app's missing commit.
- table_bloat → `vacuum_analyze` (A) first; `vacuum_full` (C) only when space must be returned and a table-wide lock is acceptable.
- connection_storm → `connection_pool_advice` (A); fix belongs to the app (PgBouncer / pool). Never mass-terminate.
- missing_index → `explain_hot_query` (A), `create_index` (B, CONCURRENTLY).
