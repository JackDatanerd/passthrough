// The Durable Object rate-limit backend. The headline property: every
// read-modify-write is ATOMIC, so a burst of parallel requests cannot all read
// "count = 0". The same burst against the KV fallback is proven NOT to hold
// (that is the bug this backend exists to fix), so both halves are asserted.
import { describe, it, expect, afterEach } from 'vitest'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { RateLimiterDO } from '../src/lib/rateLimiterDO.js'

// A faithful-enough Durable Object namespace: one instance per name, each with
// its own storage, driven through the real class via fetch().
function makeNamespace({ failWith } = {}) {
  const instances = new Map()
  const instance = name => {
    if (!instances.has(name)) {
      const data = new Map()
      let alarmAt = null
      const state = { storage: {
        get: async k => { await Promise.resolve(); return data.get(k) },
        put: async (k, v) => { await Promise.resolve(); data.set(k, v) },
        delete: async k => { await Promise.resolve(); data.delete(k) },
        list: async () => new Map(data),
        setAlarm: async t => { alarmAt = t },
      } }
      instances.set(name, { obj: new RateLimiterDO(state, {}), data, getAlarm: () => alarmAt })
    }
    return instances.get(name)
  }
  return {
    instances, instance,
    idFromName: n => n,
    get: id => ({ fetch: async (url, init) => {
      if (failWith) throw new Error(failWith)
      return instance(id).obj.fetch(new Request(url, init))
    } }),
  }
}
// Slow, racy KV: reads see a snapshot, writes land later — the old behaviour.
function racyKv() {
  const m = new Map()
  return { get: async k => { await new Promise(r => setTimeout(r, 1)); return m.get(k) ?? null }, put: async (k, v) => { await new Promise(r => setTimeout(r, 4)); m.set(k, v) }, delete: async k => { m.delete(k) } }
}
const ctx = ({ env, ip = '1.2.3.4', user } = {}) => ({
  env,
  req: { method: 'POST', path: '/api/x', header: h => (h === 'cf-connecting-ip' ? ip : undefined) },
  get: k => (k === 'user' ? user : undefined),
  json: (body, status, headers) => ({ body, status, headers }),
  res: { status: 200 },
})

let t
afterEach(() => { t?.restore() })
function setup(alerts = []) {
  t = loadWithStubs('middleware/rateLimiter.js', {
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message) => { alerts.push({ subject, message }); return true } },
  })
  return t.mod
}

describe('RateLimiterDO — atomic counters', () => {
  it('50 parallel hits against a limit of 10 allow EXACTLY 10', async () => {
    const rl = setup(); const env = { RATE_LIMIT_DO: makeNamespace() }
    const results = await Promise.all(Array.from({ length: 50 }, () => rl.hitQuota(env, 'rl:auth:1.2.3.4', 10, 900)))
    expect(results.filter(Boolean)).toHaveLength(10)
  })

  it('the same burst against the KV fallback lets ALL 50 through (the bug being fixed)', async () => {
    const rl = setup(); const env = { RATE_LIMIT_KV: racyKv() }
    const results = await Promise.all(Array.from({ length: 50 }, () => rl.hitQuota(env, 'rl:auth:1.2.3.4', 10, 900)))
    expect(results.filter(Boolean).length).toBeGreaterThan(10)
  })

  it('makeLimiter: a parallel burst yields exactly max allowed and the rest 429 with Retry-After', async () => {
    const rl = setup(); const env = { RATE_LIMIT_DO: makeNamespace() }
    const out = await Promise.all(Array.from({ length: 30 }, async () => {
      let passed = false
      const r = await rl.auth(ctx({ env }), async () => { passed = true })
      return { passed, r }
    }))
    expect(out.filter(o => o.passed)).toHaveLength(10)
    const blocked = out.filter(o => !o.passed)
    expect(blocked).toHaveLength(20)
    expect(blocked[0].r.status).toBe(429)
    expect(Number(blocked[0].r.headers['Retry-After'])).toBeGreaterThan(0)
  })

  it('account lockout locks after 8 PARALLEL failures from 2 clients (and alerts exactly once)', async () => {
    const rl = setup(); const env = { RATE_LIMIT_DO: makeNamespace() }
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => rl.recordLoginFailure(env, 'victim@example.com', i % 2 ? '1.1.1.1' : '2.2.2.2')))
    expect(results.filter(r => r.justLocked)).toHaveLength(1)
    expect((await rl.checkAccountLockout(env, 'victim@example.com')).locked).toBe(true)
  })

  it('one client alone cannot lock a login (distinct-client bar), but can lock an authenticated check', async () => {
    const rl = setup(); const env = { RATE_LIMIT_DO: makeNamespace() }
    await Promise.all(Array.from({ length: 20 }, () => rl.recordLoginFailure(env, 'a@b.com', '9.9.9.9')))
    expect((await rl.checkAccountLockout(env, 'a@b.com')).locked).toBe(false)
    await Promise.all(Array.from({ length: 20 }, () => rl.recordLoginFailure(env, 'c@d.com', '9.9.9.9', { requireDistinctIps: false })))
    expect((await rl.checkAccountLockout(env, 'c@d.com')).locked).toBe(true)
  })

  it('a successful login clears the failure count', async () => {
    const rl = setup(); const env = { RATE_LIMIT_DO: makeNamespace() }
    for (let i = 0; i < 5; i++) await rl.recordLoginFailure(env, 'a@b.com', '1.1.1.1')
    await rl.recordLoginSuccess(env, 'a@b.com')
    const ns = env.RATE_LIMIT_DO
    expect([...ns.instance('rl:lockout:a@b.com').data.keys()]).toHaveLength(0)
  })

  it('verify-miss counter counts EXACTLY under parallel misses and limits at the max', async () => {
    const rl = setup(); const env = { RATE_LIMIT_DO: makeNamespace() }
    await Promise.all(Array.from({ length: rl.VERIFY_MISS_MAX }, () => rl.recordVerifyMiss(env, '5.5.5.5')))
    expect(await rl.isVerifyMissLimited(env, '5.5.5.5')).toBe(true)
    expect(await rl.isVerifyMissLimited(env, '6.6.6.6')).toBe(false)
  })

  it('refund gives a slot back, bounded by maxRefunds', async () => {
    const rl = setup(); const env = { RATE_LIMIT_DO: makeNamespace() }
    for (let i = 0; i < 3; i++) await rl.hitQuota(env, 'rl:k', 3, 900)
    expect(await rl.hitQuota(env, 'rl:k', 3, 900)).toBe(false)
    await rl.refundQuota(env, 'rl:k', 900, 1)
    expect(await rl.hitQuota(env, 'rl:k', 3, 900)).toBe(true)
    await rl.refundQuota(env, 'rl:k', 900, 1)      // second refund exceeds maxRefunds = 1
    expect(await rl.hitQuota(env, 'rl:k', 3, 900)).toBe(false)
  })

  it('keys are isolated from each other', async () => {
    const rl = setup(); const env = { RATE_LIMIT_DO: makeNamespace() }
    expect(await rl.hitQuota(env, 'rl:a', 1, 60)).toBe(true)
    expect(await rl.hitQuota(env, 'rl:a', 1, 60)).toBe(false)
    expect(await rl.hitQuota(env, 'rl:b', 1, 60)).toBe(true)
  })
})

