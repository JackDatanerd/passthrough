import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 13 — B1 register keeps the attribution start, B4 per-payment alert key, B5 reserved partner email,
// plus the admin dashboard-link resend and the per-code sign-up count.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://passthrough.dev', ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1', email: 'a@x.co' } : undefined),
  req: {
    param: () => A, query: () => undefined,
    json: async () => (over.body ?? {}), header: () => undefined,
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})

function loadController(db, emailStubs = {}) {
  return loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/turnstile.js': { verifyTurnstile: async () => true },
    'services/email.service.js': { sendOwnerAlert: async () => {}, ...emailStubs },
  })
}

describe('B5 — the removed-partner placeholder domain cannot be used for a live partner', () => {
  const body = email => ({ name: 'N', email })
  it('admin create refuses it', async () => {
    t = loadController(createFakeSupabase(() => ({ data: null, error: null })))
    await expect(t.mod.adminCreatePartner(ctxOf({ body: body('x@removed.invalid') }))).rejects.toThrow()
  })
  it('admin email edit refuses it', async () => {
    t = loadController(createFakeSupabase(() => ({ data: null, error: null })))
    await expect(t.mod.adminUpdatePartner(ctxOf({ body: { email: 'X@Removed.Invalid' } }))).rejects.toThrow()
  })
  it('the public application refuses it', async () => {
    t = loadController(createFakeSupabase(() => ({ data: null, error: null })))
    await expect(t.mod.applyAsPartner(ctxOf({ body: { name: 'N', email: 'x@removed.invalid', acceptTerms: true } }))).rejects.toThrow()
  })
})

describe('B4 — a conversion-failure alert is keyed per payment and step', () => {
  it('passes a dedupeKey so two different payments are both reported', async () => {
    const calls = []
    t = loadWithStubs('services/referral.service.js', {
      'services/email.service.js': { sendOwnerAlert: async (...a) => { calls.push(a) } },
    })
    await t.mod.notifyConversionFailure({}, { id: 'pay1', paystack_ref: 'r1' }, { reason: 'ledger-insert' }, 's')
    await t.mod.notifyConversionFailure({}, { id: 'pay2', paystack_ref: 'r2' }, { reason: 'ledger-insert' }, 's')
    await t.mod.notifyConversionFailure({}, { id: 'pay1', paystack_ref: 'r1' }, { reason: 'code-lookup' }, 's')
    const keys = calls.map(c => c[3]?.dedupeKey)
    expect(keys).toEqual(['pay1:ledger-insert', 'pay2:ledger-insert', 'pay1:code-lookup'])
    expect(new Set(keys).size).toBe(3)
  })
})

describe('B1 — registering carries the browser capture time', () => {
  const auth = fs.readFileSync(path.join(__dirname, '../src/controllers/auth.controller.js'), 'utf8')
  const register = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Register.jsx'), 'utf8')
  it('the register schema accepts it and hands it to setUserAttribution', () => {
    expect(auth).toMatch(/referralCapturedAt: z\.string\(\)\.max\(40\)\.nullish\(\)\.catch\(undefined\)/)
    expect(auth).toMatch(/setUserAttribution\(supabase, \{ id: user\.id, email: user\.email \}, referralCode, referralCapturedAt \|\| undefined\)/)
  })
  it('the Register page sends it', () => {
    expect(register).toMatch(/referralCapturedAt: getStoredReferralCapturedAt\(\) \|\| undefined/)
  })
  it('setUserAttribution then keeps the original start (not now) and refuses an expired one', async () => {
    const DAY = 24 * 3600 * 1000
    const updates = []
    t = loadWithStubs('services/referral.service.js', {})
    const GOOD = { id: 'c', code: 'K20', active: true, expires_at: null, usage_limit: null, uses_so_far: 0, tier_prices: { FIX: 3900 }, partners: { status: 'ACTIVE', email: 'k@x.co' } }
    const db = createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: GOOD, error: null }
      if (q.table === 'users' && q.op === 'update') { updates.push(q.patch); return { data: null, error: null } }
      if (q.table === 'users' && q.op === 'select') return { data: null, error: null }
      return undefined
    })
    const at = new Date(Date.now() - 29 * DAY).toISOString()
    await t.mod.setUserAttribution(db, { id: 'u', email: 'b@x.co' }, 'K20', at)
    expect(updates[0].referred_at).toBe(at)
    const out = await t.mod.setUserAttribution(db, { id: 'u', email: 'b@x.co' }, 'K20', new Date(Date.now() - 31 * DAY).toISOString())
    expect(out).toEqual({ stored: false, reason: 'expired' })
  })
})

