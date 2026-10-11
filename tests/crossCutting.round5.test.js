import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const core = require('../src/lib/rateLimitCore.js')
const rl = require('../src/middleware/rateLimiter.js')
const admin = require('../src/middleware/adminOnly.js')
const health = require('../src/lib/health.js')
const jwtLib = require('../src/lib/jwt.js')

const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
const DEV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const mk = ({ ip = '41.80.1.1', device, env = {}, body, user, sid } = {}) => {
  const store = { user, sessionId: sid }
  return {
    env, get: k => store[k], set: (k, v) => { store[k] = v }, json: (b, status = 200) => ({ body: b, status }),
    req: { method: 'POST', path: '/x', header: h => (/^cf-connecting-ip$/i.test(h) ? ip : /^x-device-id$/i.test(h) ? device : undefined), json: async () => { if (body === undefined) throw new Error('no body'); return body } },
  }
}

describe('trusted devices (lockout-DoS mitigation)', () => {
  it('trustAdd/trustCheck: remembers, is most-recent-first, bounded, ignores junk', async () => {
    const s = kv()
    expect((await core.trustCheck(s, 'k', 'd1')).trusted).toBe(false)
    expect((await core.trustAdd(s, 'k', '')).ok).toBe(false)
    for (let i = 0; i < 8; i++) await core.trustAdd(s, 'k', `d${i}`)
    expect(JSON.parse(s.m.get('k')).devices).toHaveLength(core.TRUSTED_DEVICE_MAX || 5)
    expect((await core.trustCheck(s, 'k', 'd7')).trusted).toBe(true)
    expect((await core.trustCheck(s, 'k', 'd0')).trusted).toBe(false)   // pushed out
    await core.trustAdd(s, 'k', 'd7')
    expect(JSON.parse(s.m.get('k')).devices.filter(d => d === 'd7')).toHaveLength(1)
  })
  it('a corrupt stored value reads as "no trusted devices", never throws', async () => {
    const s = kv(); s.m.set('k', '{not json')
    expect((await core.trustCheck(s, 'k', 'x')).trusted).toBe(false)
  })
  it('remember → check round trip is per account and per device, and email case does not matter', async () => {
    const env = { RATE_LIMIT_KV: kv() }
    await rl.rememberTrustedDevice(env, 'Owner@Example.com', mk({ device: DEV_A }))
    expect(await rl.isTrustedDevice(env, 'owner@example.com', mk({ device: DEV_A }))).toBe(true)
    expect(await rl.isTrustedDevice(env, 'owner@example.com', mk({ device: DEV_B }))).toBe(false)
    expect(await rl.isTrustedDevice(env, 'other@example.com', mk({ device: DEV_A }))).toBe(false)
    expect(await rl.isTrustedDevice(env, 'owner@example.com', mk({}))).toBe(false)   // no X-Device-Id header
  })
  it('the raw device id is never stored', async () => {
    const env = { RATE_LIMIT_KV: kv() }
    await rl.rememberTrustedDevice(env, 'o@e.com', mk({ device: DEV_A }))
    expect([...env.RATE_LIMIT_KV.m.values()].join('')).not.toContain(DEV_A)
  })
  it('a broken backend fails closed for the exemption (not trusted) and never throws', async () => {
    const env = { RATE_LIMIT_KV: { get: async () => { throw new Error('down') }, put: async () => { throw new Error('down') } } }
    await expect(rl.rememberTrustedDevice(env, 'o@e.com', mk({ device: DEV_A }))).resolves.toBeUndefined()
    expect(await rl.isTrustedDevice(env, 'o@e.com', mk({ device: DEV_A }))).toBe(false)
  })
})

