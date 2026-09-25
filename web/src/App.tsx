import { useEffect, useState } from 'react'
import { usePoll, type Bench, type Health } from './api'
import { setLang, useLang, useT } from './i18n'
import Lab from './pages/Lab'
import Plant from './pages/Plant'
import { DesignPage, WorkloadPage } from './pages/Design'
import { BenchPage, RunsPage, SafetyPage, SkillsPage, pct } from './pages/Other'
import './App.css'

const sections = [
  { id: 'lab', title: '故障实验室', en: 'Fault lab' },
  { id: 'workload', title: '负载报告', en: 'Workload report' },
  { id: 'plant', title: '工业时序', en: 'Plant (TDengine)' },
  { id: 'design', title: '智能体设计', en: 'Agent design' },
  { id: 'skills', title: 'Agent Skills', en: 'Agent Skills' },
  { id: 'bench', title: '评测对照', en: 'Benchmark' },
  { id: 'safety', title: '安全与处置', en: 'Safety' },
  { id: 'runs', title: '运行记录', en: 'Runs' },
]

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1))
  useEffect(() => {
    const on = () => { setHash(location.hash.slice(1)); window.scrollTo(0, 0) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

export default function App() {
  const hash = useHash()
  const lang = useLang()
  const t = useT()
  const h = usePoll<Health>('health', 4000)
  const current = sections.find(s => s.id === hash)
  return (
    <div className="layout">
      <header className="topbar">
        <a href="#" className="logo"><img src="./favicon.svg" alt="" width="24" height="24" />SparkDBA</a>
        <div className="topbar-stat">
          <span>{h?.gpu?.name ?? 'DGX Spark'}</span>
          <span className="counter">{h?.gpu?.util ?? '–'}% GPU</span>
          <span className="counter">{h?.llm?.decode_tok_s ?? '–'} tok/s</span>
          <span className="counter">{h?.gpu?.mem_used_gb ?? '–'}/{h?.gpu?.mem_total_gb ?? '–'} GB</span>
          <span className={h?.model ? 'up' : 'down'}>● {h?.model ? 'nemotron' : t('模型离线', 'model offline')}</span>
          <button className="btn-ghost lang" onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}>{lang === 'en' ? '中文' : 'EN'}</button>
        </div>
      </header>
      <nav className="sidenav" aria-label={t('章节', 'Sections')}>
        <a href="#" className={!current ? 'active' : ''}>{t('总览', 'Overview')}</a>
        {sections.map((s, i) => (
          <a key={s.id} href={`#${s.id}`} className={current?.id === s.id ? 'active' : ''}>
            <span className="num">{i + 1}</span>{lang === 'en' ? s.en : s.title}
          </a>
        ))}
      </nav>
      <main className="main">
        {hash === 'lab' ? <Lab /> : hash === 'workload' ? <WorkloadPage /> : hash === 'plant' ? <Plant /> : hash === 'design' ? <DesignPage /> : hash === 'skills' ? <SkillsPage /> : hash === 'bench' ? <BenchPage />
          : hash === 'safety' ? <SafetyPage /> : hash === 'runs' ? <RunsPage /> : <Home h={h} />}
      </main>
    </div>
  )
}

type Run = { ts: string; mode: string; category: string | null; scenario: string | null; seconds: number; steps: number }

function Home({ h }: { h: Health | null }) {
  const lang = useLang()
  const t = useT()
  const b = usePoll<Bench>('bench')
  const runs = usePoll<Run[]>('runs?n=8', 5000)
  const s = b?.modes?.skills, base = b?.modes?.baseline
  return (
    <>
      <section className="hero">
        <div>
          <p className="hero-sql">
            SELECT <b>root_cause</b> FROM <span className="counter">pg_stat_activity</span><br />
            <span className="dim">-- Nemotron 3.5 · NVFP4 · GB10 · {t('离线', 'offline')}</span>
          </p>
          {lang === 'en'
            ? <h1>A database that<br /><em>diagnoses itself</em><br />on the Spark</h1>
            : <h1>让数据库<br /><em>自己诊断</em><br />就在 Spark 上</h1>}
          <p className="lead">{t(
            '向 PostgreSQL 与 TDengine 工厂遥测注入真实故障，Agent 用九个 Agent Skills 取证、定位根因、分级处置。模型、数据与评测全部在 DGX Spark 本地运行，数据不出机房。可在内置、OpenClaw、Hermes 三种编排框架间切换。',
            'Inject real faults into PostgreSQL and into TDengine plant telemetry. The agent uses nine Agent Skills to collect evidence, find the root cause and remediate under approval tiers. Model, data and evals all run locally on the DGX Spark; nothing leaves the box. Switch between the built-in, OpenClaw and Hermes harnesses.')}</p>
          <div className="toolbar"><a className="btn primary" href="#lab">{t('打开故障实验室 →', 'Open the fault lab →')}</a>
            <a className="btn" href="#bench">{t('看评测对照', 'See the benchmark')}</a></div>
        </div>
        <div className="card feed">
          <div className="feed-title">{t('Agent ', 'What the agent did ')}<b>{t('刚刚', 'recently')}</b>{t(' 做了什么', '')}</div>
          <ul>
            {(runs ?? []).map((r, i) => (
              <li key={i}>
                <span className="dot" style={{ background: r.mode === 'skills' ? 'var(--accent)' : 'var(--accent-2)' }} />
                <span className="dim counter">{r.ts.slice(11, 19)}</span>
                {r.mode === 'skills' ? 'skills' : 'baseline'} → <b>{r.category ?? '—'}</b>
                <span className="dim">{r.scenario ? `(${t('注入', 'injected')} ${r.scenario})` : ''} {r.steps} {t('步', 'steps')} · {r.seconds}s</span>
              </li>
            ))}
            {runs && !runs.length && <li className="dim">{t('还没有运行记录', 'No runs yet')}</li>}
          </ul>
          <div className="feed-note">{h?.chaos?.active && !h.chaos.done ? <>{t('正在注入', 'Injecting')} <b>{h.chaos.active}</b> · {h.chaos.elapsed}s · </> : null}
            <a href="#runs">{t('全部记录 →', 'All runs →')}</a></div>
        </div>
      </section>

      <section className="card launch-film" aria-label={t('演示视频', 'Demo film')}>
        <div className="launch-copy">
          <h2>{t('演示视频', 'Demo film')}</h2>
          <p className="dim">{t('3 分钟走完故障实验室、负载报告、工业时序、智能体设计、技能、评测与安全。全程站点真实录屏，诊断均为真实运行，配中文旁白与字幕。',
            'Fault lab, workload report, plant telemetry, agent design, skills, benchmark and safety in under 3 minutes. Real screen recordings of this site with live diagnoses, English narration and subtitles.')}</p>
        </div>
        <video key={lang} controls playsInline preload="none" poster={`./media/poster-${lang}.jpg`}>
          <source src={`./media/sparkdba-demo-${lang}.mp4`} type="video/mp4" />
        </video>
      </section>

      <section className="stats">
        <div className="card stat"><div className="k">{t('数据库根因 · 有技能', 'Database root cause · skills')}</div>
          <div className="v">{pct(s?.diagnosis_accuracy)}<small>{t('基线', 'baseline')} {pct(base?.diagnosis_accuracy)}</small></div></div>
        <div className="card stat"><div className="k">{t('工业时序根因 · 有技能', 'Plant root cause · skills')}</div>
          <div className="v">{pct(s?.plant_accuracy)}<small>{t('基线', 'baseline')} {pct(base?.plant_accuracy)}</small></div></div>
        <div className="card stat"><div className="k">{t('负向用例通过率', 'Negative cases passed')}</div>
          <div className="v">{pct(s?.negative_pass_rate)}<small>{t('基线', 'baseline')} {pct(base?.negative_pass_rate)}</small></div></div>
        <div className="card stat"><div className="k">{t('单次诊断耗时', 'Seconds per diagnosis')}</div>
          <div className="v">{s?.avg_seconds ?? '–'}<small>s · {t('基线', 'baseline')} {base?.avg_seconds ?? '–'}</small></div></div>
      </section>

      <h2 className="sec">{t('一次诊断的流水线', 'One diagnosis, end to end')}</h2>
      <div className="pipe">
        <span>{t('注入故障', 'inject fault')}</span><i>→</i><span className="tag g">pg-evidence-snapshot</span><i>→</i>
        <span className="tag g">pg-root-cause</span><i>→</i><span>CATEGORY + {t('证据', 'evidence')}</span><i>→</i>
        <span className="tag p">pg-safe-remediation</span><i>→</i><span>{t('A 自动 / B 确认 / C 复述目标', 'A auto / B confirm / C repeat target')}</span>
      </div>

      <section className="grid">
        {sections.map((x, i) => (
          <a key={x.id} href={`#${x.id}`} className="card tile">
            <span className="num">{String(i + 1).padStart(2, '0')}</span>
            <h2>{lang === 'en' ? x.en : x.title}</h2>
            <p>{({
              lab: t('6 种可复现故障，同一模型有/无技能并排诊断。', 'Six reproducible faults; the same model diagnoses with and without skills, side by side.'),
              workload: t('KWR / KSH / KDDM 的 PostgreSQL 版：快照、每秒会话历史、Top-5 判定。', 'KWR / KSH / KDDM for PostgreSQL: snapshots, per-second session history, Top-5 judgment.'),
              plant: t('TDengine 工厂遥测：1 个连接器 + 4 位顾问（洞察、实时监控、看板、根因）。', 'TDengine plant telemetry: 1 connector + 4 advisors (insight, real-time monitors, dashboards, root cause).'),
              design: t('每个智能体的感知、规划与推理、工具、记忆。', 'Perception, planning & reasoning, tools and memory for each agent.'),
              skills: t('SKILL.md + scripts + evals + BENCHMARK + skill card，OpenClaw 可发现。', 'SKILL.md + scripts + evals + BENCHMARK + skill card, discoverable by OpenClaw.'),
              bench: t('有技能 vs 无技能：准确率、负向用例、步数、耗时、token。', 'With vs without skills: accuracy, negative cases, steps, time, tokens.'),
              safety: t('只读角色、SQL 护栏、A/B/C 三级审批、处置日志。', 'Read-only role, SQL guard, A/B/C approval tiers, remediation journal.'),
              runs: t('每次运行都留痕，失败也保留。', 'Every run is recorded, failures included.'),
            } as Record<string, string>)[x.id]}</p>
          </a>
        ))}
      </section>
    </>
  )
}
