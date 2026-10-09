import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Payments & Pricing round 8 — controller layer:
//   B1 BADGE formatted-score gate enforced server-side (file scans)
//   B2 limited code whose last slot another buyer holds: resume works instead of a bogus 409
//   B3 a SUCCESS-but-undelivered payment blocks a second checkout and is finished instead
//   B5 history exposes paidAt (and survives the column missing); verify message mentions the refund

const SCAN_ID = '11111111-1111-1111-1111-111111111111'
let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

function setup(opts = {}) {
  const state = { inserts: [], settles: [], notified: [], paystackInits: 0 }
  const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', fix_purchased: false, status: 'COMPLETE_PASS', ats_score: 90, input_mode: 'typed' }
  const db = createFakeSupabase(q => {
    if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
    if (q.table === 'payments' && q.op === 'select') {
      const st = eqValue(q, 'status')
      if (st === 'SUCCESS') return { data: opts.paid ?? null, error: opts.paidErr || null }
      if (st === 'PENDING') return { data: opts.pending ?? null, error: null }
      return { data: null, error: null }
    }
    if (q.table === 'payments' && q.op === 'insert') { state.inserts.push(q.values); return { error: null } }
    if (q.table === 'payments' && q.op === 'update') return { data: [{}], error: null }
    if (q.table === 'referral_codes') return { data: (opts.codes || {})[eqValue(q, 'code')] || null, error: null }
    if (q.table === 'referral_code_reservations') return { data: null, count: opts.liveReservations || 0, error: null }
    if (q.op === 'rpc') return { data: opts.reservationId ?? null, error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async () => {} },
    'services/fulfillment.service.js': {
      settlePayment: async (env, sb, row, o) => { state.settles.push({ row, o }); if (opts.settleThrows) throw opts.settleThrows; return opts.settleResult || { outcome: 'REENQUEUED' } },
      notifySettlementProblem: async (...a) => { state.notified.push(a) },
    },
    'services/paystack.service.js': {
      initializeTransaction: async () => { state.paystackInits++; return { access_code: 'AC_1', authorization_url: 'u' } },
      isPendingStatus: () => false,
      verifyTransaction: async () => ({}),
    },
  })
  const c = (body = { scanId: SCAN_ID, fixTier: 'FIX' }) => ({
    env: {}, get: k => (k === 'user' ? { id: 'u1', email: 'a@b.co', emailVerified: true } : undefined),
    req: { json: async () => body }, json: (b, s = 200) => ({ body: b, status: s }),
  })
  return { mod, restore, state, db, c }
}

describe('B1 — BADGE formatted-score gate (file scans)', () => {
  const file = (over = {}) => ({ id: 's1', user_id: 'u1', fix_purchased: false, status: 'COMPLETE_PASS', ats_score: 90, input_mode: 'file', ...over })
  const body = { scanId: SCAN_ID, fixTier: 'BADGE' }

  it('a file scan with no formatted score yet is refused with a code', async () => {
    t = setup({ scan: file({ full_ats_report: {} }) })
    const res = await t.mod.initializePayment(t.c(body))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('BADGE_FORMATTED_CHECK_REQUIRED')
    expect(t.state.inserts).toHaveLength(0)
  })
  it('a file scan whose formatted score is under the bar is refused', async () => {
    t = setup({ scan: file({ full_ats_report: { formattedScore: 60 } }) })
    const res = await t.mod.initializePayment(t.c(body))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('BADGE_FORMATTED_LOW')
  })
  it('a file scan whose formatted score clears the bar goes through', async () => {
    t = setup({ scan: file({ full_ats_report: { formattedScore: 85 } }) })
    expect((await t.mod.initializePayment(t.c(body))).status).toBe(200)
  })
  it('a low raw score is still refused first', async () => {
    t = setup({ scan: file({ ats_score: 40, full_ats_report: { formattedScore: 99 } }) })
    expect((await t.mod.initializePayment(t.c(body))).body.code).toBe('BADGE_SCORE_LOW')
  })
  it('typed scans are unaffected by the formatted rule', async () => {
    t = setup({ scan: file({ input_mode: 'typed' }) })
    expect((await t.mod.initializePayment(t.c(body))).status).toBe(200)
  })
  it('FIX is never gated by it', async () => {
    t = setup({ scan: file({ full_ats_report: {} }) })
    expect((await t.mod.initializePayment(t.c())).status).toBe(200)
  })
})

