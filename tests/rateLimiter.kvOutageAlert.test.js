// AUDIT FIX (Section 9 pass — feature gap): every KV-backed security control
// in rateLimiter.js fails open silently on a KV error — this file confirms
// the new owner-alert wiring actually fires on the primary detection paths,
// is throttled in-process (not via KV, since sendOwnerAlert's own de-dupe is
// a hitQuota() call against the SAME KV namespace that's failing), and does
// NOT re-enter itself through hitQuota's own catch block.
//
// rateLimiter.js is CommonJS and calls require('../services/email.service')
// LAZILY, inside the function body — vi.mock() cannot intercept a plain
// require() call, so this uses the same require.cache-stubbing helper the
// service-level tests use (see tests/reconcile.service.test.js).
import { describe, it, expect, afterEach } from 'vitest'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

function kvStore(initial = {}) {
  const m = new Map(Object.entries(initial))
  return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) }, m }
}
function throwingKv(message = 'KV is down') {
  return { get: async () => { throw new Error(message) }, put: async () => { throw new Error(message) }, delete: async () => { throw new Error(message) } }
}
const ctx = ({ ip = '1.2.3.4', method = 'GET', path = '/api/x', env = {} } = {}) => ({
  env,
  req: { method, path, header: h => (h === 'cf-connecting-ip' ? ip : undefined) },
  get: () => undefined,
  json: (body, status) => ({ body, status }),
})

function setup() {
  const alerts = []
  const { mod, restore } = loadWithStubs('middleware/rateLimiter.js', {
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message) => { alerts.push({ subject, message }); return true } },
  })
  return { rl: mod, alerts, restore }
}

let t
afterEach(() => { t?.restore(); const realErr = console.error; console.error = realErr })

describe('KV-outage owner alerting', () => {
  it('alerts when the general limiter cannot reach KV', async () => {
    t = setup()
    const quiet = console.error; console.error = () => {}
    await t.rl.general(ctx({ env: { RATE_LIMIT_KV: throwingKv() } }), async () => {})
    console.error = quiet
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0].subject).toMatch(/RATE_LIMIT_KV outage/)
    expect(t.alerts[0].message).toMatch(/rate limiter \(rl:general\)/)
  })

  it('alerts when checkAccountLockout cannot reach KV', async () => {
    t = setup()
    const quiet = console.error; console.error = () => {}
    const result = await t.rl.checkAccountLockout({ RATE_LIMIT_KV: throwingKv() }, 'a@b.com')
    console.error = quiet
    expect(result).toEqual({ locked: false, retryAfterSeconds: null })
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0].message).toMatch(/account lockout check/)
  })

  it('alerts when the verify-miss limiter cannot reach KV', async () => {
    t = setup()
    const quiet = console.error; console.error = () => {}
    const limited = await t.rl.isVerifyMissLimited({ RATE_LIMIT_KV: throwingKv() }, '9.9.9.9')
    console.error = quiet
    expect(limited).toBe(false)
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0].message).toMatch(/verify miss limiter/)
  })

  it('never alerts from inside hitQuota itself (would re-enter via sendOwnerAlert\'s own de-dupe)', async () => {
    t = setup()
    const quiet = console.error; console.error = () => {}
    const allowed = await t.rl.hitQuota({ RATE_LIMIT_KV: throwingKv() }, 'rl:mail:x', 1, 60)
    console.error = quiet
    expect(allowed).toBe(true)
    expect(t.alerts).toHaveLength(0)
  })

  it('debounces in-process: a second failure within 10 minutes does not send a second alert', async () => {
    t = setup()
    const quiet = console.error; console.error = () => {}
    const env = { RATE_LIMIT_KV: throwingKv() }
    await t.rl.general(ctx({ env }), async () => {})
    await t.rl.auth(ctx({ env, path: '/api/auth/login' }), async () => {})
    await t.rl.checkAccountLockout(env, 'a@b.com')
    console.error = quiet
    expect(t.alerts).toHaveLength(1)
  })

  it('does not alert, and still fails open, once KV recovers', async () => {
    t = setup()
    const env = { RATE_LIMIT_KV: kvStore() }
    let nextCalled = false
    await t.rl.general(ctx({ env }), async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
    expect(t.alerts).toHaveLength(0)
  })

  it('a broken alert channel (Resend/Supabase both down) never breaks the fail-open request itself', async () => {
    const { mod, restore } = loadWithStubs('middleware/rateLimiter.js', {
      'services/email.service.js': { sendOwnerAlert: async () => { throw new Error('Resend and Supabase both unreachable') } },
    })
    t = { restore }
    const quiet = console.error; console.error = () => {}
    let nextCalled = false
    await mod.general(ctx({ env: { RATE_LIMIT_KV: throwingKv() } }), async () => { nextCalled = true })
    // Give the fire-and-forget alert promise's rejection handler a turn.
    await new Promise(r => setTimeout(r, 0))
    console.error = quiet
    expect(nextCalled).toBe(true)
  })
})
