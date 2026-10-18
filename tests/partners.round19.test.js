import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 19: strict numeric env again, the missing-commissions list, the terms notice vs erased partners, the
// reversal email flag, and channel visits from a returning visitor.

let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', PAYSTACK_CURRENCY: 'USD', ...(over.env || {}) },
  get: () => ({ id: 'admin-1' }),
  req: {
    param: n => (over.params ? over.params[n] : 'p1'), query: () => undefined,
    json: async () => over.body ?? {},
    header: n => (String(n).toLowerCase() === 'user-agent' ? 'Mozilla/5.0 (Linux; Android 12) Chrome/120 Mobile Safari/537.36' : undefined),
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

function load(resolver = () => undefined, extra = {}) {
  const db = createFakeSupabase(resolver)
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async () => true, sendPartnerTermsUpdate: async () => true },
    'services/referral.service.js': {
      lookupCode: async () => ({ id: 'rc1' }), isCodeUsable: () => true,
      notifyPartnerReversal: async () => true, ...(extra.referral || {}),
    },
  })
  return { ...m, db }
}

describe('strict numeric env in the partner controller (round 19)', () => {
  it('a fractional or blank value never turns a guard off', async () => {
    t = load()
    const terms = async env => (await t.mod.getProgramTerms(ctxOf({ env }))).body.data
    expect((await terms({ PAYOUT_DETAILS_HOLD_HOURS: '0.5' })).payoutDetailsHoldHours).toBe(48)
    expect((await terms({ PAYOUT_DETAILS_HOLD_HOURS: '0' })).payoutDetailsHoldHours).toBe(0)
    expect((await terms({ COMMISSION_HOLD_DAYS: '7d' })).holdDays).toBe(0)
    expect((await terms({ COMMISSION_HOLD_DAYS: '14' })).holdDays).toBe(14)
    expect((await terms({ COMMISSION_MIN_PAYOUT_CENTS: '2000c' })).minPayoutCents).toBe(0)
  })
})

describe('terms notice and erased partners (round 19)', () => {
  it('never selects an erased partner', async () => {
    t = load(q => (q.table === 'partners' ? { data: [], count: 0, error: null } : undefined))
    await t.mod.adminSendTermsNotice(ctxOf())
    const q = t.db.calls.find(c => c.table === 'partners' && c.op === 'select')
    expect(q.filters.some(f => f[0] === 'not' && f[1] === 'email' && f[2] === 'ilike' && /removed\.invalid$/.test(f[3]))).toBe(true)
  })
})

describe('adminListUnrecordedCommissions skips payments that earn nothing by design (round 19)', () => {
  const pay = (id, scan) => ({ id, scan_id: scan, paystack_ref: `ref_${id}`, amount_cents: 5000, currency: 'USD', created_at: '2026-10-01T00:00:00Z', referral_codes: { code: 'ANN10', partners: { id: 'p1', name: 'Ann' } } })
  it('drops a duplicate, a payment with no scan, and one for a deleted account', async () => {
    const pays = [pay('real', 's1'), pay('dup', 's2'), pay('noscan', null), pay('gone', 's3')]
    t = load(q => {
      if (q.table === 'payments') return { data: pays, error: null }
      if (q.table === 'commission_ledger') return { data: [], error: null }
      if (q.table === 'scans') return { data: [
        { id: 's1', user_id: 'u1', fix_payment_id: 'real' },
        { id: 's2', user_id: 'u1', fix_payment_id: 'someone-else' },
        { id: 's3', user_id: 'u2', fix_payment_id: 'gone' }], error: null }
      if (q.table === 'users') return { data: [{ id: 'u1', deleted_at: null }, { id: 'u2', deleted_at: '2026-09-01T00:00:00Z' }], error: null }
      return undefined
    })
    const out = await t.mod.adminListUnrecordedCommissions(ctxOf())
    expect(out.body.data.map(r => r.reference)).toEqual(['ref_real'])
    expect(out.body.truncated).toBe(false)
  })
  it('says so when more payments exist than were checked', async () => {
    const page = Array.from({ length: 500 }, (_, i) => pay(`p${i}`, 's1'))
    t = load(q => {
      if (q.table === 'payments') return { data: page, error: null }
      if (q.table === 'commission_ledger') return { data: page.map(p => ({ payment_id: p.id })), error: null }
      return undefined
    })
    const out = await t.mod.adminListUnrecordedCommissions(ctxOf())
    expect(out.body.truncated).toBe(true)
    expect(out.body.checked).toBe(2000)
  })
})

describe('adminReverseSale emailed flag (round 19)', () => {
  const original = { id: 'l1', payment_id: 'pay1', partner_id: 'p1', kind: 'SALE', reverses_ledger_id: null, commission_amount_cents: 250, payout_id: null, referral_code_id: 'rc1', gross_amount_cents: 1000, commission_rate: 0.25, currency: 'USD' }
  const resolver = q => {
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: original, error: null }
    return undefined
  }
  it('reports emailed:false when the partner mail did not go', async () => {
    t = load(resolver, { referral: { notifyPartnerReversal: async () => false } })
    const out = await t.mod.adminReverseSale(ctxOf({ params: { id: 'p1', ledgerId: 'l1' }, body: { reason: 'Own second account' } }))
    expect(out.body.emailed).toBe(false)
  })
})

describe('trackClick for a returning visitor on another channel (round 19)', () => {
  it('counts the channel visit but not a new code click', async () => {
    t = load()
    await t.mod.trackClick(ctxOf({ body: { code: 'ANN10', sub: 'yt', subOnly: true } }))
    expect(t.db.calls.some(c => c.name === 'increment_referral_sub_clicks')).toBe(true)
    expect(t.db.calls.some(c => c.name === 'increment_referral_code_clicks')).toBe(false)
  })
})