describe('gap — admin can re-send the dashboard link', () => {
  const PARTNER = { name: 'Coach', email: 'k@x.co', payout_details_token: 'ptok', dashboard_token: 'dtok' }
  it('scope dashboard emails the dashboard link, not the payout link', async () => {
    const sent = []
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: PARTNER, error: null } : { data: null, error: null }))
    t = loadController(db, { sendPartnerLinksRecovery: async (...a) => { sent.push(a); return true }, sendPartnerPayoutDetailsRequest: async () => { throw new Error('wrong link') } })
    const out = await t.mod.adminResendPayoutLink(ctxOf({ body: { scope: 'dashboard' } }))
    expect(out.body.success).toBe(true)
    expect(sent[0][4]).toBe('https://passthrough.dev/partner/dashboard?token=dtok')
  })
  it('a failed send hands back the dashboard URL as a fallback, and no scope still sends the payout link', async () => {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: PARTNER, error: null } : { data: null, error: null }))
    t = loadController(db, { sendPartnerLinksRecovery: async () => false, sendPartnerPayoutDetailsRequest: async () => true })
    const failed = await t.mod.adminResendPayoutLink(ctxOf({ body: { scope: 'dashboard' } }))
    expect(failed.body.success).toBe(false)
    expect(failed.body.dashboardUrl).toMatch(/token=dtok$/)
    const payout = await t.mod.adminResendPayoutLink(ctxOf({ body: {} }))
    expect(payout.body.success).toBe(true)
    expect(payout.body.dashboardUrl).toBeUndefined()
  })
})

describe('gap — per-code sign-up count', () => {
  const ROW = { id: A, name: 'Coach', email: 'k@x.co', status: 'ACTIVE', commission_rate: 0.2, referral_codes: [{ id: 'c1', partner_id: A, code: 'K20', clicks: 10, uses_so_far: 1, active: true, tier_prices: { FIX: 3900 } }, { id: 'c2', partner_id: A, code: 'K30', clicks: 0, uses_so_far: 0, active: true, tier_prices: { FIX: 3900 } }], commission_ledger: [], payouts: [] }
  const run = async usersResult => {
    const asked = []
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: ROW, error: null }
      if (q.table === 'users') { asked.push(q.filters.find(f => f[1] === 'referred_by_code')?.[2]); return typeof usersResult === 'function' ? usersResult(asked[asked.length - 1]) : usersResult }
      return { data: [], error: null }
    })
    t = loadController(db)
    const out = await t.mod.adminGetPartner(ctxOf())
    return { codes: out.body.data.referralCodes, asked }
  }
  it('adds an aggregate signups count to each code, queried by the code text', async () => {
    const { codes, asked } = await run(code => ({ count: code === 'K20' ? 7 : 0, data: null, error: null }))
    expect(asked.sort()).toEqual(['K20', 'K30'])
    expect(codes.find(c => c.code === 'K20').signups).toBe(7)
    expect(codes.find(c => c.code === 'K30').signups).toBe(0)
  })
  it('a failed count leaves signups null instead of showing a wrong 0', async () => {
    const { codes } = await run({ data: null, error: { message: 'boom' } })
    expect(codes.every(c => c.signups === null)).toBe(true)
  })
})
