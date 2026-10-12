import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const require = createRequire(import.meta.url)
const core = require('../src/lib/rateLimitCore.js')
const rl = require('../src/middleware/rateLimiter.js')
const admin = require('../src/middleware/adminOnly.js')
const leadTokens = require('../src/lib/leadTokens.js')

const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }

// ── lockout: the owner's-network exemption has a guess budget ───────────────────────────────────────────────
describe('lockout — network exemption budget (infra round 6)', () => {
  async function lockIt(s) {
    // 8 consecutive failures from 2 distinct clients → locked
    for (let i = 0; i < 4; i++) { await core.lockoutFail(s, 'k', 'A'); await core.lockoutFail(s, 'k', 'B') }
  }
  it('a fresh lock has not exhausted the exemption', async () => {
    const s = kv(); await lockIt(s)
    const r = await core.lockoutCheck(s, 'k')
    expect(r.locked).toBe(true)
    expect(r.exemptExhausted).toBe(false)
  })
  it('failed guesses that land during the lock spend the budget, and the lock keeps its original end', async () => {
    const s = kv(); await lockIt(s)
    const until = JSON.parse(s.m.get('k')).lockedUntil
    for (let i = 0; i < core.LOCKOUT_EXEMPT_GUESSES - 1; i++) await core.lockoutFail(s, 'k', 'OWNER')
    expect((await core.lockoutCheck(s, 'k')).exemptExhausted).toBe(false)
    await core.lockoutFail(s, 'k', 'OWNER')
    const r = await core.lockoutCheck(s, 'k')
    expect(r.exemptExhausted).toBe(true)
    expect(JSON.parse(s.m.get('k')).lockedUntil).toBe(until)
  })
  it('a lock that has run its course starts the next one with a full budget', async () => {
    const s = kv(); await lockIt(s)
    const rec = JSON.parse(s.m.get('k')); rec.lockGuesses = 99; rec.lockedUntil = Date.now() - 1000
    s.m.set('k', JSON.stringify(rec))
    await lockIt(s)
    expect((await core.lockoutCheck(s, 'k')).exemptExhausted).toBe(false)
  })
  it('a successful sign-in clears the whole record, budget included', async () => {
    const s = kv(); await lockIt(s)
    await core.lockoutClear(s, 'k')
    expect((await core.lockoutCheck(s, 'k')).locked).toBe(false)
  })
  describe('lockoutBlocks', () => {
    const { lockoutBlocks } = require('../src/controllers/auth.controller.js')
    const c = ip => ({ env: {}, req: { header: h => (/^cf-connecting-ip$/i.test(h) ? ip : undefined) } })
    it('still lets the owner\'s own network through while the budget lasts', () => {
      expect(lockoutBlocks(c('41.1.1.1'), { locked: true, exemptExhausted: false }, '41.1.1.1')).toBe(false)
    })
    it('closes that exemption once the budget is spent — the lock then applies to that network too', () => {
      expect(lockoutBlocks(c('41.1.1.1'), { locked: true, exemptExhausted: true }, '41.1.1.1')).toBe(true)
    })
    it('an unlocked account is never blocked, whatever the budget says', () => {
      expect(lockoutBlocks(c('41.1.1.1'), { locked: false, exemptExhausted: true }, '41.1.1.1')).toBe(false)
    })
  })
})

