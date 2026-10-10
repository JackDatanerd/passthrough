import { useEffect, useRef, useState } from 'react'

// True once the element has scrolled into view (and stays true). Without IntersectionObserver (old
// browsers, jsdom) or with prefers-reduced-motion, content is simply shown — nothing is ever hidden
// waiting for an animation that cannot run.
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function useReveal({ threshold = 0.15 } = {}) {
  const ref = useRef(null)
  const [shown, setShown] = useState(() => typeof IntersectionObserver === 'undefined' || reduced())
  useEffect(() => {
    if (shown) return undefined
    const el = ref.current
    if (!el) return undefined
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setShown(true); io.disconnect() }
    }, { threshold })
    io.observe(el)
    return () => io.disconnect()
  }, [shown, threshold])
  return [ref, shown]
}

// Counts from 0 to `target` once `active`; shows `target` straight away when motion is off.
export function useCountUp(target, active, ms = 1100) {
  const [n, setN] = useState(() => (typeof IntersectionObserver === 'undefined' || reduced() ? target : 0))
  const raf = useRef(0)
  useEffect(() => {
    if (!active) return undefined
    if (typeof IntersectionObserver === 'undefined' || reduced()) { setN(target); return undefined }
    const start = performance.now()
    const tick = (now) => {
      const p = Math.min((now - start) / ms, 1)
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, active, ms])
  return n
}
