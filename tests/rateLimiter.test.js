import { describe, it, expect } from 'vitest'
import rl from '../src/middleware/rateLimiter.js'

function kvStore(initial = {}) {
  const m = new Map(Object.entries(initial))
  return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) }, m }
}
const ctx = ({ ip = '1.2.3.4', method = 'GET', path = '/api/x', env = {}, user } = {}) => ({
  env: { RATE_LIMIT_KV: kvStore(), ...env },
  req: { method, path, header: h => (h === 'cf-connecting-ip' ? ip : undefined) },
  get: k => (k === 'user' ? user : undefined),
  json: (body, status) => ({ body, status }),
})
const hit = async (mw, c) => { let passed = false; const res = await mw(c, async () => { passed = true }); return { res, passed } }

describe('isScanPollRequest — polling has its own budget', () => {
  const poll = (method, path) => rl.isScanPollRequest({ req: { method, path } })
  it('matches GET /api/scan/:id and /api/scan/status/:id', () => {
    expect(poll('GET', '/api/scan/3f2a-uuid')).toBe(true)
    expect(poll('GET', '/api/scan/status/3f2a-uuid')).toBe(true)
    expect(poll('GET', '/api/scan/3f2a-uuid/')).toBe(true)
  })
  it('does NOT match history, downloads, mutations or other routes', () => {
    expect(poll('GET', '/api/scan/history')).toBe(false)
    expect(poll('GET', '/api/scan/status')).toBe(false)
    expect(poll('GET', '/api/scan/abc/download')).toBe(false)
    expect(poll('POST', '/api/scan')).toBe(false)
    expect(poll('POST', '/api/scan/abc/initiate-fix')).toBe(false)
    expect(poll('GET', '/api/auth/me')).toBe(false)
  })
})

describe('general limiter', () => {
  it('skips webhooks and scan polling entirely (never touches KV)', async () => {
    const kv = { get: async () => { throw new Error('KV should not be read') }, put: async () => {} }
    for (const [method, path] of [['POST', '/api/webhooks/paystack'], ['GET', '/api/scan/abc'], ['GET', '/api/scan/status/abc']]) {
      const { passed } = await hit(rl.general, ctx({ method, path, env: { RATE_LIMIT_KV: kv } }))
      expect(passed).toBe(true)
    }
  })
  it('allows 100 requests then answers 429 on the 101st, per IP', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    let last
    for (let i = 0; i < 100; i++) last = await hit(rl.general, ctx({ env }))
    expect(last.passed).toBe(true)
    const over = await hit(rl.general, ctx({ env }))
    expect(over.passed).toBe(false)
    expect(over.res.status).toBe(429)
    // a different IP has its own bucket
    const other = await hit(rl.general, ctx({ env, ip: '9.9.9.9' }))
    expect(other.passed).toBe(true)
  })
  it('resets after the window elapses', async () => {
    const old = Date.now() - 16 * 60 * 1000
    const env = { RATE_LIMIT_KV: kvStore({ 'rl:general:1.2.3.4': JSON.stringify({ count: 100, windowStart: old }) }) }
    expect((await hit(rl.general, ctx({ env }))).passed).toBe(true)
  })
  it('a corrupt KV value does not lock anyone out', async () => {
    const env = { RATE_LIMIT_KV: kvStore({ 'rl:general:1.2.3.4': 'not-json{' }) }
    expect((await hit(rl.general, ctx({ env }))).passed).toBe(true)
  })
  it('honours RATE_LIMIT_BYPASS_IPS', async () => {
    const env = { RATE_LIMIT_KV: kvStore({ 'rl:general:7.7.7.7': JSON.stringify({ count: 999, windowStart: Date.now() }) }), RATE_LIMIT_BYPASS_IPS: '5.5.5.5, 7.7.7.7' }
    expect((await hit(rl.general, ctx({ env, ip: '7.7.7.7' }))).passed).toBe(true)
  })
})

describe('scanPoll limiter', () => {
  it('has a far larger ceiling than the general limiter (600 vs 100)', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    for (let i = 0; i < 150; i++) expect((await hit(rl.scanPoll, ctx({ env }))).passed).toBe(true)
    const kv = env.RATE_LIMIT_KV.m.get('rl:scanpoll:1.2.3.4')
    expect(JSON.parse(kv).count).toBe(150)
  })
  it('still enforces a ceiling (a runaway client is not unlimited)', async () => {
    const env = { RATE_LIMIT_KV: kvStore({ 'rl:scanpoll:1.2.3.4': JSON.stringify({ count: 600, windowStart: Date.now() }) }) }
    expect((await hit(rl.scanPoll, ctx({ env }))).res.status).toBe(429)
  })
})