// ── RATE_LIMIT_BYPASS_IPS ───────────────────────────────────────────────────────────────────────────────────
describe('isBypassed — ranges and IPv6 spellings (infra round 6)', () => {
  const env = v => ({ RATE_LIMIT_BYPASS_IPS: v })
  it('keeps exact matching and the unset default', () => {
    expect(rl.isBypassed(env('1.2.3.4, 5.6.7.8'), '5.6.7.8')).toBe(true)
    expect(rl.isBypassed(env('1.2.3.4'), '1.2.3.5')).toBe(false)
    expect(rl.isBypassed({}, '1.2.3.4')).toBe(false)
  })
  it('accepts CIDR ranges', () => {
    expect(rl.isBypassed(env('10.0.0.0/24'), '10.0.0.77')).toBe(true)
    expect(rl.isBypassed(env('10.0.0.0/24'), '10.0.1.1')).toBe(false)
    expect(rl.isBypassed(env('2001:db8:abcd::/48'), '2001:db8:abcd:1::5')).toBe(true)
  })
  it('matches an IPv6 address written in a different (equal) spelling', () => {
    expect(rl.isBypassed(env('2001:db8::1'), '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true)
  })
  it('a bare IPv6 address stays EXACT here (no /64 widening for a list that switches limits off)', () => {
    expect(rl.isBypassed(env('2001:db8::1'), '2001:db8::2')).toBe(false)
  })
  it('junk entries and the unknown address never match', () => {
    expect(rl.isBypassed(env('not-an-ip, 1.2.3.4'), 'unknown')).toBe(false)
    expect(rl.isBypassed(env('not-an-ip'), '1.2.3.4')).toBe(false)
  })
})

// ── outage alert runs under waitUntil when a request context is passed ─────────────────────────────────────
describe('checkAccountLockout / isVerifyMissLimited — outage alert is registered with waitUntil (infra round 6)', () => {
  const brokenEnv = () => ({ RATE_LIMIT_KV: { get: async () => { throw new Error('KV is down') }, put: async () => { throw new Error('KV is down') }, delete: async () => {} } })
  it('checkAccountLockout fails open and hands the alert to waitUntil', async () => {
    const waited = []
    const c = { executionCtx: { waitUntil: p => waited.push(p) } }
    const err = console.error; console.error = () => {}
    const r = await rl.checkAccountLockout(brokenEnv(), 'a@b.co', c)
    console.error = err
    expect(r).toEqual({ locked: false, retryAfterSeconds: null })
    expect(waited.length).toBe(1)
    await Promise.allSettled(waited)
  })
})

// ── routes ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('route wiring (infra round 6)', () => {
  const has = (router, method, path, handler) =>
    router.routes.filter(r => r.method === method && r.path === path).some(r => r.handler === handler)
  const adminRoutes = require('../src/routes/admin.routes.js')
  const leadRoutes = require('../src/routes/employer-leads.routes.js')
  const verifyRoutes = require('../src/routes/verify.routes.js')
  const outcomeRoutes = require('../src/routes/outcomes.routes.js')

  it.each([
    ['PATCH',  '/users/:id'],
    ['PATCH',  '/scans/:id/verification'],
    ['POST',   '/scans/:id/requeue-fix'],
    ['POST',   '/webhook-events/:id/replay'],
    ['POST',   '/webhook-events/:id/dismiss'],
    ['DELETE', '/email-suppressions'],
  ])('admin %s %s needs step-up', (m, p) => { expect(has(adminRoutes, m, p, admin.stepUp)).toBe(true) })

  it.each([
    ['POST',   '/import'],
    ['POST',   '/bulk'],
    ['POST',   '/suppressions'],
    ['DELETE', '/suppressions'],
    ['DELETE', '/:id'],
  ])('employer-leads %s %s needs step-up', (m, p) => { expect(has(leadRoutes, m, p, admin.stepUp)).toBe(true) })

  it('routine admin writes stay one click (no step-up on moderation or a single lead\'s status)', () => {
    expect(has(adminRoutes, 'POST', '/stories/:id/moderate', admin.stepUp)).toBe(false)
    expect(has(leadRoutes, 'PATCH', '/:id', admin.stepUp)).toBe(false)
    // (Replay was listed here until webhooks round 12 (W2): it re-runs a stored event, which can reverse a sale or clear a dispute — money actions — so it now needs step-up like Dismiss.)
  })

  it('the QR endpoints have their own limiter', () => {
    expect(has(verifyRoutes, 'GET', '/:code/qr.svg', rl.verifyQr)).toBe(true)
    expect(has(verifyRoutes, 'GET', '/:code/qr.png', rl.verifyQr)).toBe(true)
  })

  it('the follow-up unsubscribe is public, limited, and registered before any :scanId route', () => {
    expect(has(outcomeRoutes, 'POST', '/unsubscribe', rl.followUpOptOut)).toBe(true)
    expect(has(outcomeRoutes, 'GET', '/unsubscribe', rl.followUpOptOut)).toBe(true)
    const paths = outcomeRoutes.routes.map(r => r.path)
    expect(paths.indexOf('/unsubscribe')).toBeLessThan(paths.indexOf('/:scanId/story'))
  })
})

