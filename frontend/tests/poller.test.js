import { describe, it, expect } from 'vitest'
import { createPoller, delayFor } from '../src/lib/poller.js'

// Deterministic fake clock/timers so the schedule can be asserted exactly.
function fakeEnv() {
  let now = 0, id = 0
  const timers = new Map()
  const visibility = new Set()
  const env = {
    now: () => now,
    setTimer: (fn, ms) => { const t = ++id; timers.set(t, { fn, at: now + ms, ms }); return t },
    clearTimer: t => timers.delete(t),
    hidden: false,
    isHidden: () => env.hidden,
    onVisibilityChange: cb => { visibility.add(cb); return () => visibility.delete(cb) },
    pending: () => [...timers.values()].map(t => t.ms),
    async advance(ms) {   // run every timer that comes due, in order, letting async ticks settle
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0]); now = due[1].at
        due[1].fn(); await flush()
      }
      now = target
    },
    fireVisibility() { visibility.forEach(cb => cb()) },
    listeners: () => visibility.size,
  }
  return env
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('delayFor', () => {
  it('slows down as the job ages', () => {
    expect(delayFor(0, 0)).toBe(2500)
    expect(delayFor(59_000, 0)).toBe(2500)
    expect(delayFor(60_000, 0)).toBe(5000)
    expect(delayFor(179_000, 0)).toBe(5000)
    expect(delayFor(180_000, 0)).toBe(10_000)
    expect(delayFor(9_999_999, 0)).toBe(10_000)
  })
  it('backs off exponentially on consecutive failures, capped at 30s', () => {
    expect(delayFor(0, 1)).toBe(5000)
    expect(delayFor(0, 2)).toBe(10_000)
    expect(delayFor(0, 3)).toBe(20_000)
    expect(delayFor(0, 4)).toBe(30_000)
    expect(delayFor(0, 50)).toBe(30_000)
  })
})

describe('createPoller', () => {
  it('ticks immediately on start, then on the schedule', async () => {
    const env = fakeEnv(); let n = 0
    const p = createPoller(async () => { n++ }, env)
    p.start()
    await flush()
    expect(n).toBe(1)
    await env.advance(2500); expect(n).toBe(2)
    await env.advance(2500); expect(n).toBe(3)
    p.stop()
  })
  it('start({immediate:false}) waits for the first interval', async () => {
    const env = fakeEnv(); let n = 0
    const p = createPoller(async () => { n++ }, env)
    p.start({ immediate: false })
    await flush(); expect(n).toBe(0)
    await env.advance(2500); expect(n).toBe(1)
    p.stop()
  })
  it('never overlaps ticks: the next one is scheduled only AFTER the current one finishes', async () => {
    const env = fakeEnv(); let active = 0, maxActive = 0, done = 0
    const p = createPoller(async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); await Promise.resolve(); active--; done++ }, env)
    p.start()
    await flush()            // let the first (async) tick finish and schedule the next one
    await env.advance(60_000)
    expect(maxActive).toBe(1)
    expect(done).toBeGreaterThan(3)
    p.stop()
  })
  it('backs off after failures (false or throw) and recovers to normal cadence after a success', async () => {
    const env = fakeEnv(); const results = [false, new Error('boom'), true]; let i = 0
    const p = createPoller(async () => { const r = results[Math.min(i++, results.length - 1)]; if (r instanceof Error) throw r; return r }, env)
    p.start()
    await flush()
    expect(env.pending()).toEqual([5000])      // after 1 failure
    await env.advance(5000)
    expect(env.pending()).toEqual([10_000])    // after 2nd failure
    await env.advance(10_000)
    expect(env.pending()).toEqual([2500])      // success -> back to base
    p.stop()
  })
  it('stop() cancels the pending tick and unsubscribes from visibility events', async () => {
    const env = fakeEnv(); let n = 0
    const p = createPoller(async () => { n++ }, env)
    p.start(); await flush()
    expect(env.listeners()).toBe(1)
    p.stop()
    expect(env.pending()).toEqual([])
    expect(env.listeners()).toBe(0)
    await env.advance(60_000)
    expect(n).toBe(1)
    expect(p.running).toBe(false)
  })
  it('a stop() during an in-flight tick prevents any further scheduling', async () => {
    const env = fakeEnv(); let release
    const p = createPoller(() => new Promise(r => { release = r }), env)
    p.start(); await flush()
    p.stop()
    release(true); await flush()
    expect(env.pending()).toEqual([])
  })
  it('restarting replaces the old loop (no double polling)', async () => {
    const env = fakeEnv(); let n = 0
    const p = createPoller(async () => { n++ }, env)
    p.start(); await flush(); p.start(); await flush()
    expect(n).toBe(2)
    expect(env.pending()).toHaveLength(1)
    p.stop()
  })
  it('does not poll while the tab is hidden, and polls immediately when it becomes visible', async () => {
    const env = fakeEnv(); let n = 0
    const p = createPoller(async () => { n++ }, env)
    p.start(); await flush()
    expect(n).toBe(1)
    env.hidden = true
    await env.advance(2500)
    expect(n).toBe(1)                          // tick fired but paused itself
    await env.advance(60_000)
    expect(n).toBe(1)
    env.hidden = false
    env.fireVisibility(); await flush()
    expect(n).toBe(2)                          // resumed right away
    p.stop()
  })
})
