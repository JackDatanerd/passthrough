import { useEffect, useRef, useState } from 'react'

// Seconds since `startIso` (falls back to when the component mounted if the
// timestamp is missing or unparseable). Anchoring to the server's timestamp keeps
// the steps in the right place after a refresh; clamped so client clock skew
// can never produce a negative or "future" start.
export default function useElapsedSeconds(startIso, tickMs = 500) {
  const mountedAt = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(id)
  }, [tickMs])
  const parsed = startIso ? Date.parse(startIso) : NaN
  const start = Number.isFinite(parsed) ? Math.min(parsed, now) : mountedAt.current
  return Math.max(0, (now - start) / 1000)
}

// The server's own report of where the job is can only NARROW the clock's guess: it sets a floor (the job has
// definitely reached this far) and a ceiling (it definitely has not got further). `gate` is [floor, ceiling] for the
// reported stage, or undefined when there is none / it is a value this build does not know, in which case the
// clock alone decides.
export function gateStep(paced, gate) {
  if (!Array.isArray(gate)) return paced
  return Math.min(gate[1], Math.max(gate[0], paced))
}

// Index of the step that is "current" for the elapsed time. The last step is
// never completed here: it stays current until the server reports the real result.
export function currentStep(elapsedSeconds, thresholds) {
  let idx = 0
  thresholds.forEach((t, i) => { if (elapsedSeconds >= t) idx = i })
  return idx
}
