import { Fragment, useLayoutEffect, useState } from 'react'

// Types `text` out letter by letter, once, with a caret that follows the last letter and then fades.
//
// Built so the effect can never cost the page anything:
//   - the full sentence is ALWAYS in the DOM as real text (sr-only); the animated copy is aria-hidden, so a screen
//     reader / crawler reads one clean sentence, never letters.
//   - every letter keeps its space (opacity, not display), so typing never reflows the headline or what is under it.
//   - nothing animates for people who ask for reduced motion, and it plays once per browser session (a returning
//     visitor, or someone who goes Home -> Pricing -> Home, sees the finished line immediately).
//   - the first render is the finished line, and the effect is armed in a layout effect before the first paint, so
//     there is no flash and no-JS / a failed script leaves the line readable.
const SESSION_KEY = 'pt:hero-typed'

function shouldAnimate() {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
    if (window.sessionStorage.getItem(SESSION_KEY)) return false
  } catch (_) { /* storage blocked: still animate once per load */ }
  return true
}

export default function TypedText({ text, className = '', startDelay = 500 }) {
  const chars = Array.from(text)
  // null = finished (or never animated); a number = how many letters are showing so far.
  const [shown, setShown] = useState(null)
  const [caret, setCaret] = useState(false)

  useLayoutEffect(() => {
    if (!shouldAnimate()) return undefined
    try { window.sessionStorage.setItem(SESSION_KEY, '1') } catch (_) { /* ignore */ }
    const timers = []
    let n = 0
    setShown(0)
    setCaret(true)
    const step = () => {
      n += 1
      setShown(n)
      if (n < chars.length) {
        timers.push(setTimeout(step, 45 + Math.random() * 55))
      } else {
        setShown(null)
        // keep the caret through three blinks, then remove it (the CSS animation fades it first)
        timers.push(setTimeout(() => setCaret(false), 2800))
      }
    }
    timers.push(setTimeout(step, startDelay))
    return () => timers.forEach(clearTimeout)
  }, [text, startDelay])   // eslint-disable-line react-hooks/exhaustive-deps

  const typing = shown !== null
  const caretAt = typing ? shown : chars.length
  const caretEl = caret && (
    <span
      key="caret"
      className={`inline-block w-[0.07em] h-[0.85em] -mr-[0.09em] ml-[0.02em] align-[-0.06em] rounded-[1px] bg-blue-700 ${typing ? 'animate-caret-blink' : 'animate-caret-done'}`}
    />
  )

  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {chars.map((c, i) => (
          <Fragment key={i}>
            {caretAt === i && caretEl}
            <span style={typing && i >= shown ? { opacity: 0 } : undefined}>{c}</span>
          </Fragment>
        ))}
        {caretAt === chars.length && caretEl}
      </span>
    </span>
  )
}
