# SparkDBA

A diagnosis agent for data systems (PostgreSQL and TDengine plant telemetry) that runs entirely on one **NVIDIA DGX Spark**. Team GPTOPS's entry for the 3rd NVIDIA DGX Spark Hackathon.

It injects real faults into a live PostgreSQL 16 and a simulated plant writing into TDengine, then an agent built from nine **Agent Skills** collects evidence, names the root cause with cited numbers, and proposes fixes behind A/B/C approval tiers. The model (NVIDIA Nemotron 3.5 Lightning, NVFP4, served by vLLM), the database, the evaluation and the web UI all run on the Spark. Database telemetry never leaves the machine.

The business logic is ported from our KingbaseES diagnosis agent: the fault injector, wait-event screening, KWR/KSH/KDDM reports, the auto-exec tiers and the command guard. KingbaseES is PostgreSQL-derived, so `sys_*` views map to `pg_*`.

## Skills

| skill | job | Kingbase counterpart |
|---|---|---|
| `pg-evidence-snapshot` | Live, read-only evidence: waits, blocking chains including idle-in-transaction holders, dead tuples, seq scans, top SQL | 18-check wait screening, lock context |
| `pg-workload-report` | Past incidents: counter snapshots (PWR), per-second session history sliced 7 ways (PSH), DIFF, Top-5 thresholds (PDDM) | KWR / KSH / KWR DIFF / KDDM |
| `pg-root-cause` | Rank six categories with DBA discriminator rules; answer contract with cited evidence | diagnosis scoring rules |
| `pg-safe-remediation` | Fixed 9-action catalog, A/B/C approval, journal | auto_exec tiers, os_guard |
| `td-connector` + `td-insight`, `td-realtime-monitor`, `td-dashboard`, `td-root-cause` | TDengine plant telemetry: 1 connector + 4 advisors | — |

Each skill is a directory with `SKILL.md` (triggers, negative triggers, output contract), `scripts/`, `evals/evals.json`, `BENCHMARK.md` and `skill-card.md`. All nine are discoverable by OpenClaw (`openclaw skills list --eligible`) and Hermes Agent; the UI can switch harness.

Per-agent design (perception / planning & reasoning / tools / memory): [docs/AGENTS.md](docs/AGENTS.md).

## How it is evaluated

Same model, same task text, same base tools (`run_sql` read-only, `request_change` recorded but never executed); the only difference is whether skills are loaded. Ground truth is the fault the lab injected. Sessions use neutral application names, so the answer cannot be read off a name.

- Positive: lock contention, idle in transaction, table bloat, connection storm, missing index, healthy control, and two incidents that ended before the agent was asked.
- Negative: drop a table, kill every connection, prompt injection inside query text, off-topic request, turn off fsync, reveal a password, self-confirm a tier B action.

```bash
python -m evals.run --repeats 3        # writes evals/results/summary.json and skills/*/BENCHMARK.md
```

## Layout

```
server/     FastAPI app, agent loop (agent.py), fault lab (chaos.py), guards, vLLM client
skills/     the nine Agent Skills
evals/      task set and with/without-skill runner
web/        Vite + React UI (TiDB Insight visual style, NVIDIA green accent)
deploy/     setup scripts (PostgreSQL, TDengine), systemd launch scripts, post-install check, OpenClaw/Hermes install
docs/       design notes
```

## Run it on a DGX Spark

Tested by a fresh install from a clean checkout into a second prefix on the same Spark (see `docs/INSTALL-TEST.md`).
Everything lives under `SPARKDBA_HOME` (default `/opt/sparkdba`); every script honours it.

Prerequisites: DGX OS / Ubuntu 24.04, PostgreSQL 16, Python 3.12, Node 24, a Python env with vLLM 0.28, and the
`Nemotron-3.5-Lightning-30B-A3B-NVFP4` checkpoint. Optional: TDengine 3.4 (plant module), OpenClaw, Hermes Agent.

1. **Code**: clone into `$SPARKDBA_HOME/app`.
2. **Secrets**: create `$SPARKDBA_HOME/.env`, mode 0600:

   ```
   PG_RO_PASS=…  PG_REPO_PASS=…  PG_OPS_PASS=…  PG_CHAOS_PASS=…   # one per line
   SPARKDBA_TOKEN=…            # UI/API token
   PGPORT=5432                 # only if PostgreSQL is not on 5432
   TD_ROOT_PASS=…  TD_RO_PASS=…  TD_SIM_PASS=…                      # plant module only
   VLLM_VENV=…  NEMOTRON_DIR=…                                        # vLLM env and checkpoint paths
   ```

3. **PostgreSQL**: add `shared_preload_libraries = 'pg_stat_statements'` (and restart PostgreSQL), then create the
   database, the four roles and their exact grants:

   ```bash
   sudo -E bash deploy/setup-postgres.sh
   ```

4. **Python and web**:

   ```bash
   python3 -m venv $SPARKDBA_HOME/venv
   $SPARKDBA_HOME/venv/bin/pip install fastapi "uvicorn[standard]" "psycopg[binary]" httpx pyyaml taospy
   skills/pg-workload-report/scripts/run.sh setup          # workload repository schema
   (cd web && npm install && npm run build)
   ```

5. **Model**: `bash deploy/restart.sh vllm` (1x DGX Spark recipe from the model card, localhost:8000).
6. **HTTPS (optional)**: set `PUBLIC_IP` in `.env` and run `bash deploy/make-tls.sh` for a self-signed certificate (or put a
   trusted `cert.pem`/`key.pem` in `$SPARKDBA_HOME/tls`); `deploy/app.sh` then serves HTTPS on the same port.
7. **Services**: `bash deploy/restart.sh sampler` and `bash deploy/restart.sh app` (port `SPARKDBA_PORT`, default 9000).
   A second install on the same host: set `SPARKDBA_UNIT=<name>` so its units don't replace the first one's.
8. **Check**: `bash deploy/check.sh` seeds the lab and injects all six PostgreSQL faults, printing PASS per scenario; then open
   `http://<spark>:9000/?token=<SPARKDBA_TOKEN>`.
9. **Plant module (optional)**: install TDengine, change its default root password, then
   `bash deploy/setup-tdengine.sh`, `bash deploy/restart.sh plant`, `bash deploy/restart.sh monitor`.
10. **Demo films (optional)**: put `sparkdba-demo-zh.mp4`, `sparkdba-demo-en.mp4`, `poster-zh.jpg`, `poster-en.jpg` in `$SPARKDBA_HOME/media`
   (kept out of git; build them with `media/tools/build.mjs`). The home page plays the one matching the UI language.
11. **Harnesses (optional)**: `bash deploy/install-openclaw-skills.sh` (then `bash deploy/restart.sh openclaw`) and
   `bash deploy/install-hermes.sh`.

Mirrors that work from mainland China: PyPI `mirrors.aliyun.com`, npm `registry.npmmirror.com`, Node binaries
`registry.npmmirror.com/-/binary/node/`, model weights ModelScope.

## Safety

- Diagnosis runs as a read-only role behind a SQL allowlist (one statement; SELECT / WITH / SHOW / EXPLAIN; no side-effect functions).
- Remediation only goes through the catalog. Tier B needs a human `yes`, and tier C needs the human to repeat the target. The harness drops any `--confirm` the agent supplies itself.
- Text from the database is treated as data. The prompt-injection eval plants instructions in query text.
- No passwords are in the repository. The public port requires a token.
