import { useState } from 'react'
import { post, usePoll } from '../api'
import { EChart } from '../components/EChart'
import { Note } from '../components/ui'
import { useLang, useT } from '../i18n'

type Row = [string, string, string, string]   // component zh, en, impl zh, impl en
type AgentDef = { id: string; name: string; en: string; tag: string; tone: string; role: [string, string]; rows: Row[] }

const AGENTS: AgentDef[] = [
  { id: 'harness', name: '编排智能体', en: 'Orchestrator', tag: 'server/agent.py', tone: 'c',
    role: ['只看 9 个技能的名字与描述，先路由再按需加载、调用，最后按契约作答；可切换为 OpenClaw 或 Hermes。', 'Sees only the nine skills\' names and descriptions, routes, loads and calls them on demand, answers to a contract; switchable to OpenClaw or Hermes.'],
    rows: [
      ['感知', 'Perception', '用户自然语言任务；工具返回的 JSON；数据库里的文字一律当数据不当指令', 'The user\'s task; JSON from tools; text from the database is data, never instructions'],
      ['规划与推理', 'Planning & reasoning', 'Nemotron 3.5（NVFP4）驱动 ReAct：想 → 调工具 → 看结果；≤12 步；契约强制 CATEGORY / 证据 / 排除项，证据数字自动核对可追溯率', 'Nemotron 3.5 (NVFP4) runs ReAct: think → call → observe; ≤12 steps; the contract forces CATEGORY / evidence / ruled-out, evidence numbers are checked for traceability'],
      ['工具（行动）', 'Tools (action)', 'run_sql（只读白名单）· request_change（只登记不执行）· load_skill（渐进披露第 2 层）· run_skill（第 3 层）', 'run_sql (read-only allowlist) · request_change (recorded, never run) · load_skill (disclosure layer 2) · run_skill (layer 3)'],
      ['记忆', 'Memory', '短期：本轮消息 + 最近一次快照 + SSE 事件流；长期：runs.jsonl 每次诊断的结论、步数、token', 'Short-term: this run\'s messages + last snapshot + SSE stream; long-term: runs.jsonl with verdict, steps, tokens per diagnosis'],
    ] },
  { id: 'snap', name: '取证智能体', en: 'Evidence agent', tag: 'pg-evidence-snapshot', tone: 'g',
    role: ['现场：此刻谁在等谁。对应金仓的 18 项等待事件筛查与锁上下文。', 'Live: who waits on whom right now. The Kingbase 18-check wait screen and lock context.'],
    rows: [
      ['感知', 'Perception', '10×0.5 s 等待事件采样、pg_blocking_pids 阻塞链（含 idle in transaction 持锁方）、pg_locks 模式、死元组、顺序扫描、Top SQL、关键参数', '10×0.5 s wait sampling, pg_blocking_pids chains (incl. idle-in-transaction holders), lock modes, dead tuples, seq scans, top SQL, key settings'],
      ['规划与推理', 'Planning & reasoning', '无反馈规划：固定取证清单一次跑完（约 5 s），不花 token', 'Plan without feedback: a fixed checklist in one pass (~5 s), no tokens'],
      ['工具（行动）', 'Tools (action)', 'snapshot.py，只读角色 sparkdba_ro（read_only=on，10 s 超时）', 'snapshot.py under read-only role sparkdba_ro (read_only=on, 10 s timeout)'],
      ['记忆', 'Memory', '输出即本次事件的证据登记，被缓存给根因智能体复用', 'Its output is the evidence of record, cached for the root-cause agent'],
    ] },
  { id: 'pwr', name: '负载报告智能体', en: 'Workload agent', tag: 'pg-workload-report', tone: 'g',
    role: ['历史：KWR / KSH / KDDM 在 PostgreSQL 上的重建 —— PWR / PSH / PDDM。', 'History: KWR / KSH / KDDM rebuilt on PostgreSQL as PWR / PSH / PDDM.'],
    rows: [
      ['感知', 'Perception', '每 10 分钟计数器快照（PWR）；每秒会话样本（PSH）；「2 分钟前」「14:00–15:00」换算成时间窗', 'Counter snapshots every 10 min (PWR); per-second session samples (PSH); "2 minutes ago" turned into a window'],
      ['规划与推理', 'Planning & reasoning', '采集是静态计划；分析按顺序：top5 看哪项超标 → ash 按等待事件 → 按会话下钻到持锁方', 'Collection is a static plan; analysis goes top5 → ash by wait → ash by session to the holder'],
      ['工具（行动）', 'Tools (action)', 'ash（七维切分）· top5（Top-5 阈值）· report · diff · list · snapshot', 'ash (7-dimension slicing) · top5 (thresholds) · report · diff · list · snapshot'],
      ['记忆', 'Memory', '长期记忆主体：快照保留 7 天，会话历史 3 小时 —— 故障结束后仍可复盘', 'The long-term memory: snapshots for 7 days, session history for 3 h — incidents can be replayed after they end'],
    ] },
  { id: 'rc', name: '根因智能体', en: 'Root-cause agent', tag: 'pg-root-cause', tone: 'g',
    role: ['判定：五条 DBA 区分规则排序，模型负责解读与引用证据。', 'Judgment: five DBA discriminator rules rank; the model interprets and cites.'],
    rows: [
      ['感知', 'Perception', '取证 JSON 或负载报告结论', 'Evidence JSON or workload findings'],
      ['规划与推理', 'Planning & reasoning', 'classify.py 规则打分（锁竞争 / 长事务 / 膨胀 / 连接堆积 / 缺索引，<0.4 判健康）；反思写进契约：必须给「排除了谁」，缺证据不许编', 'classify.py scores five rules (<0.4 means healthy); reflection lives in the contract: state what was ruled out, never invent evidence'],
      ['工具（行动）', 'Tools (action)', 'classify.py · references/discriminators.md（易混故障区分、PG16 等待事件、处置映射）', 'classify.py · references/discriminators.md (look-alikes, PG16 waits, remediation map)'],
      ['记忆', 'Memory', '规则就是沉淀的经验：金仓盲测里锁竞争与长事务的混淆、连接堆积靠补证据提分', 'The rules are distilled experience from the Kingbase blind tests (lock vs idle-tx confusion, connection-state evidence)'],
    ] },
  { id: 'fix', name: '处置智能体', en: 'Remediation agent', tag: 'pg-safe-remediation', tone: 'p',
    role: ['执行：固定目录 + A/B/C 三级闸门。对应金仓的 auto_exec 与 os_guard。', 'Action: fixed catalog + A/B/C gates. The Kingbase auto_exec and os_guard.'],
    rows: [
      ['感知', 'Perception', '目标会话状态与事务时长、表大小与死元组、当前参数值', 'Target session state and xact age, table size and dead tuples, current settings'],
      ['规划与推理', 'Planning & reasoning', '先 preview 影响面，再按档位：A 直接做；B 人输入 yes；C 人复述 pid/表名。active 会话不能按 B 档终止', 'Preview first, then by tier: A runs; B needs a human yes; C needs the human to repeat the target. Active sessions cannot be killed as tier B'],
      ['工具（行动）', 'Tools (action)', '9 个动作的固定目录，目录外一律拒绝；角色 sparkdba_ops 权限最小', 'A 9-action catalog; anything else refused; least-privilege role sparkdba_ops'],
      ['记忆', 'Memory', 'remediation.jsonl 处置日志：时间、档位、目标、影响面、结果', 'remediation.jsonl journal: time, tier, target, impact, result'],
    ] },
  { id: 'plant', name: '工业时序智能体', en: 'Plant agent', tag: 'td-connector + 4 advisors', tone: 'c',
    role: ['TDengine：1 个连接器拿到数据，4 位顾问（洞察、实时监控、看板、根因）知道怎么用数据。', 'TDengine: one connector gets the data; four advisors (insight, real-time monitors, dashboards, root cause) know how to use it.'],
    rows: [
      ['感知', 'Perception', '每秒设备遥测（温度、振动、压力、电流、状态）与每条产线良品率；窗口对比前 30 分钟基线', 'Per-second device telemetry and per-line yield; each window compared with the 30 minutes before it'],
      ['规划与推理', 'Planning & reasoning', '根因：设备级假设排序（过热 / 轴承 / 气压 / 离线 / 卡死）并用良品率验证；洞察：z 值偏移、零方差、数据缺口', 'Root cause: device-level hypotheses (overheat / bearing / pressure / offline / stuck) verified against yield; insight: z-shifts, zero variance, gaps'],
      ['工具（行动）', 'Tools (action)', 'td-connector 只读 SQL 白名单（TDengine OSS 无 GRANT）· rank · health · 监控 create/check · 看板 create/render', 'td-connector read-only SQL allowlist (TDengine OSS has no GRANT) · rank · health · monitor create/check · dashboard create/render'],
      ['记忆', 'Memory', '监控规则与告警日志、保存的看板、每个结论附带的 SQL 轨迹', 'Monitor rules and alert journal, saved dashboards, the SQL trace behind each conclusion'],
    ] },
]

