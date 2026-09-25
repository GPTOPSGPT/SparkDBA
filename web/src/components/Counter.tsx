import { useEffect, useState } from 'react'

// Ticking big number, like OSSInsight's event counter.
export function Counter({ start, perSec }: { start: number; perSec: number }) {
  const [n, setN] = useState(start)
  useEffect(() => {
    const t0 = performance.now()
    let raf = 0
    const tick = () => {
      setN(Math.floor(start + ((performance.now() - t0) / 1000) * perSec))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [start, perSec])
  return <span className="counter">{n.toLocaleString('en-US')}</span>
}
