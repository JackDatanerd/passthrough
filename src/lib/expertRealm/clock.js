// Experts Phase 2A: job clocks derived from events. A deadline is calendar time from payment with explicit pause intervals (product spec
// 9.3); nothing here keeps a timer. Pure functions: give them events (or pause rows) and a time, they give back the same answer every time.

const ts = v => new Date(v).getTime()
const STARTS = new Set(['question_asked'])
const ENDS = new Set(['question_answered', 'question_expired', 'released'])   // 'released': an unassign ends the wait too

// Pause intervals from a job's events (oldest first by id). Works on Phase 1 events (question_asked ... question_answered / question_expired)
// and on engine events (detail.to / detail.from === 'waiting_customer'). A pause with no end yet has ended = null.
function pausesFromEvents(events) {
  const sorted = [...(events || [])].sort((a, b) => (Number(a.id) - Number(b.id)) || (ts(a.created_at) - ts(b.created_at)))
  const out = []; let open = null
  for (const e of sorted) {
    const d = e.detail || {}
    const starts = STARTS.has(e.kind) || d.to === 'waiting_customer'
    const ends = ENDS.has(e.kind) || d.from === 'waiting_customer'
    if (starts && !open) { open = { started: new Date(ts(e.created_at)).toISOString(), ended: null }; out.push(open) }
    else if (ends && open) { open.ended = new Date(ts(e.created_at)).toISOString(); open = null }
  }
  return out
}

const pausedSeconds = (pauses, now) => (pauses || []).reduce((n, p) => n + Math.max(0, Math.floor(((p.ended ? ts(p.ended) : ts(now)) - ts(p.started)) / 1000)), 0)

// The customer's promise and the internal working deadline: paid time + turnaround (+ every second paused), minus the buffer for internal.
// remainingMs is negative once late. `paused` is true while a pause is open (the clock is stopped).
function clockFrom({ paidAt, turnaroundHours, bufferHours = 0, pauses = [], now }) {
  if (!paidAt || !Number.isFinite(turnaroundHours)) return null
  const paused = pausedSeconds(pauses, now)
  const promised = ts(paidAt) + turnaroundHours * 3600e3 + paused * 1000
  const internal = promised - bufferHours * 3600e3
  const open = (pauses || []).some(p => !p.ended)
  // While a pause is open the promised time keeps moving later by exactly the time paused so far, so the time LEFT stays the same until the answer comes.
  return { promisedAt: new Date(promised).toISOString(), internalAt: new Date(internal).toISOString(), pausedSeconds: paused, paused: open, remainingMs: promised - ts(now) }
}

// Do the stored columns agree with the events? (the invariant "the sum of pause intervals equals paused_seconds", checked on closed pauses)
function reconcile(job, pauses, now) {
  const closed = (pauses || []).filter(p => p.ended)
  const fromEvents = pausedSeconds(closed, now)
  return { ok: fromEvents === (job.paused_seconds || 0), fromEvents, stored: job.paused_seconds || 0 }
}

module.exports = { pausesFromEvents, pausedSeconds, clockFrom, reconcile }