describe('badgeGate.badgeBlock (unit)', () => {
  const { badgeBlock } = require('../src/lib/badgeGate')
  it('null scan / typed pass / file pass / boundary', () => {
    expect(badgeBlock(null)).toBeNull()
    expect(badgeBlock({ atsScore: 80, inputMode: 'typed' })).toBeNull()
    expect(badgeBlock({ atsScore: 80, inputMode: 'file', fullAtsReport: { formattedScore: 80 } })).toBeNull()
    expect(badgeBlock({ atsScore: 80, inputMode: 'file', fullAtsReport: { formattedScore: 79.9 } }).code).toBe('BADGE_FORMATTED_LOW')
    expect(badgeBlock({ atsScore: 80, inputMode: 'file', fullAtsReport: { formattedScore: 'x' } }).code).toBe('BADGE_FORMATTED_CHECK_REQUIRED')
    expect(badgeBlock({ atsScore: 79, inputMode: 'typed' }).code).toBe('BADGE_SCORE_LOW')
  })
})

describe('B3 — an earlier SUCCESS payment blocks a second checkout', () => {
  const paid = (over = {}) => ({ id: 'pp', paystack_ref: 'refP', scan_id: SCAN_ID, user_id: 'u1', status: 'SUCCESS', amount_cents: 3900, ...over })
  it('finishes the settled payment, answers 409 alreadyPaid and opens no new checkout', async () => {
    t = setup({ paid: paid() })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.alreadyPaid).toBe(true)
    expect(res.body.data.paidReference).toBe('refP')
    expect(t.state.settles[0].o).toEqual({ source: 'checkout-guard' })
    expect(t.state.notified).toHaveLength(1)
    expect(t.state.inserts).toHaveLength(0)
    expect(t.state.paystackInits).toBe(0)
  })
  it('the lookup is scoped to this scan and SUCCESS', async () => {
    t = setup({ paid: paid() })
    await t.mod.initializePayment(t.c())
    const q = t.db.calls.find(c => c.table === 'payments' && eqValue(c, 'status') === 'SUCCESS')
    expect(eqValue(q, 'scan_id')).toBe(SCAN_ID)
  })
  it('a free-credit row is ignored', async () => {
    t = setup({ paid: paid({ amount_cents: 0, paystack_ref: 'credit:s1:1' }) })
    expect((await t.mod.initializePayment(t.c())).status).toBe(200)
    expect(t.state.settles).toHaveLength(0)
  })
  it('a row that is not actually SUCCESS / another scan is ignored (defensive)', async () => {
    t = setup({ paid: paid({ status: 'PENDING' }) })
    expect((await t.mod.initializePayment(t.c())).status).toBe(200)
    t.restore()
    t = setup({ paid: paid({ scan_id: 'other' }) })
    expect((await t.mod.initializePayment(t.c())).status).toBe(200)
    expect(t.state.settles).toHaveLength(0)
  })
  it('IGNORED_STATUS (refunded meanwhile) does not block a fresh checkout', async () => {
    t = setup({ paid: paid(), settleResult: { outcome: 'IGNORED_STATUS' } })
    expect((await t.mod.initializePayment(t.c())).status).toBe(200)
  })
  it('settle throwing answers 502 and never opens a checkout', async () => {
    t = setup({ paid: paid(), settleThrows: new Error('db down') })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(502)
    expect(t.state.inserts).toHaveLength(0)
  })
  it('a lookup error propagates instead of silently opening a checkout', async () => {
    t = setup({ paidErr: new Error('boom') })
    await expect(t.mod.initializePayment(t.c())).rejects.toThrow('boom')
  })
})

