# SparkDBA 智能体设计说明

> 参照《KWR / KSH / KDDM 故障诊断智能体》(KWR-V4.pptx) 的框架：每个智能体按 **感知 / 规划与推理 / 工具（行动）/ 记忆** 四大组件说明，
> 再补齐该文档的五个方面：输入权限、组件构成、部署、GPU、根因链。
> 被诊断对象从 KingbaseES 换成同源的 PostgreSQL 16；KES 的 `sys_*` 视图对应 PG 的 `pg_*` 视图，业务逻辑沿用金仓项目。

## 0. 总体：一个编排智能体 + 四个技能智能体

```
用户 / 值班 ──> SparkDBA 编排智能体（Nemotron 3.5 · vLLM · GB10）
                 │  只看到 4 个技能的 name + description（约 100 token/个）
                 ├─ 取证智能体        pg-evidence-snapshot   现场：此刻谁在等谁
                 ├─ 负载报告智能体    pg-workload-report     历史：KWR/KSH/KDDM → PWR/PSH/PDDM
                 ├─ 根因智能体        pg-root-cause          判定：规则排序 + 证据引用
                 └─ 处置智能体        pg-safe-remediation    执行：A/B/C 三级闸门
```

分工原则与金仓项目一致：**判定用规则（确定、免费、可复现），解读用模型，执行有闸门**。
每个技能是一个可分发目录：`SKILL.md`（触发 + 负向触发 + 输出契约）、`scripts/`、`references/`、`evals/`、`BENCHMARK.md`、`skill-card.md`。

## 1. 编排智能体（SparkDBA harness，`server/agent.py`）

| 组件 | AI Agent 业界标准 | 本智能体的实现 |
|---|---|---|
| 感知 | 获取环境信息 | 用户自然语言任务；工具返回的 JSON（快照、报告、判定）；数据库内容一律当数据，不当指令 |
| 规划与推理 | 大脑 = LLM；CoT / ReAct / Reflection | Nemotron-3.5-Lightning-30B-A3B（NVFP4）驱动 ReAct 循环：Thought → 调工具 → Observation；最多 12 步，超步数强制按契约作答；输出契约要求 `CATEGORY / ROOT CAUSE / EVIDENCE / RULED OUT / NEXT ACTION`，EVIDENCE 里的数字必须出自工具输出（可追溯率自动计算） |
| 工具（行动） | API / 函数调用 | 基础：`run_sql`（只读白名单）、`request_change`（只登记不执行）；技能：`load_skill`（渐进披露第 2 层）、`run_skill`（第 3 层，执行 `scripts/run.sh`） |
| 记忆 | 短期 / 长期 | 短期：本次对话消息 + 最近一次快照（供根因技能直接复用）+ SSE 事件流；长期：`data/runs.jsonl` 每次诊断的结论、步数、token、耗时、变更尝试；评测批次存 `evals/results/raw-*.jsonl` |

渐进披露（StepFun 分享的三层）：第 1 层只常驻 4 条 description；命中后 `load_skill` 读 SKILL.md；执行时才运行脚本、读 references。

## 2. 取证智能体 `pg-evidence-snapshot`

对应金仓项目的「18 项等待事件筛查」与锁上下文快照。

| 组件 | 实现 |
|---|---|
| 感知 | `pg_stat_activity` 10 次 × 0.5 s 采样的等待事件分布；`pg_blocking_pids` 阻塞链（含 idle in transaction 持锁方——活动会话采样看不到它）；`pg_locks` 持锁模式；`pg_stat_user_tables` 死元组与顺序扫描；`pg_stat_statements` Top SQL；关键 GUC |
| 规划与推理 | 无反馈规划（固定取证清单，一次跑完，约 5 s），不花模型 token |
| 工具（行动） | `scripts/snapshot.py`，只读角色 `sparkdba_ro`（`default_transaction_read_only=on`，`statement_timeout=10s`） |
| 记忆 | 输出 JSON 即本次事件的「证据登记」，编排智能体缓存为 `last_snapshot`，根因技能直接复用，不重复采集 |

## 3. 负载报告智能体 `pg-workload-report`（KWR / KSH / KDDM 的 PostgreSQL 版）

| 金仓 | 本方案 | 做法 |
|---|---|---|
| KWR 负载信息库 | **PWR** | 每 10 分钟 + 按需快照 `pg_stat_database / pg_stat_statements / pg_stat_user_tables` 到 `repo.*`；两次快照做差出区间报告（提交/秒、缓存命中、Top SQL、表扫描）；统计被重置时按「新值即增量」处理 |
| KWR DIFF | **PWR DIFF** | 两段区间逐项对比，每条 SQL 判「新出现 / 变慢 / 调用变多 / 相近」，区分业务变多还是效率变差 |
| KSH 会话历史 | **PSH** | 采样器每秒写一行活跃或 idle-in-transaction 会话到 `repo.session_history`（保留 3 小时）；按 **七维**（SQL / 库 / 账号 / 客户端 / 应用 / 会话 / 后端类型）+ 等待事件切分，算 AAS |
| KDDM 诊断监视器 | **PDDM** | Top-5 阈值判定（二八法则）：缓存命中 ≥ 98%、Lock 等待占比 < 5%、IO 等待占比 < 15%、idle-in-tx = 0、索引扫描占比 ≥ 80%；超标给建议 |

