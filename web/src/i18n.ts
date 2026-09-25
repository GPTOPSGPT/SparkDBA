import { useSyncExternalStore } from 'react'

export type Lang = 'zh' | 'en'

// Language comes from ?lang=en, then the viewer's saved choice, then Chinese.
function initial(): Lang {
  const q = new URLSearchParams(location.search).get('lang')
  if (q === 'en' || q === 'zh') return q
  try { return localStorage.getItem('lang') === 'en' ? 'en' : 'zh' } catch { return 'zh' }
}

let lang: Lang = initial()
const listeners = new Set<() => void>()
document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'

export function setLang(next: Lang) {
  lang = next
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN'
  try { localStorage.setItem('lang', next) } catch { /* private mode: in-memory only */ }
  listeners.forEach(l => l())
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, () => lang)
}

/** `const t = useT()` then `t('中文', 'English')`. */
export function useT() {
  const l = useLang()
  return (zh: string, en: string) => (l === 'en' ? en : zh)
}
