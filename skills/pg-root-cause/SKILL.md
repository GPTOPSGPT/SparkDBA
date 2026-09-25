---
name: pg-root-cause
description: "Turn a pg-evidence-snapshot JSON into a ranked PostgreSQL root cause with cited evidence: table-level lock contention, idle-in-transaction row-lock holders, table bloat, connection storms without a pool, missing indexes, or healthy. Use when: a snapshot has been collected and the user wants the cause of slowness, hangs, lock waits or connection exhaustion, 根因, 为什么慢. Not for: collecting evidence (use pg-evidence-snapshot first), executing fixes (use pg-safe-remediation), or non-PostgreSQL questions."
license: Apache-2.0
metadata: { "openclaw": { "emoji": "🧭", "requires": { "bins": ["bash"] } } }
---

# PostgreSQL root cause

## Run

```bash
echo '<snapshot json>' | "$SKILL_DIR/scripts/run.sh"
```

Returns `{"hypotheses":[{"category","confidence","evidence":[...],"actions":[...]}]}`, highest first.
The ranking is a DBA's discriminator rules, not a guess. Read `references/discriminators.md`
when the top two hypotheses are within 0.2 of each other.

## Answer contract (final reply)

```
CATEGORY: <one of lock_contention | idle_in_transaction | table_bloat | connection_storm | missing_index | healthy>
ROOT CAUSE: <one sentence, the mechanism, naming the table / pid / setting>
EVIDENCE:
- <number from the snapshot> ...   (at least two, each traceable to a snapshot key)
RULED OUT: <the closest look-alike and why>
NEXT ACTION: <action id from pg-safe-remediation and its tier>, not executed
```

## Rules

- `CATEGORY` must be one of the six values. If no rule scores ≥ 0.4, the answer is `healthy`;
  do not invent a problem to have something to say.
- Lock contention vs idle in transaction are the classic confusion: decide by *what the waiters wait on*
  (`Lock/relation` + AccessExclusiveLock → lock_contention; `Lock/transactionid|tuple` + holder
  `idle in transaction` → idle_in_transaction).
- Live complaint ("is slow", "time out" in the present tense): the live snapshot is the evidence. If it ranks
  `healthy`, answer `healthy`. Do not reach into history: an older incident in the history window is not this one.
- Past complaint ("minutes ago", "has cleared"): the live snapshot proves nothing; use `pg-workload-report`
  for a window that covers only that incident.
- `idle_in_transaction_session_timeout = 0`, `statement_timeout = 0`, `lock_timeout = 0` mean **disabled** (no limit).
- Do not execute anything from this skill. Recommending is allowed; acting belongs to pg-safe-remediation.