| 组件 | 实现 |
|---|---|
| 感知 | 结构化历史（快照、会话样本）；自然语言时间（「2 分钟前」「14:00–15:00」）由编排智能体换算成 `--ago / --minutes` |
| 规划与推理 | 采集是静态计划（采样器 + 定时快照）；分析时模型按 SKILL.md 的顺序：先 `top5` 看哪项超标，再 `ash --by wait`、`ash --by session` 下钻到持锁会话 |
| 工具（行动） | `pwr.py`：`ash / top5 / report / diff / list / snapshot`；读用只读角色，写（采样、快照）用 `sparkdba_repo` |
| 记忆 | **长期记忆的主体**：`repo.snapshots` 保留 7 天、`repo.session_history` 保留 3 小时——故障结束后仍能复盘，这是基线智能体没有的能力（见评测 `P-past-*`） |

## 4. 根因智能体 `pg-root-cause`

| 组件 | 实现 |
|---|---|
| 感知 | 取证 JSON（或负载报告的结论） |
| 规划与推理 | `classify.py`：五条 DBA 区分规则逐条打分排序（锁竞争 / 长事务未提交 / 表膨胀 / 连接堆积 / 缺失索引），都不足 0.4 判健康；模型负责写结论、引用数字、写「排除了谁」——**反思**体现在契约里：必须给 RULED OUT，证据缺失不得编造 |
| 工具（行动） | `scripts/classify.py`；`references/discriminators.md`（易混故障的区分依据、PG16 等待事件解读、处置映射），仅在前两名置信度接近时加载 |
| 记忆 | 规则本身是沉淀下来的经验：金仓盲测里「锁竞争 vs 长事务」混淆、「连接堆积」补连接状态证据后提分，这些教训写成了区分规则 |

## 5. 处置智能体 `pg-safe-remediation`

对应金仓项目的自动化执行站（auto_exec 三档）与 os_guard 护栏。

| 组件 | 实现 |
|---|---|
| 感知 | 目标会话状态（pid、state、事务时长、SQL）、表大小与死元组、当前 GUC |
| 规划与推理 | 先 `preview` 给出影响面，再按档位决定能否执行：A 直接执行；B 需人输入 `yes`；C 需人复述目标（pid/表名）。`terminate_blocker` 只允许终止 idle-in-transaction 会话，active 会话必须走 C 档 |
| 工具（行动） | 固定目录 9 个动作，目录外一律拒绝（无自由 SQL 入口）；标识符严格校验；角色 `sparkdba_ops` 只有 `pg_monitor + pg_signal_backend + 表属主成员 + 单个参数的 ALTER SYSTEM` |
| 记忆 | `data/remediation.jsonl` 处置日志：时间、档位、动作、目标、影响面、结果；页面「安全与处置」可回看 |

服务端二次护栏（不靠提示词）：编排层拦截模型自带的 `--confirm`，确认只能来自用户输入；`request_change` 永不执行，只分类登记（危险 / 普通）。

## 6. 五个方面

| 方面 | 本方案 |
|---|---|
| ① 输入权限 | OS：无（不 SSH 到数据库主机，全部走 libpq）。DB：四个最小权限角色——`sparkdba_ro`（只读 + pg_monitor）、`sparkdba_repo`（只写 repo 模式）、`sparkdba_ops`（处置目录所需）、`sparkdba_chaos`（仅实验室注入）；口令只在 0600 的 `/opt/sparkdba/.env` |
| ② 组件构成 | 上文 1–5 节 |
| ③ 部署 | 全部在一台 DGX Spark（gx10）上：vLLM（127.0.0.1:8000）、PostgreSQL 16、采样器、FastAPI + 前端（:9000，token 鉴权），均为 systemd 单元；不依赖外网 |
| ④ GPU | GB10 统一内存 121 GB；Nemotron NVFP4 权重约 21 GB，vLLM `--gpu-memory-utilization 0.60`（含 FP8 KV cache，65K 上下文）；单次诊断 4–6 步、约 12 s（实测见评测页） |
| ⑤ 根因链 | ① 取证（现场快照 / 历史 PSH）→ ② 规则判定（PDDM Top-5 + 五条区分规则）→ ③ 差分定位（PWR DIFF）→ ④ 七维切分（PSH `--by`）→ ⑤ 模型解读（契约 + 证据引用）→ ⑥ 分级执行（A/B/C + 人工确认 + 日志） |

## 7. 评测（证明技能有用）

同一模型、同一任务、同样的 `run_sql / request_change`，唯一差别是是否加载技能。故障由实验室真实注入（中性应用名，模型读不到答案），标准答案 = 注入的故障。
正向：6 类现场故障 + 2 类「已结束的历史故障」；负向：删表、全部断连、提示词注入、离题、关 fsync、索要口令、自行确认 B 档。结果见 `skills/*/BENCHMARK.md` 与页面「评测对照」。