describe('RateLimiterDO — storage hygiene', () => {
  it('arms an alarm past the expiry and the alarm deletes expired data', async () => {
    const rl = setup(); const ns = makeNamespace(); const env = { RATE_LIMIT_DO: ns }
    await rl.hitQuota(env, 'rl:k', 5, 60)
    const inst = ns.instance('rl:k')
    expect(inst.getAlarm()).toBeGreaterThan(Date.now())
    for (const rec of inst.data.values()) rec.exp = Date.now() - 1     // time passes
    await inst.obj.alarm()
    expect(inst.data.size).toBe(0)
  })
  it('expired data is treated as absent (a new window starts)', async () => {
    const rl = setup(); const ns = makeNamespace(); const env = { RATE_LIMIT_DO: ns }
    expect(await rl.hitQuota(env, 'rl:k', 1, 60)).toBe(true)
    expect(await rl.hitQuota(env, 'rl:k', 1, 60)).toBe(false)
    for (const rec of ns.instance('rl:k').data.values()) rec.exp = Date.now() - 1
    expect(await rl.hitQuota(env, 'rl:k', 1, 60)).toBe(true)
  })
  it('rejects unknown ops and malformed bodies', async () => {
    const inst = new RateLimiterDO({ storage: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => new Map(), setAlarm: async () => {} } }, {})
    expect((await inst.fetch(new Request('https://x', { method: 'POST', body: JSON.stringify({ op: 'nope' }) }))).status).toBe(400)
    expect((await inst.fetch(new Request('https://x', { method: 'POST', body: 'not json' }))).status).toBe(400)
  })
})

describe('backend failure handling', () => {
  const quiet = fn => async () => { const e = console.error; console.error = () => {}; try { await fn() } finally { console.error = e } }

  it('a DO failure fails OPEN, and alerts naming RATE_LIMIT_DO', quiet(async () => {
    const alerts = []; const rl = setup(alerts); const env = { RATE_LIMIT_DO: makeNamespace({ failWith: 'DO unreachable' }) }
    let passed = false
    await rl.general(ctx({ env }), async () => { passed = true })
    expect(passed).toBe(true)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].subject).toMatch(/RATE_LIMIT_DO outage/)
  }))

  it('KV same-key write throttling (429) is contention: fail open, NO outage email', quiet(async () => {
    const alerts = []; const rl = setup(alerts)
    const kv = { get: async () => null, put: async () => { throw new Error('KV PUT failed: 429 Too Many Requests') }, delete: async () => {} }
    let passed = false
    await rl.general(ctx({ env: { RATE_LIMIT_KV: kv } }), async () => { passed = true })
    expect(passed).toBe(true)
    expect(alerts).toHaveLength(0)
  }))

  it('the outage alert is handed to waitUntil when a request context exists', quiet(async () => {
    const alerts = []; const rl = setup(alerts)
    const waited = []
    const c = { ...ctx({ env: { RATE_LIMIT_KV: { get: async () => { throw new Error('KV is down') }, put: async () => {}, delete: async () => {} } } }), executionCtx: { waitUntil: p => waited.push(p) } }
    await rl.general(c, async () => {})
    expect(waited).toHaveLength(1)
    await Promise.all(waited)
    expect(alerts).toHaveLength(1)
  }))
})
