import { useEffect, useState } from 'react'

// Phones only: once the scan card has scrolled up out of view, a bar keeps the one action one tap away.
// Hidden again when the card (or, further down, the final call to action) is on screen.
export default function StickyScanCta() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined
    const card = document.getElementById('scan-form')
    const final = document.getElementById('final-cta')
    if (!card) return undefined
    // Shown once the scan card has scrolled away above the viewport, and hidden again while the closing call to
    // action (which says the same thing, bigger) is on screen.
    const state = { passed: false, atFinal: false }
    const apply = () => setShow(state.passed && !state.atFinal)
    const a = new IntersectionObserver(([e]) => { state.passed = !e.isIntersecting && e.boundingClientRect.top < 0; apply() }, { threshold: 0 })
    a.observe(card)
    let b = null
    if (final) { b = new IntersectionObserver(([e]) => { state.atFinal = e.isIntersecting; apply() }, { threshold: 0 }); b.observe(final) }
    return () => { a.disconnect(); b?.disconnect() }
  }, [])
  return (
    <div aria-hidden={!show} className={`sm:hidden fixed inset-x-0 bottom-0 z-40 bg-white border-t border-gray-200 px-4 pt-2.5 flex items-center gap-3 transition-transform duration-200 ${show ? 'translate-y-0' : 'translate-y-full'}`}
      style={{ paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom, 0px))' }}>
      <span className="flex-1 text-xs text-gray-600 leading-snug"><b className="text-gray-900">Free ATS scan</b><br />About 30 seconds</span>
      <a href="#scan-form" tabIndex={show ? 0 : -1} className="bg-blue-700 text-white text-sm font-semibold px-4 py-2.5 rounded-lg whitespace-nowrap">Scan now</a>
    </div>
  )
}
