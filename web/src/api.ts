import { useEffect, useState } from 'react'

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(`./api/${path}`, { credentials: 'same-origin' })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`./api/${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return r.json()
}

/** Poll an endpoint every `ms` (0 = once). */
export function usePoll<T>(path: string, ms = 0): T | null {
  const [v, setV] = useState<T | null>(null)
  useEffect(() => {
    let live = true
    const tick = () => get<T>(path).then(x => live && setV(x)).catch(() => {})
    tick()
    const id = ms ? setInterval(tick, ms) : 0
    return () => { live = false; if (id) clearInterval(id) }
  }, [path, ms])
  return v
}

export type AgentEvent = {
  type: 'start' | 'tool' | 'answer' | 'done' | 'error'
  t?: number; tool?: string; args?: Record<string, unknown>; result?: string; ms?: number; llm_ms?: number
  text?: string; mode?: string; category?: string | null; steps?: number; seconds?: number
  prompt_tokens?: number; completion_tokens?: number; traceability?: number | null
  changes?: { via: string; sql: string; kind: string }[]
  device?: string | null; harness?: string
}

/** POST /api/diagnose and stream server-sent events. */
export async function diagnose(body: Record<string, unknown>, onEvent: (e: AgentEvent) => void) {
  const r = await fetch('./api/diagnose', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!r.body) return
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      if (chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)))
    }
  }
}

export type Scenario = { id: string; name: string; en: string; desc: string; params: Record<string, number | string>; warmup: number }
export type ChaosStatus = { active: string | null; params?: Record<string, number>; done?: boolean; ready?: boolean; elapsed?: number; log?: string[] }
export type Health = {
  model: string | null; model_path: string; busy: boolean; chaos: ChaosStatus
  llm?: { decode_tok_s?: number | null; requests?: number; generated_tokens?: number; prompt_tokens?: number }
  gpu: { name?: string; util?: string; temp?: string; power?: string; mem_total_gb?: number; mem_used_gb?: number; error?: string }
}
export type ModeSummary = {
  diagnosis_accuracy: number | null; plant_accuracy?: number | null; negative_pass_rate: number | null; unsafe_attempts: number
  traceability: number | null; avg_steps: number | null; avg_seconds: number | null; avg_tokens: number | null
  by_task: Record<string, string>; runs: number
}
export type Bench = { status?: string; meta?: Record<string, string | number>; modes?: Record<string, ModeSummary> }
