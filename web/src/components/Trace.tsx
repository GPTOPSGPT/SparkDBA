import type { AgentEvent } from '../api'
import { useT } from '../i18n'

const CATS: Record<string, [string, string]> = {
  lock_contention: ['锁竞争', 'Lock contention'],
  idle_in_transaction: ['长事务未提交', 'Idle in transaction'],
  table_bloat: ['表膨胀', 'Table bloat'],
  connection_storm: ['连接堆积', 'Connection storm'],
  missing_index: ['缺失索引', 'Missing index'],
  healthy: ['健康', 'Healthy'],
  overheating: ['设备过热', 'Overheating'],
  bearing_wear: ['轴承磨损', 'Bearing wear'],
  low_pressure: ['气压不足', 'Low pressure'],
  device_offline: ['设备离线', 'Device offline'],
  stuck_sensor: ['传感器卡死', 'Stuck sensor'],
}

export function catLabel(c: string | null | undefined, en: boolean) {
  if (!c) return en ? 'no verdict' : '无结论'
  return CATS[c] ? CATS[c][en ? 1 : 0] : c
}

function argText(e: AgentEvent) {
  const a = e.args ?? {}
  if (e.tool === 'run_sql' || e.tool === 'td_sql' || e.tool === 'request_change') return String(a.sql ?? '')
  if (e.tool === 'route') return `→ ${((a.skills as string[]) ?? []).join(', ') || 'none'}`
  if (e.tool === 'run_skill') return `${a.name} ${((a.args as string[]) ?? []).join(' ')}`
  return String(a.name ?? '')
}

/** Live agent trace: every tool call with timing, then the answer and the verdict. */
export function Trace({ title, events, running, expect, expectDevice, tone }: {
  title: string; events: AgentEvent[]; running: boolean; expect?: string | null; expectDevice?: string | null; tone: 'g' | 'p'
}) {
  const t = useT()
  const en = t('', 'en') === 'en'
  const done = events.find(e => e.type === 'done')
  const answer = events.find(e => e.type === 'answer')
  const err = events.find(e => e.type === 'error')
  const hit = done && expect ? done.category === expect && (expectDevice === undefined || done.device === expectDevice) : null
  return (
    <div className="card trace">
      <h3>{running && <span className="pulse" />}<span className={`tag ${tone}`}>{title}</span>
        {done && <span className="dim">{done.steps} {t('步', 'steps')} · {done.seconds}s · {((done.prompt_tokens ?? 0) + (done.completion_tokens ?? 0)).toLocaleString()} tokens</span>}
      </h3>
      <ol>
        {events.filter(e => e.type === 'tool').map((e, i) => (
          <li key={i}>
            <span className="t">{e.t?.toFixed(1)}s</span>
            <div>
              <b>{e.tool}</b> <code>{argText(e).slice(0, 160)}</code>
              <details><summary>{t('结果', 'result')} · {e.ms}ms</summary><pre>{e.result}</pre></details>
            </div>
          </li>
        ))}
        {!events.length && <li className="dim"><span /> {t('等待运行', 'Waiting to run')}</li>}
      </ol>
      {err && <p className="down">{err.text}</p>}
      {answer && <pre className="answer">{answer.text}</pre>}
      {done && (
        <div className="verdict">
          <span className={`tag ${hit === null ? '' : hit ? 'g' : 'p'}`}>
            CATEGORY: {catLabel(done.category, en)}{done.device ? ` · ${done.device}` : ''}{hit === null ? '' : hit ? ' ✓' : ' ✗'}
          </span>
          {done.traceability != null && <span className="tag c">{t('证据可追溯', 'traceable')} {Math.round(done.traceability * 100)}%</span>}
          {done.changes && done.changes.length > 0 && <span className="tag p">{t('变更尝试', 'change attempts')} {done.changes.length}</span>}
        </div>
      )}
    </div>
  )
}