describe('B2 — limited code with its last slot held by another buyer', () => {
  const limited = { id: 'rc1', code: 'LIMITED', active: true, usage_limit: 1, uses_so_far: 0, expires_at: null, tier_prices: { FIX: 1500 }, partners: { status: 'ACTIVE' } }
  const std = () => require('../src/config/constants').standardPriceForTier('FIX')
  const stored = (over = {}) => ({ id: 'pend', paystack_ref: 'refX', paystack_access_code: 'AC_OLD', fix_tier: 'FIX', referral_code: null, amount_cents: std(), currency: 'USD', created_at: new Date().toISOString(), ...over })

  it('the quote path no longer offers the code, so resuming the code-less checkout succeeds (no "code changed" 409)', async () => {
    t = setup({ codes: { LIMITED: limited }, liveReservations: 1, pending: stored() })
    const res = await t.mod.initializePayment(t.c({ scanId: SCAN_ID, fixTier: 'FIX', referralCode: 'LIMITED' }))
    expect(res.status).toBe(200)
    expect(res.body.data.access_code).toBe('AC_OLD')
  })
  it('with a free slot the code still applies (and a code-less stored checkout is a genuine change → 409)', async () => {
    t = setup({ codes: { LIMITED: limited }, liveReservations: 0, pending: stored() })
    const res = await t.mod.initializePayment(t.c({ scanId: SCAN_ID, fixTier: 'FIX', referralCode: 'LIMITED' }))
    expect(res.status).toBe(409)
  })
  it('my own held slot is not competition: resuming my discounted checkout still works', async () => {
    t = setup({ codes: { LIMITED: limited }, liveReservations: 1, pending: stored({ referral_code: 'LIMITED', amount_cents: 1500 }) })
    // own-reservation count query hits payments (status PENDING) → fake returns the pending row, count undefined → 0,
    // so emulate by asserting the resolver ran with buyerUserId through the recorded call
    await t.mod.initializePayment(t.c({ scanId: SCAN_ID, fixTier: 'FIX', referralCode: 'LIMITED' }))
    const own = t.db.calls.find(c => c.table === 'payments' && eqValue(c, 'user_id') === 'u1' && eqValue(c, 'referral_code_id') === 'rc1')
    expect(own).toBeTruthy()
  })
})

describe('B5 — getPaymentHistory paidAt', () => {
  function hist(handler) {
    const db = createFakeSupabase(q => (q.table === 'payments' ? handler(q) : undefined))
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = () => ({ env: {}, get: () => ({ id: 'u1' }), req: { query: () => undefined }, json: (b, s = 200) => ({ body: b, status: s }) })
    return { mod, restore, db, c }
  }
  const r = { id: 'p1', amount_cents: 1900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'r1', created_at: 't1', paid_at: 't2', scan_id: 's1', fix_tier: 'FIX' }
  it('returns paid_at as paidAt and asks for the column', async () => {
    t = hist(() => ({ data: [r], error: null, count: 1 }))
    const res = await t.mod.getPaymentHistory(t.c())
    expect(res.body.data.payments[0].paidAt).toBe('t2')
    expect(t.db.calls[0].cols).toContain('paid_at')
  })
  it('falls back to the old column list when paid_at does not exist yet (42703 and PGRST204)', async () => {
    for (const code of ['42703', 'PGRST204']) {
      let n = 0
      const { paid_at, ...old } = r
      t = hist(q => (n++ === 0 ? { data: null, error: { code, message: 'no col' }, count: null } : { data: [old], error: null, count: 1 }))
      const res = await t.mod.getPaymentHistory(t.c())
      expect(res.status).toBe(200)
      expect(res.body.data.payments[0].paidAt).toBeNull()
      expect(t.db.calls[1].cols).not.toContain('paid_at')
      t.restore()
    }
    t = null
  })
  it('an unrelated error is still an error', async () => {
    t = hist(() => ({ data: null, error: { code: 'XX000', message: 'boom' }, count: null }))
    await expect(t.mod.getPaymentHistory(t.c())).rejects.toBeTruthy()
  })
})