describe('verifyQr limiter', () => {
  const ctx = ip => ({ env: { RATE_LIMIT_KV: null }, req: { method: 'GET', path: '/api/verify/ABC123/qr.svg', header: h => (/^cf-connecting-ip$/i.test(h) ? ip : undefined) }, get: () => undefined, json: (b, s) => ({ body: b, status: s }), header: () => {} })
  it('is exported and fails open without a backend', async () => {
    expect(typeof rl.verifyQr).toBe('function')
    let passed = false
    await rl.verifyQr(ctx('1.2.3.4'), async () => { passed = true })
    expect(passed).toBe(true)
  })
})

// ── interview follow-up: one-click unsubscribe ──────────────────────────────────────────────────────────────
describe('interview follow-up unsubscribe (infra round 6)', () => {
  let restore
  afterEach(() => { restore?.(); restore = undefined })
  const SECRET = 'a-test-secret-of-sufficient-length-0123456789'
  const env = { JWT_SECRET: SECRET, FRONTEND_URL: 'https://app.example.com', API_ORIGIN: 'https://api.example.com/' }

  function setup(resolver) {
    const db = createFakeSupabase(resolver)
    const loaded = loadWithStubs('controllers/outcomes.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOutcomeFollowUp: async () => true },
    })
    restore = loaded.restore
    return { c: loaded.mod, db }
  }
  const ctxFor = (query, e = env) => ({
    env: e,
    req: { query: k => query[k] },
    json: (b, status = 200) => ({ body: b, status }),
    redirect: (url, status) => ({ redirect: url, status }),
  })

  it('"followup" is a token purpose of its own', async () => {
    expect(leadTokens.PURPOSES).toContain('followup')
    const t = await leadTokens.signLeadToken(SECRET, 'followup', 'Ann@X.co')
    expect(await leadTokens.verifyLeadToken([SECRET], 'followup', t)).toBe('ann@x.co')
    // a link of one purpose is never accepted as another
    expect(await leadTokens.verifyLeadToken([SECRET], 'remove', t)).toBeNull()
    const removeTok = await leadTokens.signLeadToken(SECRET, 'remove', 'ann@x.co')
    expect(await leadTokens.verifyLeadToken([SECRET], 'followup', removeTok)).toBeNull()
  })

  it('POST with a valid token switches the follow-up off for that address, and nothing else', async () => {
    const { c, db } = setup(() => ({ data: null, error: null }))
    const t = await leadTokens.signLeadToken(SECRET, 'followup', 'ann@x.co')
    const r = await c.unsubscribeFollowUp(ctxFor({ token: t }))
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    expect(db.calls).toHaveLength(1)
    const q = db.calls[0]
    expect(q.table).toBe('users')
    expect(q.op).toBe('update')
    expect(q.patch).toEqual({ notify_outcome_followup: false })
    expect(q.filters).toContainEqual(['eq', 'email', 'ann@x.co'])
    expect(q.filters).toContainEqual(['is', 'deleted_at', null])
  })

  it('a missing, forged, wrong-purpose or oversized token is refused with 400 and touches nothing', async () => {
    const { c, db } = setup(() => ({ data: null, error: null }))
    const removeTok = await leadTokens.signLeadToken(SECRET, 'remove', 'ann@x.co')
    const forged = await leadTokens.signLeadToken('another-secret-of-sufficient-length-9876543210', 'followup', 'ann@x.co')
    for (const token of [undefined, '', 'short', removeTok, forged, 'x'.repeat(701)]) {
      const r = await c.unsubscribeFollowUp(ctxFor({ token }))
      expect(r.status).toBe(400)
    }
    expect(db.calls).toHaveLength(0)
  })

  it('a database error is a 5xx (thrown), so the mail provider retries', async () => {
    const { c } = setup(() => ({ data: null, error: new Error('db down') }))
    const t = await leadTokens.signLeadToken(SECRET, 'followup', 'ann@x.co')
    await expect(c.unsubscribeFollowUp(ctxFor({ token: t }))).rejects.toThrow('db down')
  })

  it('GET only redirects to Settings and never changes anything', () => {
    const { c, db } = setup(() => ({ data: null, error: null }))
    const r = c.unsubscribeFollowUpRedirect(ctxFor({ token: 'whatever' }, { FRONTEND_URL: 'https://app.example.com/' }))
    expect(r).toEqual({ redirect: 'https://app.example.com/dashboard/settings', status: 302 })
    expect(db.calls).toHaveLength(0)
  })

  it('followUpUnsubscribeUrl builds a verifiable link on the API origin, and is null when the origin is unknown', async () => {
    const { c } = setup(() => ({ data: null, error: null }))
    const url = await c.followUpUnsubscribeUrl(env, 'Ann@X.co')
    expect(url.startsWith('https://api.example.com/api/outcomes/unsubscribe?token=')).toBe(true)
    const token = new URL(url).searchParams.get('token')
    expect(await leadTokens.verifyLeadToken([SECRET], 'followup', token)).toBe('ann@x.co')
    expect(await c.followUpUnsubscribeUrl({ JWT_SECRET: SECRET, FRONTEND_URL: 'https://app.example.com' }, 'ann@x.co')).toBeNull()
    expect(await c.followUpUnsubscribeUrl({ API_ORIGIN: 'https://api.example.com' }, 'ann@x.co')).toBeNull()
  })

  it('the email carries RFC 8058 headers when given the URL, and none otherwise', async () => {
    const sent = []
    const m = loadWithStubs('services/email.service.js', { 'config/email.js': { sendViaResend: async (e, msg) => { sent.push(msg); return {} } } })
    restore = m.restore
    const e = { RATE_LIMIT_KV: kv(), EMAIL_FROM: 'a@b.c', FRONTEND_URL: 'https://x.y' }
    const sb = { from: () => ({ insert: async () => ({ error: null }) }) }
    await m.mod.sendOutcomeFollowUp(e, sb, 'a@x.co', 'A', { unsubscribeUrl: 'https://api.x/api/outcomes/unsubscribe?token=t' })
    await m.mod.sendOutcomeFollowUp(e, sb, 'b@x.co', 'B')
    expect(sent[0].headers).toEqual({
      'List-Unsubscribe': '<https://api.x/api/outcomes/unsubscribe?token=t>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
    expect(sent[1].headers).toBeUndefined()
  })

  it('the sweep hands the unsubscribe URL to the email', async () => {
    const sends = []
    const NOW = Date.parse('2026-10-10T12:00:00Z')
    const row = { id: 's1', user_id: 'u1', outcome_prompt_attempts: 0, users: { email: 'a@x.y', name: 'Ann', status: 'ACTIVE', email_verified: true, deleted_at: null, notify_outcome_followup: true } }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: [row], error: null }
      if (q.table === 'scan_outcomes') return { data: [], error: null }
      if (q.table === 'scans' && q.op === 'update' && q.patch.outcome_prompted_at) return { data: [{ id: 's1' }], error: null }
    })
    const loaded = loadWithStubs('controllers/outcomes.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOutcomeFollowUp: async (...a) => { sends.push(a); return true } },
    })
    restore = loaded.restore
    await loaded.mod.sweepOutcomePrompts(env, db, NOW)
    expect(sends).toHaveLength(1)
    expect(sends[0][4].unsubscribeUrl).toMatch(/^https:\/\/api\.example\.com\/api\/outcomes\/unsubscribe\?token=/)
  })
})

