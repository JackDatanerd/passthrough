import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

// Shows `target` from the first paint (a crawler, a screenshot, a tab that never scrolls there, or a failed
// animation frame must see the real number, never "0%"). When `active` first turns true it restarts from 0
// and counts up — the reset happens in a layout effect, i.e. BEFORE that frame is painted, so there is no
// flash of the final value. Motion off, or no IntersectionObserver: it simply stays at `target`.
export function useCountUp(target, active, ms = 1100) {
  const [n, setN] = useState(target)
  const raf = useRef(0)
  const animate = typeof IntersectionObserver !== 'undefined' && !reduced()
  useLayoutEffect(() => {
    if (!active || !animate) { setN(target); return undefined }
    setN(0)
    const start = performance.now()
    const tick = (now) => {
      const p = Math.min((now - start) / ms, 1)
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, active, animate, ms])
  return n
}
