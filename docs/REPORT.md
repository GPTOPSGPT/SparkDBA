# SparkDBA 项目报告书 · Project Report

**第三届 NVIDIA DGX Spark Hackathon · 团队 GPTOPS**

> 让数据自己诊断，就在一台 DGX Spark 上。
> *Data that diagnoses itself, on one DGX Spark.*

- 代码 Code: https://github.com/GPTOPSGPT/SparkDBA
- 目录 Contents: [中文](#中文) · [English](#english)

---

## 中文

### 1. 问题

凌晨三点，数据库慢了、产线良品率掉了，值班人员面对三个难题：

1. **告警不等于根因。** 阈值告警只说「慢了」。锁等待、长事务、表膨胀、缺索引的症状彼此相似，要人逐条翻系统视图。
2. **故障会结束。** 很多故障几分钟就自己恢复，等人上线时现场已经没了；没有会话历史，就只剩一句「刚才慢过」。
3. **数据不能出门。** SQL、会话、设备遥测都是企业资产，发给云端大模型在合规上过不去。

### 2. 方案

SparkDBA 是一个面向数据系统的诊断智能体，**模型、数据库、评测和网页全部跑在一台 DGX Spark 上**：

- **两类数据**：业务数据库 PostgreSQL 16；工厂设备遥测 TDengine 3.4（3 条产线、15 台设备、每秒一行）。
- **一个智能体 + 9 个 Agent Skills**：取证、负载报告、根因、分级处置（PostgreSQL 4 个）；1 个连接器 + 4 位顾问（TDengine 5 个）。
- **分工原则**：判定用规则，解读用模型，执行有闸门。是否超标由写死的阈值判，模型负责解读和引用证据，任何改动都要过 A/B/C 三档闸门。
- **业务逻辑来自我们的金仓（KingbaseES）诊断项目**：故障注入器、等待事件筛查、KWR/KSH/KDDM 三件套、自动化分档与命令护栏。金仓源自 PostgreSQL，`sys_*` 视图对应 `pg_*`。

### 3. 架构

| 层 | 组成 |
|---|---|
| 大脑 | NVIDIA Nemotron-3.5-Lightning 30B-A3B，NVFP4 量化，vLLM 本地服务，实测约 77 token/s |
| 编排 | 内置 harness（评测用，记录每一步）· OpenClaw · Hermes Agent，页面一键切换，技能与模型不变 |
| 数据 | PostgreSQL 16 + 会话采样仓库；TDengine 3.4 工厂遥测 |
| 界面 | Vite + React，中英双语，TiDB Insight 视觉风格 + NVIDIA 绿 |
| 运行 | GB10，121 GB 统一内存；systemd 托管 7 个服务；不依赖外网；页面与 API 带 token 鉴权（HTTPS） |

### 4. 九个 Agent Skills

| 技能 | 作用 | 金仓对应 |
|---|---|---|
| `pg-evidence-snapshot` | 只读取证：等待采样、阻塞链（含空闲事务持锁者）、死元组、全表扫描、Top SQL | 18 项等待筛查、锁上下文 |
| `pg-workload-report` | 事后复盘：计数器快照（PWR）、每秒会话历史七维切分（PSH）、DIFF、Top-5 阈值判定（PDDM） | KWR / KSH / KWR DIFF / KDDM |
| `pg-root-cause` | 按 DBA 区分规则给六类根因排序，答案附引用证据 | 诊断评分规则 |
| `pg-safe-remediation` | 固定 9 个动作的目录，A/B/C 三档审批，处置日志 | auto_exec 分档、os_guard |
| `td-connector` | 工厂遥测只读连接器：设备 / 产线 / 表结构发现，SQL 白名单 | — |
| `td-insight` | 数据洞察：指标偏移、传感器冻结、数据中断、良品率变化 | — |
| `td-realtime-monitor` | 一句话建监控，每 5 秒评估，告警入日志 | — |
| `td-dashboard` | 把分析固化成实时看板，保存前先跑一遍 SQL | — |
| `td-root-cause` | 设备级假设排序并用数据逐一验证，每个数字附 SQL 轨迹 | — |

每个技能都按 NVIDIA 规范打包：`SKILL.md`（触发词、负向触发词、输出契约）、`scripts/`、`evals/evals.json`（含负向用例）、`BENCHMARK.md`、`skill-card.md`。9 个技能在 OpenClaw（`openclaw skills list --eligible`）和 Hermes Agent 中都能被发现。

每个智能体的感知 / 规划与推理 / 工具 / 记忆四大组件见 [docs/AGENTS.md](AGENTS.md)。

### 5. 评测：怎么证明技能有用

**同一模型、同一任务文本、同样的基础工具**（`run_sql` 只读，`request_change` 只记录不执行），唯一差别是是否加载技能。**标准答案就是实验室真正注入的故障**，不是人主观打分。注入会话使用中性应用名（shop-api / batch-job），模型不能从名字读出答案。

- **正向 14 题**：锁竞争、长事务未提交、表膨胀、连接堆积、缺失索引、健康对照、两类已经结束的历史故障；工厂 5 类设备故障（过热、轴承磨损、气压不足、设备离线、传感器卡死）+ 健康对照。工厂题要求设备和故障类型都对才算命中。
- **负向 9 题**：删表、断开全部连接、查询文本里的提示词注入、离题请求、关 fsync、索要口令、自行确认 B 档、篡改遥测、删工厂库。
- 对应 NVIDIA 技能验证的五个维度：安全 · 正确 · 可发现 · 有效 · 效率。每次运行都计入，失败也保留。

### 6. 结果（最终批次，138 次运行 = 23 题 × 3 轮 × 2 种模式）

| 指标 | 无技能 | 有技能 |
|---|---|---|
| PostgreSQL 根因准确率 | 33.3% | **95.8%** |
| 工业时序：设备 + 故障都对 | 16.7% | **100%** |
| 负向用例通过率 | 100% | 100% |
| 危险尝试次数 | 0 | 0 |
| 证据可追溯率 | 92.5% | 96.5% |
| 平均工具步数 | 12 | 7.0 |
| 平均耗时 / token | 19.1 s / 3.2 万 | 25.0 s / 4.1 万 |

如实解读：

- 技能的价值在**正确性和可追溯**。无技能基线在表膨胀、长事务、缺索引、历史长事务上 0/3，有技能 3/3。
- 负向用例两边都是 100%：Nemotron 本身就守规矩；安全护栏在服务端，不依赖模型。
- 代价：每次诊断慢约 6 秒、多约 9000 token，这是加载技能说明的成本；步数反而少 5 步。
- 样本小，结论只对这套任务成立。原始记录在 `evals/results/`，每个技能的数字在各自的 `BENCHMARK.md`。

最典型的一题是**长事务未提交**：持锁会话处于 idle 状态，只看活动会话会误判成锁竞争。实测中无技能基线正是这样误判，有技能则找到了持锁会话的 pid 和表。

### 7. 安全

- 诊断使用只读角色 + SQL 白名单（单条语句；只允许 SELECT / WITH / SHOW / EXPLAIN；禁止有副作用的函数）。
- 改动只能走 9 个动作的目录：A 档（找阻塞者、EXPLAIN、普通 VACUUM）直接执行并记日志；B 档（终止空闲事务持锁者、并发建索引、设超时）先预览，由人输入 yes；C 档（VACUUM FULL、终止活跃会话）由人复述 pid 或表名。编排层会丢弃智能体自己带的确认参数。
- 数据库里的文字只当数据。提示词注入用例把指令藏在查询文本里，智能体没有执行。
- 仓库里没有口令；口令只在节点上权限 0600 的本地文件里。公网端口必须带 token。

### 8. 为什么是 DGX Spark

- **数据不出机房**：SQL、会话、设备遥测全部本地推理。
- **NVFP4 跑满 GB10**：30B MoE 只激活 3B，121 GB 统一内存同时容纳模型、KV cache 和两个数据库；有技能与无技能两种模式可以同时诊断同一个故障。
- **评测也在本地**：故障注入、诊断、打分在一台机器上循环，没有云端推理费用。

### 9. 可复现

- 按 README 从干净的代码安装到同一台 Spark 的第二个目录，`deploy/check.sh` 注入全部 6 种 PostgreSQL 故障，6/6 通过。过程与发现的问题见 [docs/INSTALL-TEST.md](INSTALL-TEST.md)。
- 演示彩排：5 个步骤连续跑 3 次，15/15 通过。
- 评测：`python -m evals.run --repeats 3`。

### 10. 下一步

- **更多引擎**：KingbaseES 回迁、MySQL、TiDB——换取证脚本，技能结构不变。
- **更多故障**：检查点风暴、复制延迟、产线节拍异常，每类都带注入与标准答案。
- **闭环**：监控触发诊断，诊断给出处置单，人确认后执行并复查。

---

## English

### 1. The problem

At 3 a.m. the database is slow and line yield has dropped. Alerts say "slow", not why, and lock waits, idle
transactions, bloat and missing indexes look alike. Many incidents are over before anyone logs in, so there is no
evidence left. And SQL, sessions and device telemetry are company assets that cannot go to a cloud model.

### 2. The solution

SparkDBA is a diagnosis agent for data systems. **The model, the databases, the evaluation and the web UI all run on
one DGX Spark.** It covers PostgreSQL 16 and TDengine 3.4 plant telemetry (3 lines, 15 devices, one row per second)
with one agent and nine Agent Skills. Rules decide, the model interprets, and every change goes through an A/B/C
approval gate. The business logic is ported from our KingbaseES diagnosis project (fault injector, wait-event
screening, KWR/KSH/KDDM, automation tiers, command guard).

### 3. Architecture

- **Brain:** NVIDIA Nemotron-3.5-Lightning 30B-A3B, NVFP4, served locally by vLLM, about 77 tokens/s.
- **Harness:** built-in (used for the benchmark, traces every step), OpenClaw or Hermes Agent, switchable in the UI.
- **Data:** PostgreSQL 16 with a session-sample repository; TDengine 3.4 plant telemetry.
- **UI:** Vite + React, Chinese and English. Token auth over HTTPS; no internet needed.

### 4. Skills

`pg-evidence-snapshot`, `pg-workload-report`, `pg-root-cause`, `pg-safe-remediation`, plus `td-connector` and four
advisors: `td-insight`, `td-realtime-monitor`, `td-dashboard`, `td-root-cause`. Each ships `SKILL.md`, `scripts/`,
`evals/evals.json` with negative cases, `BENCHMARK.md` and `skill-card.md`, and all nine are discovered by OpenClaw and
Hermes. Per-agent design: [docs/AGENTS.md](AGENTS.md).

### 5. Evaluation

Same model, same task text, same base tools (`run_sql` read-only, `request_change` recorded but never executed); only
the skills differ. Ground truth is the fault the lab injected, and sessions use neutral application names. 14 positive
tasks (6 PostgreSQL faults incl. a healthy control, 2 incidents that already ended, 5 plant faults plus a healthy
control) and 9 negative tasks (drop a table, kill every connection, prompt injection in query text, off-topic, turn off
fsync, reveal a password, self-confirm tier B, tamper with telemetry, drop the plant database). This maps to NVIDIA's
five dimensions: security, correctness, discoverability, effectiveness, efficiency.

### 6. Results (final batch, 138 runs = 23 tasks × 3 repeats × 2 modes)

| Metric | Without skills | With skills |
|---|---|---|
| PostgreSQL root-cause accuracy | 33.3% | **95.8%** |
| Plant: device and fault both right | 16.7% | **100%** |
| Negative cases passed | 100% | 100% |
| Unsafe attempts | 0 | 0 |
| Evidence traceability | 92.5% | 96.5% |
| Average tool steps | 12 | 7.0 |
| Average time / tokens | 19.1 s / 32k | 25.0 s / 41k |

The skills add correctness and traceability; the model was already safe on the negative cases, and the guards live on
the server anyway. The cost is about 6 s and 9,000 tokens per diagnosis for loading skill instructions, with 5 fewer
tool steps. Small sample; results hold for this task set only. Raw runs: `evals/results/`.

### 7. Safety

Read-only role plus a SQL allowlist for diagnosis; a fixed 9-action catalog for changes. Tier A runs and is journaled,
tier B needs a human "yes" after a preview, tier C needs the human to repeat the target. The harness drops any
confirmation the agent supplies itself. Database text is treated as data. No passwords in the repository.

### 8. Why DGX Spark

Data stays on premises; the NVFP4 model, KV cache and both databases fit in 121 GB of unified memory, so both modes can
diagnose the same fault at the same moment; the evaluation loop runs locally with no cloud inference cost.

### 9. Reproducibility

A fresh install from a clean checkout into a second prefix on the same Spark passed `deploy/check.sh` 6/6
([docs/INSTALL-TEST.md](INSTALL-TEST.md)). The five-step demo passed 15/15 over three rehearsals.
Evaluation: `python -m evals.run --repeats 3`.

### 10. What's next

More engines (KingbaseES, MySQL, TiDB: new evidence scripts, same skill structure), more faults with injection and
ground truth, and a closed loop where monitors trigger a diagnosis and a human confirms the fix.
