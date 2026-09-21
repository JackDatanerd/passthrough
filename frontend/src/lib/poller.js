// Self-scheduling poller (replaces `setInterval(fetchScan, 2500)`).
//
// Why not setInterval:
//  - it fired every 2.5s forever, even in a background tab, burning the
//    per-IP rate-limit budget for the whole app;
//  - it never slowed down — a fix that takes 90s made ~36 requests;
//  - ticks could overlap: a slow response was still in flight when the next
//    request fired, and an OLD response could land after a newer one;
//  - after a failure it kept hammering at the same rate.
//
// This one: runs ticks strictly one at a time; slows down as a job ages;
// backs off exponentially while `fn` keeps failing; and pauses while the tab
// is hidden, polling again immediately when it becomes visible.
//
// `fn` may return `false` (or throw) to signal a failed tick.
const DEFAULT_SCHEDULE = [[60_000, 2500], [180_000, 5000], [Infinity, 10_000]]

export function delayFor(elapsedMs, failures, { schedule = DEFAULT_SCHEDULE, maxBackoffMs = 30_000 } = {}) {
  const base = (schedule.find(([until]) => elapsedMs < until) || schedule[schedule.length - 1])[1]
  return failures > 0 ? Math.min(base * 2 ** Math.min(failures, 6), maxBackoffMs) : base
}

export function createPoller(fn, opts = {}) {
  const {
    now = () => Date.now(),
    setTimer = (f, ms) => setTimeout(f, ms),
    clearTimer = t => clearTimeout(t),
    isHidden = () => typeof document !== 'undefined' && document.hidden,
    onVisibilityChange = cb => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', cb)
      return () => document.removeEventListener('visibilitychange', cb)
    },
    schedule, maxBackoffMs,
  } = opts

  let timer = null, running = false, inFlight = false, failures = 0, startedAt = 0, unsubscribe = null, generation = 0

  async function tick(myGeneration) {
    timer = null
    if (!running || myGeneration !== generation) return
    if (isHidden()) return                       // paused; the visibility listener resumes us
    inFlight = true
    let ok = true
    try { ok = (await fn()) !== false } catch (_) { ok = false }
    inFlight = false
    if (!running || myGeneration !== generation) return   // stopped/restarted while in flight
    failures = ok ? 0 : failures + 1
    scheduleNext(myGeneration)
  }

  function scheduleNext(myGeneration) {
    if (!running || myGeneration !== generation) return
    timer = setTimer(() => tick(myGeneration), delayFor(now() - startedAt, failures, { schedule, maxBackoffMs }))
  }

  function handleVisibility() {
    if (!running || isHidden() || inFlight || timer !== null) return
    tick(generation)                              // tab came back — check right away
  }

  return {
    start({ immediate = true } = {}) {
      this.stop()
      running = true; failures = 0; startedAt = now(); generation++
      unsubscribe = onVisibilityChange(handleVisibility)
      if (immediate) tick(generation)
      else scheduleNext(generation)
    },
    stop() {
      running = false; generation++
      if (timer !== null) { clearTimer(timer); timer = null }
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
    },
    get running() { return running },
  }
}
