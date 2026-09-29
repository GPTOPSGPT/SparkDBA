# SparkDBA

A diagnosis agent for data systems (PostgreSQL and TDengine plant telemetry) that runs entirely on one **NVIDIA DGX Spark**. Team GPTOPS's entry for the 3rd NVIDIA DGX Spark Hackathon.

It injects real faults into a live PostgreSQL 16 and a simulated plant writing into TDengine, then an agent built from nine **Agent Skills** collects evidence, names the root cause with cited numbers, and proposes fixes behind A/B/C approval tiers. The model (NVIDIA Nemotron 3.5 Lightning, NVFP4, served by vLLM), the database, the evaluation and the web UI all run on the Spark. Database telemetry never leaves the machine.

The business logic is ported from our KingbaseES diagnosis agent: the fault injector, wait-event screening, KWR/KSH/KDDM reports, the auto-exec tiers and the command guard. KingbaseES is PostgreSQL-derived, so `sys_*` views map to `pg_*`.

## 中文说明

> 第三届 NVIDIA DGX Spark Hackathon · 团队 GPTOPS（张成宇、史钱龙、齐冬娜）
> 完整报告书：[docs/REPORT.md](docs/REPORT.md) · 参赛征文：[docs/ESSAY.md](docs/ESSAY.md) · 演示视频：[B 站](https://www.bilibili.com/video/BV1gMaH6FEYR/) · [release v1.0-hackathon](https://github.com/GPTOPSGPT/SparkDBA/releases/tag/v1.0-hackathon)

### 作品特点与核心亮点

SparkDBA 是一个面向数据系统的诊断智能体：向 PostgreSQL 16 和 TDengine 工厂遥测注入真实故障，由 9 个 Agent Skills 驱动的智能体取证、给出带引用数字的根因，并按 A/B/C 三档审批提出处置。**模型、数据库、评测和网页全部运行在一台 DGX Spark 上，数据不出机房。**

- **可证明的提升**：同一模型、同一任务、同样工具，只差是否加载技能；标准答案就是注入的故障。最终批次 138 次运行：PostgreSQL 根因准确率 33.3% → **95.8%**，工业时序（设备 + 故障都对）16.7% → **100%**，负向用例两边都是 100%，平均工具步数 12 → 7。
- **故障结束后仍能复盘**：把金仓的 KWR / KSH / KDDM 重建为原生 PostgreSQL 上的 PWR（计数器快照）、PSH（每秒会话历史，七维切分）、PDDM（Top-5 阈值判定）。
- **两类数据一个智能体**：数据库 4 个技能 + TDengine「1 个连接器 + 4 位顾问」（洞察、实时监控、看板、根因）。
- **安全在服务端**：只读角色 + SQL 白名单；改动只能走 9 个动作的目录，B 档要人说 yes、C 档要人复述目标，智能体自带的确认参数被编排层丢弃。
- **编排框架可切换**：内置 harness（评测用，记录每一步）/ OpenClaw / Hermes Agent，同一套技能三处都能被发现。

### 技术实现方案

1. **故障实验室**（`server/chaos.py`、`server/plant.py`）：6 种数据库故障（锁竞争、长事务未提交、表膨胀、连接堆积、缺失索引、健康对照）与 5 种设备故障（过热、轴承磨损、气压不足、设备离线、传感器卡死），一键注入/停止，会话使用中性应用名，模型读不出答案。
2. **智能体循环**（`server/agent.py`）：先由路由按技能描述挑选技能 → `load_skill` 读取该技能的 `SKILL.md` → `run_skill` 执行其脚本取证 → 模型只负责解读证据、按输出契约作答。无技能基线只有 `run_sql`（只读）和 `request_change`（只记录不执行）。
3. **判定用规则，解读用模型**：是否超标由写死的阈值判定（PDDM Top-5、根因区分规则），模型负责解读和引用证据，避免模型「编数字」。
4. **评测**（`evals/`）：正向 14 题 + 负向 9 题，每题 3 轮 × 2 种模式，结果写入 `evals/results/` 与每个技能的 `BENCHMARK.md`，对应 NVIDIA 技能验证的五个维度（安全、正确、可发现、有效、效率）。

### 架构设计思路

一台 DGX Spark（GB10，121 GB 统一内存）上分四层：**大脑**（vLLM 本地服务 Nemotron，仅监听 127.0.0.1）→ **编排**（内置 harness / OpenClaw / Hermes，技能与模型不变）→ **技能**（9 个目录，脚本直连本地数据库）→ **数据**（PostgreSQL 16 + 会话采样仓库；TDengine 3.4，3 条产线 15 台设备每秒一行）。网页（Vite + React）与 API（FastAPI）经 HTTPS + token 对外，7 个服务由 systemd 托管，不依赖外网。每个智能体的感知 / 规划与推理 / 工具 / 记忆见 [docs/AGENTS.md](docs/AGENTS.md)。

### 优化方案

- **模型推理**（`deploy/vllm.sh`）：选用 30B-A3B 的 MoE 模型（每 token 只激活约 3B 参数）的 **NVFP4** 量化版，发挥 Blackwell 的 FP4；`--moe-backend marlin`、`--kv-cache-dtype fp8` 减少 KV cache 占用、`--enable-prefix-caching` 复用技能说明等固定前缀、`--mamba-backend flashinfer`（Nemotron 为 Mamba-Transformer 混合结构）；实测约 77 token/s。
- **内存预算**：`--gpu-memory-utilization 0.60` 给模型与 KV cache 留约六成统一内存，其余留给 PostgreSQL、TDengine 与应用，一台机器同时装下模型和两个数据库；上下文 64K（`--max-model-len 65536`）。
- **调用参数**：默认关闭思考模式、温度 0.2、`max_tokens` 2048，降低时延与跑偏；Hermes 需显式设置 `model.max_tokens 4096`，否则会把上下文长度当作生成上限导致 400。
- **智能体层**：技能脚本一次性取回固定证据清单，替代模型一条条试 SQL，工具步数从 12 降到 7；技能按需加载，只把相关的 `SKILL.md` 放进上下文。代价如实记录：加载技能说明使每次诊断多约 6 秒、约 9000 token。
- **并发**：服务端允许 2 个诊断同时运行（vLLM 自动合批），「有技能 / 无技能」可以在同一时刻诊断同一个故障，对比更公平，总时长约减半。

### 部署说明

- **如何利用本地算力部署智能体**：vLLM 在 DGX Spark 上本地服务模型（`bash deploy/restart.sh vllm`），应用、采样器、工厂模拟、监控、OpenClaw 各为一个 systemd 单元（`deploy/restart.sh app|sampler|plant|monitor|openclaw`）；安装步骤见下文英文部分「Run it on a DGX Spark」，已按 README 从干净代码全新安装验证（`deploy/check.sh` 6/6 通过，见 [docs/INSTALL-TEST.md](docs/INSTALL-TEST.md)）。
- **如何优化大模型**：见上文「优化方案」——NVFP4 量化、MoE marlin 后端、FP8 KV cache、前缀缓存、内存预算与调用参数。
- **如何设计 Agent Skills**：每个技能是一个目录，按 NVIDIA 规范打包：`SKILL.md`（frontmatter 描述 = 触发条件与负向触发；正文 = 步骤、规则与输出契约）、`scripts/`（确定性取证/执行脚本）、`evals/evals.json`（含「正确答案是不调用该技能」的负向用例）、`BENCHMARK.md`（有/无技能五维实测）、`skill-card.md`（用途、风险、许可）。9 个技能见 `skills/`，OpenClaw（`openclaw skills list --eligible`）与 Hermes Agent 均可发现。

### 技术栈说明

| 类别 | 使用 |
|---|---|
| NVIDIA 硬件与系统 | NVIDIA DGX Spark（GB10 Grace Blackwell，121 GB 统一内存）· DGX OS（Ubuntu 24.04）· NVIDIA 驱动 580 |
| NVIDIA 模型 | **NVIDIA Nemotron-3.5-Lightning 30B-A3B NVFP4**（诊断、路由、解读全部由它完成） |
| NVIDIA 规范与工具 | NVIDIA Agent Skills 打包规范（SKILL.md / evals / BENCHMARK / skill-card）与五维技能验证方法；NVFP4 量化格式 |
| 推理框架 | vLLM 0.28（FlashInfer、Marlin MoE 内核，CUDA 随 vLLM / PyTorch 提供） |
| 编排框架 | 自研 harness（`server/agent.py`）· OpenClaw · Hermes Agent |
| 数据 | PostgreSQL 16（pg_stat_statements）· TDengine 3.4 |
| 应用 | Python 3.12 · FastAPI · Vite + React · ECharts |
| StepFun 阶跃星辰模型 | 未使用（本项目仅使用 NVIDIA Nemotron） |

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

Project report (zh/en): [docs/REPORT.md](docs/REPORT.md). Pitch decks: [zh](docs/deck/SparkDBA-pitch-zh.pdf) · [en](docs/deck/SparkDBA-pitch-en.pdf). Competition essay (zh): [docs/ESSAY.md](docs/ESSAY.md). Demo film: [Bilibili](https://www.bilibili.com/video/BV1gMaH6FEYR/) · [release v1.0-hackathon](https://github.com/GPTOPSGPT/SparkDBA/releases/tag/v1.0-hackathon).

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
