import { useState } from 'react'
import { diagnose, post, usePoll, type AgentEvent, type ChaosStatus, type Scenario } from '../api'
import { Trace } from '../components/Trace'
import { HarnessPicker, type Harness } from './Plant'
import { Note } from '../components/ui'
import { useLang, useT } from '../i18n'

export default function Lab() {
  const t = useT()
  const en = useLang() === 'en'
  const scen = usePoll<Scenario[]>('scenarios')
  const st = usePoll<ChaosStatus>('chaos/status', 2000)
  const [pick, setPick] = useState('idle_in_transaction')
  // Traces are kept per fault, so clicking a card shows that fault's last side-by-side run.
  const [runs, setRuns] = useState<Record<string, { skills: AgentEvent[]; baseline: AgentEvent[]; expect: string | null }>>({})
  const [running, setRunning] = useState<Record<string, string>>({})   // mode -> fault it is diagnosing
  const [msg, setMsg] = useState('')
  const [harness, setHarness] = useState<Harness>('builtin')

  const active = st?.active && !st.done ? st.active : null
  const busy = Object.keys(running).length > 0
  const view = runs[pick]
  const pickName = (s => s ? (en ? s.en : s.name) : pick)(scen?.find(s => s.id === pick))

  async function inject() {
    setMsg('')
    const r = await post<{ ok: boolean; error?: string }>('chaos/start', { id: pick, params: { duration: 300 } })
    if (!r.ok) setMsg(r.error ?? 'failed')
  }

  async function run(mode: 'skills' | 'baseline') {
    const key = active ?? pick                 // file the run under the fault that is live now
    const put = (ev: AgentEvent[]) => setRuns(r => ({
      ...r, [key]: { ...(r[key] ?? { skills: [], baseline: [] }), expect: active, [mode]: ev } }))
    setPick(key); put([]); setRunning(r => ({ ...r, [mode]: key }))
    const acc: AgentEvent[] = []
    await diagnose({ mode, harness: mode === 'skills' ? harness : 'builtin' }, e => { acc.push(e); put([...acc]) })
    setRunning(({ [mode]: _, ...r }) => r)
  }

  // Concurrent: both see the same fault at the same moment; the server allows two runs and vLLM batches them.
  function both() { run('skills'); run('baseline') }

  return (
    <article>
      <p className="eyebrow">Fault lab</p>
      <h1>{t('故障实验室', 'Fault lab')}</h1>
      <p className="lead">{t(
        '选一种故障注入到本机 PostgreSQL 16，然后让同一个 Nemotron 模型分别在「有技能」和「无技能」下诊断。标准答案就是注入的故障。',
        'Pick a fault and inject it into the local PostgreSQL 16, then let the same Nemotron model diagnose with and without skills. The ground truth is the fault you injected.')}</p>

      <section className="grid" style={{ margin: '24px 0' }}>
        {(scen ?? []).map(s => (
          <button key={s.id} className={`card scen ${pick === s.id ? 'on' : ''}`} onClick={() => setPick(s.id)} aria-pressed={pick === s.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3>{en ? s.en : s.name}</h3>
              {active === s.id && <span className="tag p">{t('注入中', 'live')}</span>}
            </div>
            <p>{en ? s.desc : s.desc_zh ?? s.desc}</p>
            <span className="tag">{s.id}</span>
          </button>
        ))}
      </section>

      <div className="toolbar">
        <button className="btn primary" onClick={inject} disabled={!!active}>{t(`注入「${pickName}」`, `Inject “${pickName}”`)}</button>
        <button className="btn danger" onClick={() => post('chaos/stop', {})} disabled={!active}>{t('停止', 'Stop')}</button>
        <span className="dim">{active
          ? <>{t('正在注入', 'Injecting')} <b>{active}</b> · {st?.elapsed}s · {st?.ready ? t('已就绪，可以诊断', 'ready to diagnose') : t('预热中…', 'warming up…')}</>
          : t('当前无故障注入：选一张卡片，再点注入', 'No fault active: pick a card, then inject')}</span>
        {msg && <span className="down">{msg}</span>}
      </div>

      <HarnessPicker value={harness} onChange={setHarness} />
      <div className="toolbar">
        <button className="btn active" onClick={() => run('skills')} disabled={!!running.skills}>{t('诊断 · 有技能', 'Diagnose · with skills')}</button>
        <button className="btn" onClick={() => run('baseline')} disabled={!!running.baseline}>{t('诊断 · 无技能基线', 'Diagnose · baseline')}</button>
        <button className="btn primary" onClick={both} disabled={busy}>{t('两个都跑，并排对比', 'Run both, side by side')}</button>
      </div>

      <p className="dim">{t(`下方为「${pickName}」的诊断`, `Diagnoses below are for “${pickName}”`)}
        {view && !busy && view.expect !== pick && ' · ' + t('上次运行时该故障未注入', 'this fault was not live when it last ran')}</p>
      <div className="cols-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <Trace title={harness === 'builtin' ? t('有技能', 'With skills') : `${t('有技能', 'With skills')} · ${harness}`} tone="g"
          events={view?.skills ?? []} running={running.skills === pick} expect={view?.expect} />
        <Trace title={t('无技能基线', 'Baseline')} tone="p" events={view?.baseline ?? []} running={running.baseline === pick} expect={view?.expect} />
      </div>

      {st?.log && st.log.length > 0 && (
        <div className="card event-log"><div className="event-log-title">{t('注入日志', 'Injection log')}</div>
          <ul>{st.log.map((l, i) => <li key={i}><span className="dot" style={{ background: 'var(--accent-2)' }} />{l}</li>)}</ul></div>
      )}
      <Note>{t(
        '两种模式使用同一模型、同一任务文本、同样的 run_sql / request_change 工具；唯一差别是是否加载 Agent Skills。注入会话使用中性应用名（shop-api / batch-job），模型不能从名字读出答案。request_change 只记录不执行。',
        'Both modes use the same model, task text and run_sql / request_change tools; the only difference is whether Agent Skills are loaded. Injected sessions use neutral application names (shop-api / batch-job) so the answer cannot be read off a name. request_change records and never executes.')}</Note>
    </article>
  )
}