export function DesignPage() {
  const t = useT()
  const en = useLang() === 'en'
  return (
    <article>
      <p className="eyebrow">Agent design</p>
      <h1>{t('智能体四大组件', 'Four components per agent')}</h1>
      <p className="lead">{t('沿用金仓 KWR/KSH/KDDM 智能体的框架：每个智能体按「感知 / 规划与推理 / 工具 / 记忆」拆开说明。分工不变：判定用规则，解读用模型，执行有闸门。',
        'Same frame as our Kingbase KWR/KSH/KDDM agent: every agent is described by perception / planning & reasoning / tools / memory. Same split: rules decide, the model interprets, gates execute.')}</p>
      <div className="pipe">
        <span>{t('用户任务', 'task')}</span><i>→</i><span className="tag c">{t('编排', 'orchestrator')}</span><i>→</i>
        <span className="tag g">{t('取证', 'evidence')}</span><i>/</i><span className="tag g">{t('负载报告', 'workload')}</span><i>→</i>
        <span className="tag g">{t('根因', 'root cause')}</span><i>→</i><span className="tag p">{t('处置', 'remediation')}</span>
      </div>
      {AGENTS.map(a => (
        <section key={a.id} className="card skill">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ fontFamily: 'var(--sans)' }}>{en ? a.en : a.name}</h2><span className={`tag ${a.tone}`}>{a.tag}</span>
          </div>
          <p className="dim">{en ? a.role[1] : a.role[0]}</p>
          <table className="tbl">
            <tbody>{a.rows.map(r => <tr key={r[0]}><th style={{ width: 150 }}>{en ? r[1] : r[0]}</th><td>{en ? r[3] : r[2]}</td></tr>)}</tbody>
          </table>
        </section>
      ))}
      <h2 className="sec">{t('五个方面', 'Five aspects')}</h2>
      <div className="card" style={{ padding: 16, overflowX: 'auto' }}>
        <table className="tbl"><tbody>
          <tr><th>{t('① 输入权限', '① Inputs')}</th><td>{t('不需要 OS 权限；四个最小权限数据库角色：只读 / 仓库写入 / 处置 / 实验室注入；口令只在 0600 的 env 文件', 'No OS access; four least-privilege DB roles: read-only / repo writer / remediation / lab; passwords only in a 0600 env file')}</td></tr>
          <tr><th>{t('② 组件', '② Components')}</th><td>{t('上面六个智能体', 'The six agents above')}</td></tr>
          <tr><th>{t('③ 部署', '③ Deployment')}</th><td>{t('一台 DGX Spark：vLLM、PostgreSQL 16、TDengine 3.4、采样器、FastAPI + 前端、OpenClaw 网关，systemd 托管，不依赖外网', 'One DGX Spark: vLLM, PostgreSQL 16, TDengine 3.4, sampler, FastAPI + UI, OpenClaw gateway under systemd, no internet needed')}</td></tr>
          <tr><th>{t('④ GPU', '④ GPU')}</th><td>{t('GB10 统一内存 121 GB；Nemotron NVFP4 权重约 21 GB，vLLM 占用 60%（含 FP8 KV cache、65K 上下文）', 'GB10 with 121 GB unified memory; Nemotron NVFP4 weights ~21 GB, vLLM at 60% (incl. FP8 KV cache, 65K context)')}</td></tr>
          <tr><th>{t('⑤ 根因链', '⑤ Root-cause chain')}</th><td>{t('取证 → 规则判定（Top-5 + 区分规则）→ 差分定位（DIFF）→ 七维切分 → 模型解读（证据必引用）→ 分级执行', 'Evidence → rule judgment (Top-5 + discriminators) → diff → 7-dimension slicing → model interpretation (cited) → tiered action')}</td></tr>
        </tbody></table>
      </div>
    </article>
  )
}

