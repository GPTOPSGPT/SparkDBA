#!/usr/bin/env python3
"""Rank root-cause hypotheses from a pg-evidence-snapshot JSON.

Usage:
    snapshot.py | classify.py            # or: classify.py evidence.json

Prints JSON: {"hypotheses": [{"category", "confidence", "evidence": [...], "actions": [...]}, ...]}
Categories: lock_contention, idle_in_transaction, table_bloat, connection_storm,
            missing_index, healthy.

These are the discriminators an experienced DBA uses; the ones that keep look-alike
faults apart are commented. The agent still writes the conclusion — this ranks.
"""
import json
import sys


def _waits(ev):
    return ev.get("wait_samples", {}).get("counts", {})


def lock_contention(ev):
    w = _waits(ev)
    rel = w.get("Lock/relation", 0)
    ax = [l for l in ev.get("blocker_locks", [])
          if l.get("locktype") == "relation" and l.get("mode") == "AccessExclusiveLock"]
    waiters = [b for b in ev.get("blocking", []) if b.get("wait_event") == "relation"]
    score, why = 0.0, []
    if rel:
        score += 0.45; why.append(f"wait samples Lock/relation={rel}")
    if ax:
        score += 0.4; why.append(f"blocker pid {ax[0]['pid']} holds AccessExclusiveLock on {ax[0].get('relname')}")
    if waiters:
        score += 0.15; why.append(f"{len(waiters)} sessions waiting on a relation lock")
    return score, why, ["find_blocker", "terminate_blocker"]


def idle_in_transaction(ev):
    # Holder is NOT active, so active-session sampling never sees it. The tell is a blocker
    # whose state is 'idle in transaction' and waiters on transactionid/tuple (row locks).
    v, w = ev.get("vitals", {}), _waits(ev)
    idle_holders = [b for b in ev.get("blocking", [])
                    if (b.get("state") or "").startswith("idle in transaction") and not b.get("blocked_by")]
    row = w.get("Lock/transactionid", 0) + w.get("Lock/tuple", 0)
    score, why = 0.0, []
    if idle_holders:
        h = idle_holders[0]
        score += 0.5; why.append(f"blocker pid {h['pid']} is idle in transaction for {h.get('state_age_sec')}s")
    if row:
        score += 0.35; why.append(f"wait samples Lock/transactionid+tuple={row}")
    if v.get("max_idle_in_txn_sec", 0) >= 30:
        score += 0.15; why.append(f"max idle-in-transaction age {v['max_idle_in_txn_sec']}s")
    return score, why, ["terminate_blocker", "set_idle_tx_timeout"]


def table_bloat(ev):
    # No wait event and no blocking: only dead-tuple ratio shows it.
    top = next((t for t in ev.get("dead_tuples", []) if (t.get("dead") or 0) >= 10000), None)
    score, why = 0.0, []
    if top and (top.get("dead_pct") or 0) >= 50:
        score += 0.75; why.append(f"{top['table']} dead tuples {top['dead']} ({top['dead_pct']}%)")
        if "autovacuum_enabled=false" in (top.get("reloptions") or ""):
            score += 0.2; why.append(f"{top['table']} has autovacuum_enabled=false")
        elif not top.get("last_autovacuum"):
            score += 0.1; why.append(f"{top['table']} never autovacuumed")
    return score, why, ["vacuum_analyze", "vacuum_full"]


def connection_storm(ev):
    # Many connections but few doing work: the fingerprint of no connection pool,
    # unlike real high concurrency where connections are busy.
    v = ev.get("vitals", {})
    n, idle, mx = v.get("connections", 0), v.get("idle", 0), v.get("max_connections", 100)
    score, why = 0.0, []
    if n >= max(40, 0.25 * mx) and idle / max(n, 1) >= 0.8:
        score += 0.8; why.append(f"{n} connections, {idle} idle ({round(100 * idle / n)}%), max_connections={mx}")
        apps = [a for a in ev.get("connections_by_app", []) if a.get("state") == "idle"]
        if apps and apps[0]["n"] >= 0.6 * idle:
            score += 0.15; why.append(f"app '{apps[0]['app']}' owns {apps[0]['n']} idle connections")
    return score, why, ["connection_pool_advice"]


def missing_index(ev):
    dead = {t["table"]: t.get("dead_pct") or 0 for t in ev.get("dead_tuples", [])}
    score, why = 0.0, []
    for t in ev.get("seq_scans", []):
        # Bloated tables also get scanned; don't call that a missing index.
        if dead.get(t["table"], 0) >= 20:
            continue
        if (t.get("seq_scan") or 0) >= 20 and (t.get("avg_rows_per_seq_scan") or 0) >= 100000 \
                and (t.get("seq_scan") or 0) > (t.get("idx_scan") or 0):
            score += 0.6
            why.append(f"{t['table']}: {t['seq_scan']} seq scans x ~{t['avg_rows_per_seq_scan']} rows, "
                       f"idx_scan={t['idx_scan']}")
            slow = [s for s in ev.get("top_statements", []) if (s.get("mean_ms") or 0) >= 20
                    and t["table"].split(".")[-1] in (s.get("query") or "")]
            if slow:
                score += 0.3; why.append(f"hot statement mean {slow[0]['mean_ms']} ms: {slow[0]['query'][:90]}")
            break
    return score, why, ["explain_hot_query", "create_index"]


RULES = [lock_contention, idle_in_transaction, table_bloat, connection_storm, missing_index]


def classify(ev: dict) -> dict:
    hyps = []
    for rule in RULES:
        s, why, actions = rule(ev)
        if s > 0:
            hyps.append({"category": rule.__name__, "confidence": round(min(s, 1.0), 2),
                         "evidence": why, "actions": actions})
    hyps.sort(key=lambda h: -h["confidence"])
    if not hyps or hyps[0]["confidence"] < 0.4:
        v = ev.get("vitals", {})
        hyps.insert(0, {"category": "healthy", "confidence": 0.7 if not hyps else 0.5,
                        "evidence": [f"{v.get('active', 0)} active sessions, no blocking chain, "
                                     f"no table over 50% dead tuples, no pool-less idle pile-up"],
                        "actions": []})
    return {"hypotheses": hyps}


def main():
    src = open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin
    print(json.dumps(classify(json.load(src)), ensure_ascii=False))


if __name__ == "__main__":
    main()
