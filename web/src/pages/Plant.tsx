import { useState } from 'react'
import { diagnose, post, usePoll, type AgentEvent } from '../api'
import { EChart } from '../components/EChart'
import { Trace } from '../components/Trace'
import { Note } from '../components/ui'
import { useLang, useT } from '../i18n'

type Fault = { id: string; name: string; en: string; device: string | null }
type PlantStatus = { writer: boolean; active: string | null; elapsed: number; duration: number; log: string[] }
type Q = { columns?: string[]; rows?: (string | number | null)[][]; error?: string }
type Series = { device: Q; yield: Q }
type Finding = { severity: number; device?: string; line?: string; kind: string; detail: string }
type Insight = { findings?: Finding[]; summary?: string; yield_pct?: { window: Record<string, number>; baseline: Record<string, number> } }
type Mon = { monitors: Record<string, { selector: Record<string, string>; metric: string; agg: string; op: string; value: number; window: number }>; alerts: { ts: string; monitor: string; device: string; value: number; rule: string }[] }
type Panel = { title: string; chart: string; columns?: string[]; rows?: (string | number)[][] }

export const HARNESSES = ['builtin', 'openclaw', 'hermes'] as const
export type Harness = typeof HARNESSES[number]

export function HarnessPicker({ value, onChange }: { value: Harness; onChange: (h: Harness) => void }) {
  const t = useT()
  const label: Record<Harness, string> = { builtin: t('内置（记录每一步）', 'Built-in (traces every step)'), openclaw: 'OpenClaw', hermes: 'Hermes Agent' }
  return (
    <div className="toolbar" role="radiogroup" aria-label="harness">
      <span className="dim">{t('编排框架', 'Harness')}</span>
      {HARNESSES.map(h => (
        <button key={h} className={`btn ${value === h ? 'active' : ''}`} onClick={() => onChange(h)} aria-pressed={value === h}>{label[h]}</button>
      ))}
    </div>
  )
}

const DEVICES = ['L1', 'L2', 'L3'].flatMap(l => ['press', 'oven', 'compressor', 'conveyor', 'robot'].map(k => `${l}-${k}`))
const line = (name: string, data: [string, number][], color: string) => ({ name, type: 'line', showSymbol: false, smooth: true, data, lineStyle: { width: 2, color }, itemStyle: { color } })