// AUDIT FIX (bug — account-lockout DoS): before this fix, failCount alone
// decided lockout — LOCKOUT_MAX_CONSECUTIVE_FAILURES (8) trivial failed
// logins against any known email, all from ONE IP, locked that account for
// 15 minutes, repeatably, with zero authentication and zero credential
// knowledge required. These tests pin the fixed behavior directly against
// the exported functions (not through the controller), since this is the
// one place that actually enforces LOCKOUT_MIN_DISTINCT_IPS.
describe('account lockout — checkAccountLockout / recordLoginFailure / recordLoginSuccess', () => {
  it('does NOT lock after 8 failures from a single IP (the DoS this closes)', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    for (let i = 0; i < 8; i++) await rl.recordLoginFailure(env, 'victim@example.com', '9.9.9.9')
    const status = await rl.checkAccountLockout(env, 'victim@example.com')
    expect(status.locked).toBe(false)
  })

  it('locks once failures reach the threshold AND span >= 2 distinct IPs', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    // 7 failures from one IP, then a couple more from a second IP —
    // crosses both the count threshold and the distinct-IP requirement.
    for (let i = 0; i < 7; i++) await rl.recordLoginFailure(env, 'victim@example.com', '9.9.9.9')
    await rl.recordLoginFailure(env, 'victim@example.com', '9.9.9.9')
    let status = await rl.checkAccountLockout(env, 'victim@example.com')
    expect(status.locked).toBe(false)  // still just 1 distinct IP so far
    await rl.recordLoginFailure(env, 'victim@example.com', '4.4.4.4')
    status = await rl.checkAccountLockout(env, 'victim@example.com')
    expect(status.locked).toBe(true)
    expect(status.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('a real distributed attempt (many IPs, one failure each) still locks — the protection this preserves', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6', '7.7.7.7', '8.8.8.8']
    for (const ip of ips) await rl.recordLoginFailure(env, 'victim@example.com', ip)
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(true)
  })

  it('recordLoginSuccess clears the counter entirely', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6', '7.7.7.7', '8.8.8.8']) {
      await rl.recordLoginFailure(env, 'victim@example.com', ip)
    }
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(true)
    await rl.recordLoginSuccess(env, 'victim@example.com')
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(false)
  })

  it('missing/unknown IPs still count toward the same bucket, never crash', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    for (let i = 0; i < 8; i++) await rl.recordLoginFailure(env, 'victim@example.com', undefined)
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(false)  // still one bucket ('unknown')
  })

  // FEATURE (Auth section round 2): recordLoginFailure's return value is
  // what auth.controller.js uses to fire the one-time lockout-alert email —
  // must be true exactly on the transitioning call, never before or after.
  it('recordLoginFailure reports justLocked exactly on the call that triggers the lock', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    let last
    for (let i = 0; i < 7; i++) last = await rl.recordLoginFailure(env, 'victim@example.com', '9.9.9.9')
    expect(last.justLocked).toBe(false)
    last = await rl.recordLoginFailure(env, 'victim@example.com', '4.4.4.4')
    expect(last.justLocked).toBe(true)
    // Already locked — a further failure is not a NEW transition.
    last = await rl.recordLoginFailure(env, 'victim@example.com', '5.5.5.5')
    expect(last.justLocked).toBe(false)
  })

  // BUG FIX (round 2 — the lockout that re-arms itself forever): before this
  // fix, failCount/ips lived on untouched once a lock fired and later
  // expired — both already sat at/above the lock thresholds, so the very
  // next failure from a SINGLE ip re-locked the account instantly, forever,
  // defeating LOCKOUT_MIN_DISTINCT_IPS's entire purpose after the first lock.
  it('once a lock has expired, a single failure from one IP does NOT immediately re-lock', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    const key = 'rl:lockout:victim@example.com'
    const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6', '7.7.7.7', '8.8.8.8']
    for (const ip of ips) await rl.recordLoginFailure(env, 'victim@example.com', ip)
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(true)

    // Simulate the lock having naturally expired — same failCount/ips as a
    // real clock tick past lockedUntil would leave behind, nothing else touched.
    const stored = JSON.parse(await env.RATE_LIMIT_KV.get(key))
    await env.RATE_LIMIT_KV.put(key, JSON.stringify({ ...stored, lockedUntil: Date.now() - 1000 }))
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(false)

    // Before the fix: failCount/ips already sat at/above threshold here, so
    // this single failure from ONE ip alone would instantly re-lock.
    const result = await rl.recordLoginFailure(env, 'victim@example.com', '9.9.9.9')
    expect(result.justLocked).toBe(false)
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(false)
  })

  it('after an expired lock resets the counters, a real distributed attempt can still re-lock the account', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    const key = 'rl:lockout:victim@example.com'
    const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6', '7.7.7.7', '8.8.8.8']
    for (const ip of ips) await rl.recordLoginFailure(env, 'victim@example.com', ip)
    const stored = JSON.parse(await env.RATE_LIMIT_KV.get(key))
    await env.RATE_LIMIT_KV.put(key, JSON.stringify({ ...stored, lockedUntil: Date.now() - 1000 }))

    const otherIps = ['11.1.1.1', '12.1.1.1', '13.1.1.1', '14.1.1.1', '15.1.1.1', '16.1.1.1', '17.1.1.1', '18.1.1.1']
    let last
    for (const ip of otherIps) last = await rl.recordLoginFailure(env, 'victim@example.com', ip)
    expect(last.justLocked).toBe(true)
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(true)
  })
})

describe('anonScan limiter', () => {
  it('allows one anonymous scan per hour', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    expect((await hit(rl.anonScan, ctx({ env, method: 'POST', path: '/api/scan' }))).passed).toBe(true)
    expect((await hit(rl.anonScan, ctx({ env, method: 'POST', path: '/api/scan' }))).res.status).toBe(429)
  })
  it('does not apply to signed-in users', async () => {
    const env = { RATE_LIMIT_KV: kvStore() }
    const user = { id: 'u1' }
    for (let i = 0; i < 3; i++) expect((await hit(rl.anonScan, ctx({ env, method: 'POST', path: '/api/scan', user }))).passed).toBe(true)
  })
})
