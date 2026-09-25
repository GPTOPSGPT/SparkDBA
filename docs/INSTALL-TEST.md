# Fresh-install test

2026-09-25, on the team's DGX Spark (gx10), from a clean checkout of `main` (git bundle, no untracked files),
into a second prefix `SPARKDBA_HOME=/opt/sparkdba-fresh` next to the live install. Separate PostgreSQL cluster
(port 5433, standing in for a fresh server), separate env file, app on port 9100, separate systemd units
(`SPARKDBA_UNIT=sparkdba-fresh`), separate OpenClaw/Hermes homes. Shared on purpose: the running vLLM server
(one model fits the GPU) and the one TDengine instance (read-only for the test; no second telemetry writer).

## Result after fixes

| README step | result |
|---|---|
| 1 clone | ok |
| 2 secrets file | ok (`PGPORT=5433`) |
| 3 `setup-postgres.sh` | ok on a brand-new cluster |
| 4 venv, `run.sh setup`, web build | ok |
| 5 vLLM | not re-run (already serving; the GPU holds one model) |
| 6 sampler + app | ok; live units untouched |
| 7 `check.sh` | **6/6 PASS** (all PostgreSQL faults injected and classified) |
| extra: agent via the fresh API | injected `missing_index` → skills mode answered `missing_index` (8 steps, 15.8 s) |
| 8 `setup-tdengine.sh` + connector | ok (15 devices; connector read 900 rows/min of live telemetry) |
| 9 OpenClaw / Hermes | ok: 9 skills eligible in each |

## What the first attempt found (all fixed in the repo)

1. **Non-default PostgreSQL port unsupported.** Fix: libpq's standard `PGPORT` in the env file (documented).
2. **Grants existed only in shell history.** The README described roles in prose; `sparkdba_repo` lacked CREATE on
   `lab`, the chaos role lacked `pg_stat_reset()` / `pg_stat_statements_reset()`. Fix: `deploy/setup-postgres.sh`,
   idempotent, derived from the live cluster's actual grants.
3. **Latent bug on the live system:** `pg_reload_conf()` was never granted to `sparkdba_ops`, so the
   `set_idle_tx_timeout` remediation would have failed at the reload. The eval never executed that action. Fixed in
   the setup script. The first version also granted function EXECUTE in the wrong database (grants are per database);
   fixed by granting inside `lab`.
4. **`/opt/sparkdba` hard-coded** in 18 scripts and `server/harness.py`. Fix: everything honours `SPARKDBA_HOME`.
5. **`restart.sh` would have replaced the live units** (fixed unit names) and did not pass the environment to
   `systemd-run`, so a second install silently ran the first one's paths. Fix: `SPARKDBA_UNIT`, `-E SPARKDBA_HOME`,
   `SPARKDBA_PORT`.
6. **Post-install check needed undocumented setup** (env loaded, lab tables seeded). Fix: `deploy/check.sh`.
7. **README did not cover the plant module or harnesses.** Fix: `deploy/setup-tdengine.sh`; the OpenClaw install
   script now onboards against the local vLLM when needed; the Hermes script creates its own venv.
8. **Regression caught on the way:** the `SPARKDBA_HOME` patch reused a variable in `install-hermes.sh` and would have
   copied skills from the wrong path. Rewritten and re-run on both installs.

## Not covered

- vLLM installation itself (we used the pre-installed vLLM 0.28 env and checkpoint).
- Installing TDengine, Node, OpenClaw from scratch (mirrors that work are listed in the README).
- A different machine: this was a second prefix on the same Spark.