const TOP5_ZH: Record<string, string> = {
  buffer_hit_pct: '缓存命中率', lock_wait_pct: '活跃样本中等锁的占比', io_wait_pct: '活跃样本中等 IO 的占比',
  idle_in_tx_samples: '空闲事务样本数', index_scan_pct: '大表索引扫描占比',
}

type Check = { check: string; value: number; threshold: string; status: string; what: string; advice?: string }
type Top5 = { samples: number; checks: Check[]; warnings: string[] }
type Ash = { window: { from: string; to: string; samples: number } | null; rows?: { key: string; samples: number; aas: number; idle_in_tx_samples: number }[]; note?: string }

export function WorkloadPage() {
  const t = useT()
  const en = useLang() === 'en'
  const [minutes, setMinutes] = useState(10)
  const [ago, setAgo] = useState(0)
  const [by, setBy] = useState('wait')
  const [k, setK] = useState(0)
  const top = usePoll<Top5>(`pwr/top5?minutes=${minutes}&ago=${ago}&k=${k}`)
  const ash = usePoll<Ash>(`pwr/ash?by=${by}&minutes=${minutes}&ago=${ago}&k=${k}`)
  const snaps = usePoll<{ snap_id: number; taken_at: string }[]>(`pwr/list?k=${k}`)
  const rows = ash?.rows ?? []
  const option = {
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true }, tooltip: { trigger: 'axis' },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: '#2c2d33' } } },
    yAxis: { type: 'category', inverse: true, data: rows.map(r => r.key.slice(0, 48)), axisLabel: { width: 260, overflow: 'truncate' } },
    series: [{ type: 'bar', name: 'AAS', data: rows.map(r => r.aas), itemStyle: { color: '#76b900', borderRadius: [0, 4, 4, 0] } }],
  }
  return (
    <article>
      <p className="eyebrow">PWR · PSH · PDDM</p>
      <h1>{t('负载报告', 'Workload report')}</h1>
      <p className="lead">{t('金仓自带 KWR / KSH / KDDM，原生 PostgreSQL 没有。这里用 pg_stat_* 重建了三件套：计数器快照（PWR）、每秒会话历史（PSH）、Top-5 阈值判定（PDDM）。故障结束后照样能复盘。',
        'Kingbase ships KWR / KSH / KDDM; stock PostgreSQL does not. Rebuilt here on pg_stat_*: counter snapshots (PWR), per-second session history (PSH) and a Top-5 threshold judgment (PDDM). Incidents can be replayed after they end.')}</p>
      <div className="card" style={{ padding: 16 }}>
        <div className="row">
          <label className="field">{t('时间窗（分钟）', 'Window (min)')}<input type="number" min={1} max={180} value={minutes} onChange={e => setMinutes(+e.target.value || 10)} /></label>
          <label className="field">{t('往前推（分钟）', 'Minutes ago')}<input type="number" min={0} max={180} value={ago} onChange={e => setAgo(+e.target.value || 0)} /></label>
          <label className="field">{t('切分维度', 'Slice by')}<select value={by} onChange={e => setBy(e.target.value)}>
            {['wait', 'query', 'app', 'user', 'client', 'db', 'backend', 'session'].map(x => <option key={x}>{x}</option>)}</select></label>
          <button className="btn" onClick={() => setK(k + 1)}>{t('刷新', 'Refresh')}</button>
          <button className="btn primary" onClick={() => post('pwr/snapshot', {}).then(() => setK(k + 1))}>{t('立即快照', 'Snapshot now')}</button>
        </div>
      </div>
      <h2 className="sec">PDDM · Top-5</h2>
      <div className="stats">
        {(top?.checks ?? []).map(c => (
          <div key={c.check} className="card stat" style={{ borderColor: c.status === 'ok' ? undefined : 'var(--err)' }}>
            <div className="k">{en ? c.what : (TOP5_ZH[c.check] ?? c.what)}</div>
            <div className={`v ${c.status === 'ok' ? 'up' : 'down'}`}>{c.value}<small>{c.threshold}</small></div>
            {c.advice && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{c.advice}</div>}
          </div>
        ))}
      </div>
      <h2 className="sec">PSH · {t('平均活跃会话（AAS）按', 'Average active sessions by')} {by}</h2>
      <div className="card" style={{ padding: 16 }}>
        {ash?.window ? <>
          <p className="dim" style={{ marginTop: 0 }}>{ash.window.from.slice(11, 19)} – {ash.window.to.slice(11, 19)} · {ash.window.samples} {t('个采样点', 'samples')}</p>
          <EChart option={option} height={Math.max(160, rows.length * 30)} />
        </> : <p className="dim">{ash ? t('这个时间窗里没有活跃或空闲事务会话（采样器只记录这两类）。', 'No active or idle-in-transaction sessions in this window (the sampler records only those).') : t('加载中…', 'Loading…')}</p>}
      </div>
      <h2 className="sec">PWR · {t('快照', 'Snapshots')}</h2>
      <div className="card" style={{ padding: 16 }}>
        <div className="toolbar">{(snaps ?? []).slice(0, 16).map(s => <span key={s.snap_id} className="tag">#{s.snap_id} {s.taken_at.slice(5, 16).replace('T', ' ')}</span>)}</div>
      </div>
      <Note>{t('判定是写死的阈值（可复现），模型只负责解读与引用数字。与金仓 KDDM 的 Top-5 同一套检查。',
        'Judgment is fixed thresholds (reproducible); the model only interprets and cites. Same five checks as the Kingbase KDDM Top-5.')}</Note>
    </article>
  )
}