// ── restored by this round: HEAD had lost these (commit 4746ba4 overwrote files with older copies) ────────────
describe('regression: code a later commit silently reverted', () => {
  it('rateLimiter exports forgetTrustedDevices (Auth round 8) alongside the profile limiters', () => {
    expect(typeof rl.forgetTrustedDevices).toBe('function')
    expect(typeof rl.profilePdf).toBe('function')
    expect(typeof rl.profileDocx).toBe('function')
  })
  it('constants carry the per-currency price table (Payments round 12) and its helpers', () => {
    const c = require('../src/config/constants.js')
    expect(c.PRICES_BY_CURRENCY.USD.standard.FIX).toBe(c.PRICE_FIX)
    expect(typeof c.isSupportedCurrency).toBe('function')
    expect(typeof c.activeCurrency).toBe('function')
    expect(c.isSupportedCurrency({ PAYSTACK_CURRENCY: 'USD' })).toBe(true)
    expect(c.isSupportedCurrency({ PAYSTACK_CURRENCY: 'ZZZ' })).toBe(false)
  })
  it('validateEnv runs to completion (it threw on every request while isSupportedCurrency was missing)', () => {
    const { validateEnv } = require('../src/lib/env.js')
    expect(() => validateEnv({ NODE_ENV: 'production' })).not.toThrow()
  })
})
