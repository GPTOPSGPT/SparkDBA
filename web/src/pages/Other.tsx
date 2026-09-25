import { useState } from 'react'
import { post, usePoll, type Bench } from '../api'
import { EChart } from '../components/EChart'
import { catLabel } from '../components/Trace'
import { Note } from '../components/ui'
import { useLang, useT } from '../i18n'

export const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`)

type Skill = { name: string; description: string; body: string; files: string[]; evals: { tasks?: { id: string; kind?: string; prompt?: string; expect?: string }[] } | null; benchmark: string | null; card: string | null }

export function SkillsPage() {
  const t = useT()
  const sk = usePoll<Skill[]>('skills')
  const [open, setOpen] = useState<Record<string, string>>({})
  return (
    <article>
      <p className="eyebrow">Agent Skills</p>
      <h1>{t('九个 Agent Skills', 'Nine Agent Skills')}</h1>
      <p className="lead">{t(
        '每个技能是一个可分发目录：SKILL.md 负责触发与路由（含负向触发），scripts 负责真正干活，evals 里带负向用例，BENCHMARK 记录有/无技能对照，skill-card 说明风险与限制。业务逻辑移植自金仓 KES 诊断项目。',
        'Each skill is a distributable directory: SKILL.md does triggering and routing (with negative triggers), scripts do the work, evals include negative cases, BENCHMARK records with/without-skill results, and the skill card states risks and limits. Business logic ported from our KingbaseES diagnosis project.')}</p>
      {(sk ?? []).map(s => (
        <section key={s.name} className="card skill">
          <h2>{s.name}</h2>
          <p className="dim" style={{ lineHeight: 1.6 }}>{s.description}</p>
          <div className="toolbar">
            {s.files.map(f => <span key={f} className="tag">{f}</span>)}
          </div>
          <div className="toolbar">
            {(['body', 'evals', 'benchmark', 'card'] as const).map(k => (
              <button key={k} className={`btn ${open[s.name] === k ? 'active' : ''}`}
                onClick={() => setOpen({ ...open, [s.name]: open[s.name] === k ? '' : k })}>
                {{ body: 'SKILL.md', evals: 'evals.json', benchmark: 'BENCHMARK.md', card: 'skill-card.md' }[k]}
              </button>
            ))}
          </div>
          {open[s.name] === 'body' && <div className="md">{s.body}</div>}
          {open[s.name] === 'evals' && <div className="md">{JSON.stringify(s.evals, null, 2)}</div>}
          {open[s.name] === 'benchmark' && <div className="md">{s.benchmark ?? t('尚未生成', 'not generated yet')}</div>}
          {open[s.name] === 'card' && <div className="md">{s.card ?? '—'}</div>}
        </section>
      ))}
    </article>
  )
}

export function BenchPage() {
  const t = useT()
  const en = useLang() === 'en'
  const b = usePoll<Bench>('bench')
  const s = b?.modes?.skills, base = b?.modes?.baseline
  if (!s || !base) return <article><h1>{t('评测对照', 'Benchmark')}</h1><p className="lead">{t('评测尚未跑完。', 'The evaluation has not finished yet.')}</p></article>
  const cats = [t('数据库根因', 'Database root cause'), t('工业时序根因', 'Plant root cause'), t('负向用例', 'Negative cases'), t('证据可追溯', 'Traceability')]
  const v = (m: typeof s) => [m.diagnosis_accuracy, m.plant_accuracy, m.negative_pass_rate, m.traceability].map(x => Math.round((x ?? 0) * 100))
  const option = {
    grid: { left: 40, right: 16, top: 36, bottom: 28 },
    legend: { top: 0 }, tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: cats, axisLine: { lineStyle: { color: '#2c2d33' } } },
    yAxis: { type: 'value', max: 100, splitLine: { lineStyle: { color: '#2c2d33' } }, axisLabel: { formatter: '{value}%' } },
    series: [
      { name: t('无技能基线', 'Baseline'), type: 'bar', data: v(base), itemStyle: { color: '#ff6b9d', borderRadius: [4, 4, 0, 0] } },
      { name: t('有技能', 'With skills'), type: 'bar', data: v(s), itemStyle: { color: '#76b900', borderRadius: [4, 4, 0, 0] } },
    ],
  }
  const eff = {
    grid: { left: 56, right: 16, top: 36, bottom: 28 }, legend: { top: 0 }, tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: [t('工具步数', 'Tool steps'), t('耗时 s', 'Seconds'), t('千 token', 'k tokens')], axisLine: { lineStyle: { color: '#2c2d33' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#2c2d33' } } },
    series: [base, s].map((m, i) => ({
      name: i ? t('有技能', 'With skills') : t('无技能基线', 'Baseline'), type: 'bar',
      data: [m.avg_steps, m.avg_seconds, Math.round((m.avg_tokens ?? 0) / 100) / 10],
      itemStyle: { color: i ? '#76b900' : '#ff6b9d', borderRadius: [4, 4, 0, 0] },
    })),
  }
  const tasks = Object.keys({ ...base.by_task, ...s.by_task }).sort()
  return (
    <article>
      <p className="eyebrow">Benchmark · {String(b?.meta?.date ?? '')}</p>
      <h1>{t('有技能 vs 无技能', 'With skills vs without')}</h1>
      <p className="lead">{t('同一模型、同一任务、同样的基础工具。故障由实验室真实注入，标准答案就是注入的故障。每次运行都计入，失败也计入。',
        'Same model, same tasks, same base tools. Faults are really injected by the lab; the ground truth is the injected fault. Every run counts, failures included.')}</p>
      <div className="cols-2">
        <div className="card" style={{ padding: 16 }}><EChart option={option} height={280} /></div>
        <div className="card" style={{ padding: 16 }}><EChart option={eff} height={280} /></div>
      </div>
      <div className="card" style={{ padding: 16, overflowX: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>{t('任务', 'Task')}</th><th className="num">{t('无技能', 'Baseline')}</th><th className="num">{t('有技能', 'Skills')}</th></tr></thead>
          <tbody>{tasks.map(k => <tr key={k}><td><code>{k}</code></td><td className="num">{base.by_task[k] ?? '–'}</td><td className="num">{s.by_task[k] ?? '–'}</td></tr>)}</tbody>
        </table>
      </div>
      <Note>{t(`模型 ${b?.meta?.model}；硬件 ${b?.meta?.hardware}；每个任务重复 ${b?.meta?.repeats} 次。样本小，结论只对这套任务成立。`,
        `Model ${b?.meta?.model}; hardware ${b?.meta?.hardware}; ${b?.meta?.repeats} repeats per task. Small sample: results hold for this task set only.`)}{en ? '' : ''}</Note>
    </article>
  )
}

type Journal = { ts: string; action: string; tier: string; target: string; impact: string; result: string }
type Res = { ok?: boolean; error?: string; impact?: string; needs_confirm?: string; tier?: string; result?: string; note?: string }

export function SafetyPage() {
  const t = useT()
  const [f, setF] = useState({ action: 'find_blocker', table: '', column: '', pid: '', confirm: '' })
  const [res, setRes] = useState<Res | null>(null)
  const [jkey, setJkey] = useState(0)
  const journal = usePoll<Journal[]>(`journal?k=${jkey}`)
  const tiers: [string, string, string, string][] = [
    ['A', 'find_blocker · explain_hot_query · vacuum_analyze · connection_pool_advice', t('直接执行，写日志', 'Runs, journaled'), 'g'],
    ['B', 'terminate_blocker · create_index · set_idle_tx_timeout', t('预览影响后，由人输入 yes', 'Preview, then a human types yes'), 'c'],
    ['C', 'vacuum_full · terminate_active', t('读完影响后，由人复述目标（pid / 表名）', 'After reading the impact, a human repeats the target (pid / table)'), 'p'],
  ]
  async function go(cmd: 'preview' | 'execute') {
    setRes(await post<Res>('remediate', { cmd, ...f }))
    if (cmd === 'execute') setJkey(k => k + 1)
  }
  return (
    <article>
      <p className="eyebrow">Safety</p>
      <h1>{t('安全与分级处置', 'Safety and tiered remediation')}</h1>
      <p className="lead">{t('护栏在服务端，不在提示词里：诊断走只读角色和 SQL 白名单；处置只能走固定目录，按 A/B/C 三级审批，B/C 的确认只能来自人。移植自金仓项目的 os_guard 与 auto_exec。',
        'Guards live on the server, not in the prompt: diagnosis uses a read-only role and a SQL allowlist; remediation only goes through a fixed catalog with A/B/C approval, and B/C confirmation can only come from a human. Ported from the Kingbase project\'s os_guard and auto_exec.')}</p>
      <div className="card" style={{ padding: 16, overflowX: 'auto' }}>
        <table className="tbl"><thead><tr><th>{t('级别', 'Tier')}</th><th>{t('动作', 'Actions')}</th><th>{t('闸门', 'Gate')}</th></tr></thead>
          <tbody>{tiers.map(r => <tr key={r[0]}><td><span className={`tag ${r[3]}`}>{r[0]}</span></td><td><code>{r[1]}</code></td><td>{r[2]}</td></tr>)}</tbody></table>
      </div>
      <h2 className="sec">{t('人工处置台', 'Operator console')}</h2>
      <div className="card" style={{ padding: 16 }}>
        <div className="row">
          <label className="field">{t('动作', 'Action')}
            <select value={f.action} onChange={e => setF({ ...f, action: e.target.value })}>
              {['find_blocker', 'explain_hot_query', 'vacuum_analyze', 'connection_pool_advice', 'terminate_blocker', 'create_index',
                'set_idle_tx_timeout', 'vacuum_full', 'terminate_active', 'drop_table'].map(a => <option key={a}>{a}</option>)}
            </select></label>
          <label className="field">table<input value={f.table} placeholder="public.events" onChange={e => setF({ ...f, table: e.target.value })} /></label>
          <label className="field">column<input value={f.column} placeholder="order_id" onChange={e => setF({ ...f, column: e.target.value })} /></label>
          <label className="field">pid<input value={f.pid} onChange={e => setF({ ...f, pid: e.target.value })} /></label>
          <label className="field">confirm<input value={f.confirm} placeholder="yes / pid / table" onChange={e => setF({ ...f, confirm: e.target.value })} /></label>
          <button className="btn" onClick={() => go('preview')}>{t('预览', 'Preview')}</button>
          <button className="btn primary" onClick={() => go('execute')}>{t('执行', 'Execute')}</button>
        </div>
        {res && <pre className="answer" style={{ marginTop: 12 }}>{JSON.stringify(res, null, 2)}</pre>}
      </div>
      <Note>{t('drop_table 不在目录里，用来演示「目录外一律拒绝」。', 'drop_table is not in the catalog; it is there to show that anything outside the catalog is refused.')}</Note>
      <h2 className="sec">{t('处置日志', 'Remediation journal')}</h2>
      <div className="card" style={{ padding: 16, overflowX: 'auto' }}>
        <table className="tbl"><thead><tr><th>{t('时间', 'Time')}</th><th>{t('级别', 'Tier')}</th><th>{t('动作', 'Action')}</th><th>{t('目标', 'Target')}</th><th>{t('影响', 'Impact')}</th></tr></thead>
          <tbody>{(journal ?? []).map((j, i) => <tr key={i}><td className="dim">{j.ts}</td><td>{j.tier}</td><td><code>{j.action}</code></td><td>{j.target}</td><td className="dim">{j.impact}</td></tr>)}
            {journal && !journal.length && <tr><td colSpan={5} className="dim">{t('暂无', 'Empty')}</td></tr>}</tbody></table>
      </div>
    </article>
  )
}

type RunRow = { ts: string; mode: string; category: string | null; scenario: string | null; seconds: number; steps: number; prompt_tokens: number; completion_tokens: number; traceability: number | null; changes: unknown[] }

export function RunsPage() {
  const t = useT()
  const en = useLang() === 'en'
  const runs = usePoll<RunRow[]>('runs?n=100', 5000)
  return (
    <article>
      <p className="eyebrow">Runs</p>
      <h1>{t('运行记录', 'Runs')}</h1>
      <p className="lead">{t('网页上发起的每一次诊断都记在这里（评测批次另存于 evals/results）。', 'Every diagnosis started from this site is recorded here (evaluation batches live in evals/results).')}</p>
      <div className="card" style={{ padding: 16, overflowX: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>{t('时间', 'Time')}</th><th>{t('模式', 'Mode')}</th><th>{t('注入', 'Injected')}</th><th>{t('结论', 'Verdict')}</th>
            <th className="num">{t('步', 'Steps')}</th><th className="num">s</th><th className="num">tokens</th><th className="num">{t('可追溯', 'Trace')}</th></tr></thead>
          <tbody>{(runs ?? []).map((r, i) => {
            const hit = r.scenario ? r.category === r.scenario : null
            return (
              <tr key={i}><td className="dim">{r.ts.replace('T', ' ')}</td>
                <td><span className={`tag ${r.mode === 'skills' ? 'g' : 'p'}`}>{r.mode}</span></td>
                <td>{r.scenario ?? '—'}</td>
                <td className={hit === null ? '' : hit ? 'up' : 'down'}>{catLabel(r.category, en)}{hit === null ? '' : hit ? ' ✓' : ' ✗'}</td>
                <td className="num">{r.steps}</td><td className="num">{r.seconds}</td>
                <td className="num">{(r.prompt_tokens + r.completion_tokens).toLocaleString()}</td>
                <td className="num">{pct(r.traceability)}</td></tr>
            )
          })}</tbody>
        </table>
      </div>
    </article>
  )
}