describe('stepUpWhen', () => {
  const needsEmail = admin.stepUpWhen(b => !!b && b.email !== undefined)
  const run = async c => { let passed = false; const res = await needsEmail(c, async () => { passed = true }); return passed ? 'next' : res.status }
  it('is a pass-through when step-up is off', async () => {
    expect(await run(mk({ env: { JWT_SECRET: 'k'.repeat(40) }, body: { email: 'x@y.z' } }))).toBe('next')
  })
  it('lets a harmless edit through but demands elevation for a gated one', async () => {
    const env = { JWT_SECRET: 'k'.repeat(40), ADMIN_STEP_UP_MINUTES: '10' }
    const user = { id: 'a1', role: 'ADMIN' }
    expect(await run(mk({ env, user, body: { name: 'New name' } }))).toBe('next')
    expect(await run(mk({ env, user, body: { email: 'new@x.com' } }))).toBe(403)
    expect(await run(mk({ env, user }))).toBe('next')   // no / non-JSON body: nothing gated to protect
  })
  it('a valid elevation token satisfies it', async () => {
    const env = { JWT_SECRET: 'k'.repeat(40), ADMIN_STEP_UP_MINUTES: '10' }
    const { token } = await admin.mintElevation(env, { id: 'a1' }, 's-1')
    const c = mk({ env, user: { id: 'a1' }, sid: 's-1', body: { email: 'new@x.com' } })
    const orig = c.req.header
    c.req.header = h => (h === 'X-Admin-Elevation' ? token : orig(h))
    expect(await run(c)).toBe('next')
  })
})

describe('route wiring', () => {
  const fs = require('node:fs')
  const partners = fs.readFileSync(new URL('../src/routes/partners.routes.js', import.meta.url), 'utf8')
  const adminRoutes = fs.readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8')
  it('every partner route that returns or redirects the payout write token is behind step-up', () => {
    expect(partners).toMatch(/\/:id\/resend-link'[^\n]*admin\.stepUp/)
    expect(partners).toMatch(/\/:id\/regenerate-link'[^\n]*admin\.stepUp/)
    expect(partners).toMatch(/\/:id\/links'[^\n]*admin\.stepUp/)
    expect(partners).toMatch(/patch\('\/:id'[^\n]*partnerMoneyEdit/)
  })
  it('/elevate has its own limiter, not the shared auth one', () => {
    expect(adminRoutes).toMatch(/'\/elevate', rl\.adminElevate/)
    expect(typeof rl.adminElevate).toBe('function')
  })
})

describe('/healthz probes the rate limiter', () => {
  it('no backend configured: skipped (the bindings check already reports it)', async () => {
    expect(await health.checkRateLimiter({})).toMatchObject({ ok: true, backend: null })
  })
  it('a working KV backend is ok; a throwing one is reported', async () => {
    expect(await health.checkRateLimiter({ RATE_LIMIT_KV: kv() })).toMatchObject({ ok: true, backend: 'RATE_LIMIT_KV' })
    const bad = await health.checkRateLimiter({ RATE_LIMIT_KV: { get: async () => { throw new Error('kv down') } } })
    expect(bad.ok).toBe(false)
    expect(bad.detail).toMatch(/kv down/)
  })
  it('a Durable Object that answers non-2xx is reported, and the probe writes nothing', async () => {
    const ns = { idFromName: k => k, get: () => ({ fetch: async () => new Response('x', { status: 500 }) }) }
    expect((await health.checkRateLimiter({ RATE_LIMIT_DO: ns })).ok).toBe(false)
    const s = kv(); await health.checkRateLimiter({ RATE_LIMIT_KV: s })
    expect(s.m.size).toBe(0)
  })
})

describe('scan poll limiter is keyed per signed token', () => {
  it('two different tokens behind one IP do not share a budget', async () => {
    const SECRET = 'test-secret-test-secret-test-secret-123'
    const env = { RATE_LIMIT_KV: kv(), JWT_SECRET: SECRET, NODE_ENV: 'production' }
    const t1 = await jwtLib.sign({ userId: 'u1', tokenVersion: 0, sid: 's1' }, SECRET, 600)
    const t2 = await jwtLib.sign({ userId: 'u2', tokenVersion: 0, sid: 's2' }, SECRET, 600)
    const hit = async token => {
      const c = mk({ env })
      c.req.method = 'GET'; c.req.path = '/api/scan/anything'
      const o = c.req.header
      c.req.header = h => (h === 'Authorization' ? `Bearer ${token}` : o(h))
      let passed = false; const r = await rl.scanPoll(c, async () => { passed = true }); return passed ? 200 : r.status
    }
    let last
    for (let i = 0; i < 601; i++) last = await hit(t1)
    expect(last).toBe(429)
    expect(await hit(t2)).toBe(200)   // same IP, different signed-in person: untouched
  })
})
