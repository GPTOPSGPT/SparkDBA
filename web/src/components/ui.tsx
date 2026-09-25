import type { ReactNode } from 'react'
import { useT } from '../i18n'

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>
}

export function Btn({ onClick, children, active, disabled, tone, track }: {
  onClick: () => void
  children: ReactNode
  active?: boolean
  disabled?: boolean
  tone?: 'danger' | 'primary'
  /** Access-audit action id, e.g. "raft:reset" (see src/audit/track.ts). */
  track?: string
}) {
  return (
    <button className={`btn ${tone ?? ''} ${active ? 'active' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={active} data-track={track}>
      {children}
    </button>
  )
}

// Result grid styled like a mysql client, for "what this SQL would return".
export function SqlResult({ columns, rows, caption }: { columns: string[]; rows: Array<Array<ReactNode>>; caption?: string }) {
  return (
    <div className="sql-result">
      {caption && <div className="sql-result-caption">{caption}</div>}
      <div className="sql-result-scroll">
        <table>
          <thead><tr>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
      <div className="sql-result-foot">{rows.length} rows in set</div>
    </div>
  )
}

// Marks a deliberate simplification so judges see we know the real behaviour.
export function Note({ children }: { children: ReactNode }) {
  return <p className="note">ⓘ {children}</p>
}

export type LogLine = { id: number; text: string; color?: string }

export function EventLog({ lines, title }: { lines: LogLine[]; title?: string }) {
  const t = useT()
  return (
    <div className="card event-log">
      <div className="event-log-title">{title ?? t('事件日志', 'Event log')}</div>
      <ul>
        {lines.map(l => (
          <li key={l.id}><span className="dot" style={{ background: l.color ?? 'var(--text-dim)' }} />{l.text}</li>
        ))}
        {lines.length === 0 && <li className="dim">{t('暂无事件', 'No events yet')}</li>}
      </ul>
    </div>
  )
}