export default function Plant() {
  const t = useT()
  const en = useLang() === 'en'
  const faults = usePoll<Fault[]>('plant/faults')
  const st = usePoll<PlantStatus>('plant/status', 2000)
  const [pick, setPick] = useState('overheating')
  const [device, setDevice] = useState('L2-oven')
  const [metric, setMetric] = useState('temperature')
  const series = usePoll<Series>(`td/series?device=${device}&metric=${metric}&minutes=15`, 10000)
  const insight = usePoll<Insight>('td/insight?minutes=1', 10000)
  const mon = usePoll<Mon>('td/monitors', 10000)
  const dash = usePoll<Record<string, { title: string }>>('td/dashboards', 30000)
  const [harness, setHarness] = useState<Harness>('builtin')
  const [skills, setSkills] = useState<AgentEvent[]>([])
  const [base, setBase] = useState<AgentEvent[]>([])
  const [running, setRunning] = useState({ skills: false, baseline: false })
  const [msg, setMsg] = useState('')

  const active = st?.active ?? null
  const expectDev = faults?.find(f => f.id === active)?.device ?? null

  async function run(mode: 'skills' | 'baseline') {
    const set = mode === 'skills' ? setSkills : setBase
    set([]); setRunning(r => ({ ...r, [mode]: true }))
    const acc: AgentEvent[] = []
    await diagnose({ mode, domain: 'td', harness: mode === 'skills' ? harness : 'builtin' }, e => { acc.push(e); set([...acc]) })
    setRunning(r => ({ ...r, [mode]: false }))
  }

  const yieldRows = series?.yield?.rows ?? []
  const byLine: Record<string, [string, number][]> = {}
  for (const r of yieldRows) (byLine[String(r[1])] ??= []).push([String(r[0]), Number(r[2])])
  const yieldOpt = {
    grid: { left: 44, right: 12, top: 36, bottom: 24 }, legend: { top: 0 }, tooltip: { trigger: 'axis' },
    xAxis: { type: 'time', axisLabel: { hideOverlap: true }, splitNumber: 4, axisLine: { lineStyle: { color: '#2c2d33' } } },
    yAxis: { type: 'value', min: 60, max: 100, splitLine: { lineStyle: { color: '#2c2d33' } }, axisLabel: { formatter: '{value}%' } },
    series: ['L1', 'L2', 'L3'].map((l, i) => line(l, byLine[l] ?? [], ['#76b900', '#ff6b9d', '#6ee7ff'][i])),
  }
  const devOpt = {
    grid: { left: 44, right: 12, top: 30, bottom: 24 }, tooltip: { trigger: 'axis' },
    xAxis: { type: 'time', axisLabel: { hideOverlap: true }, splitNumber: 4, axisLine: { lineStyle: { color: '#2c2d33' } } },
    yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: '#2c2d33' } } },
    series: [line(`${device} ${metric}`, (series?.device?.rows ?? []).map(r => [String(r[0]), Number(r[1])]), '#ffe895')],
  }

  return (
    <article>
      <p className="eyebrow">TDengine · Plant</p>
      <h1>{t('工业时序：1 个连接器 + 4 位顾问', 'Industrial time series: 1 connector + 4 advisors')}</h1>
      <p className="lead">{t(
        '一座模拟工厂每秒向 TDengine 写入 3 条产线、15 台设备的遥测。注入一种设备故障，再让同一个模型在「有技能 / 无技能」下找出是哪台设备、为什么。连接器负责拿到数据，顾问负责知道怎么用数据。',
        'A simulated plant writes telemetry from 3 lines and 15 devices into TDengine every second. Inject a device fault, then let the same model find which device and why, with and without skills. The connector gets the data; the advisors know how to use it.')}</p>

      <div className="pipe">
        <span className="tag c">td-connector</span><i>→</i><span className="tag g">td-insight</span><i>/</i>
        <span className="tag g">td-root-cause</span><i>/</i><span className="tag g">td-realtime-monitor</span><i>/</i><span className="tag g">td-dashboard</span>
      </div>

      <section className="grid" style={{ margin: '16px 0' }}>
        {(faults ?? []).map(f => (
          <button key={f.id} className={`card scen ${pick === f.id ? 'on' : ''}`} onClick={() => setPick(f.id)} aria-pressed={pick === f.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3>{en ? f.en : f.name}</h3>{active === f.id && <span className="tag p">{t('注入中', 'live')}</span>}
            </div>
            <span className="tag">{f.id}</span>
          </button>
        ))}
      </section>
      <div className="toolbar">
        <button className="btn primary" disabled={!!active} onClick={async () => {
          const r = await post<{ ok: boolean; error?: string }>('plant/start', { id: pick, duration: 300 }); setMsg(r.ok ? '' : r.error ?? '')
        }}>{t('注入故障', 'Inject fault')}</button>
        <button className="btn danger" disabled={!active} onClick={() => post('plant/stop', {})}>{t('停止', 'Stop')}</button>
        <span className="dim">{st?.writer ? '● ' : '○ '}{st?.writer ? t('遥测写入中', 'telemetry writing') : t('写入器离线', 'writer offline')}
          {active ? <> · {t('正在注入', 'injecting')} <b>{active}</b> · {st?.elapsed}s</> : null}</span>
        {msg && <span className="down">{msg}</span>}
      </div>

      <div className="cols-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="event-log-title">{t('产线良品率（10 秒窗口）', 'Line yield (10 s windows)')}</div>
          <EChart option={yieldOpt} height={220} />
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="event-log-title">{t('设备指标', 'Device metric')}</div>
            <div className="row">
              <select className="btn" value={device} onChange={e => setDevice(e.target.value)}>{DEVICES.map(d => <option key={d}>{d}</option>)}</select>
              <select className="btn" value={metric} onChange={e => setMetric(e.target.value)}>{['temperature', 'vibration', 'pressure', 'current'].map(m => <option key={m}>{m}</option>)}</select>
            </div>
          </div>
          <EChart option={devOpt} height={220} />
        </div>
      </div>

      <h2 className="sec">{t('诊断：是哪台设备，为什么', 'Diagnose: which device, and why')}</h2>
      <HarnessPicker value={harness} onChange={setHarness} />
      <div className="toolbar">
        <button className="btn active" disabled={running.skills} onClick={() => run('skills')}>{t('诊断 · 有技能', 'Diagnose · with skills')}</button>
        <button className="btn" disabled={running.baseline} onClick={() => run('baseline')}>{t('诊断 · 无技能基线', 'Diagnose · baseline')}</button>
        <button className="btn primary" disabled={running.skills || running.baseline} onClick={() => { run('skills'); run('baseline') }}>{t('两个都跑，并排对比', 'Run both, side by side')}</button>
      </div>
      <div className="cols-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <Trace title={harness === 'builtin' ? t('有技能', 'With skills') : `${t('有技能', 'With skills')} · ${harness}`} tone="g" events={skills}
          running={running.skills} expect={active ? active : null} expectDevice={active ? expectDev : undefined} />
        <Trace title={t('无技能基线', 'Baseline')} tone="p" events={base} running={running.baseline}
          expect={active ? active : null} expectDevice={active ? expectDev : undefined} />
      </div>

      <h2 className="sec">{t('数据洞察顾问 · 最近 1 分钟', 'Insight advisor · last minute')}</h2>
      <div className="card" style={{ padding: 16 }}>
        <p className="dim" style={{ marginTop: 0 }}>{insight?.summary ?? '…'}</p>
        <table className="tbl"><tbody>
          {(insight?.findings ?? []).map((f, i) => (
            <tr key={i}><td><span className={`tag ${f.severity >= 3 ? 'p' : 'c'}`}>{f.kind}</span></td><td><code>{f.device ?? f.line}</code></td><td>{f.detail}</td></tr>
          ))}
        </tbody></table>
      </div>

      <div className="cols-2">
        <div>
          <h2 className="sec">{t('实时分析顾问 · 监控与告警', 'Real-time advisor · monitors and alerts')}</h2>
          <div className="card" style={{ padding: 16 }}>
            <table className="tbl"><tbody>
              {Object.entries(mon?.monitors ?? {}).map(([n, m]) => (
                <tr key={n}><td><code>{n}</code></td><td>{Object.values(m.selector)[0]}</td><td>{m.agg}({m.metric}) {m.op} {m.value} / {m.window}s</td></tr>
              ))}
            </tbody></table>
            <div className="event-log-title" style={{ marginTop: 12 }}>{t('最近告警', 'Recent alerts')}</div>
            <ul className="dim" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {(Array.isArray(mon?.alerts) ? mon!.alerts : []).slice(0, 8).map((a, i) => <li key={i}>{a.ts.slice(11)} <b>{a.monitor}</b> {a.device} = {a.value}</li>)}
            </ul>
          </div>
        </div>
        <div>
          <h2 className="sec">{t('可视化面板顾问', 'Dashboard advisor')}</h2>
          {Object.keys(dash ?? {}).length === 0 && <div className="card" style={{ padding: 16 }}><p className="dim" style={{ margin: 0 }}>{t('还没有面板。对 Agent 说「把 L2 烤箱温度做成看板」即可生成。', 'No panels yet. Ask the agent to "make a dashboard of the L2 oven temperature".')}</p></div>}
          {Object.entries(dash ?? {}).slice(0, 3).map(([id]) => <PanelCard key={id} id={id} />)}
        </div>
      </div>

      <Note>{t('标准答案是注入的设备与故障类型，两者都对才算命中。TDengine OSS 不支持 GRANT，只读由连接器的 SQL 白名单在服务端强制。',
        'Ground truth is the injected device and fault kind; both must match. TDengine OSS has no GRANT, so read-only is enforced server-side by the connector\'s SQL allowlist.')}</Note>
    </article>
  )
}

function PanelCard({ id }: { id: string }) {
  const p = usePoll<Panel>(`td/panel/${id}`, 15000)
  const cols = p?.columns ?? []
  const rows = p?.rows ?? []
  const colors = ['#76b900', '#ff6b9d', '#6ee7ff', '#ffe895']
  const opt = {
    grid: { left: 44, right: 12, top: 24, bottom: 24 }, tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: rows.map(r => String(r[0]).slice(11, 19)), axisLine: { lineStyle: { color: '#2c2d33' } } },
    yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: '#2c2d33' } } },
    series: cols.slice(1).map((c, i) => ({ name: c, type: p?.chart === 'bar' ? 'bar' : 'line', showSymbol: false,
      data: rows.map(r => r[i + 1]), itemStyle: { color: colors[i % 4] } })),
  }
  return <div className="card" style={{ padding: 16, marginBottom: 12 }}><div className="event-log-title">{p?.title ?? id}</div><EChart option={opt} height={180} /></div>
}
