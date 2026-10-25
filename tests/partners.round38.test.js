import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Partners round 38: terms bound to the version shown + acceptance log, payout caps and the terms gate, partial refunds, paused-partner
// attribution, the reason a code does not apply, masked mapper default, the yearly statement fold, code requests.

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv(), ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? 'p1',
    query: k => (over.query || {})[k],
    json: async () => over.body ?? {},
    header: k => (over.headers || {})[String(k).toLowerCase()],
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})
const PARTNER = {
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', payout_method: 'BANK',
  payout_details: { bankName: 'Acme Bank', accountName: 'Coach K', accountNumber: '0123456789' },
  payout_details_submitted_at: '2020-01-01T00:00:00.000Z', terms_version: null,
  dashboard_token: 'dtok', dashboard_token_version: 0, commission_rate: 0.1, notify_conversions: true,
}

function setup(o = {}) {
  const st = { inserts: [], updates: [], rpcs: [], emails: [], alerts: [] }
  const partner = o.partner || PARTNER
  const db = createFakeSupabase(q => {
    if (q.op === 'rpc') { st.rpcs.push(q); return o.rpc ? o.rpc(q) : { data: null, error: null } }
    if (q.table === 'partners' && q.op === 'select') {
      const eq = q.filters.find(f => f[0] === 'eq' && /token/.test(f[1]))
      if (eq) return { data: eq[1] === 'dashboard_token' && eq[2] === 'dtok' ? partner : null, error: null }
      return { data: partner, error: null }
    }
    if (q.table === 'partners' && q.op === 'update') { st.updates.push(q.patch); return { data: { ...partner, ...q.patch }, error: null } }
    if (q.table === 'partner_terms_acceptances' && q.op === 'insert') { st.inserts.push(q.values); return { data: null, error: null } }
    if (q.table === 'referral_codes' && q.op === 'select') return { data: o.code ?? null, error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') return o.ledger ? o.ledger(q) : { data: null, error: null }
    return undefined
  })
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert: async (...a) => { st.alerts.push(a); return true },
      sendPartnerTermsAccepted: async () => true,
      sendPartnerBalanceAdjusted: async (...a) => { st.emails.push(a); return true },
    },
  })
  return { ...m, st, db }
}

describe('terms acceptance is bound to the version on screen', () => {
  it('refuses (409) when the terms moved on, records nothing', async () => {
    t = setup()
    const res = await t.mod.acceptPartnerTerms(ctxOf({ headers: { 'x-partner-token': 'dtok' }, body: { version: '2020-01' } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TERMS_VERSION_CHANGED')
    expect(t.st.updates).toHaveLength(0)
    expect(t.st.inserts).toHaveLength(0)
  })
  it('records the version it was shown, and appends to the acceptance log', async () => {
    t = setup()
    const first = await t.mod.acceptPartnerTerms(ctxOf({ headers: { 'x-partner-token': 'dtok' }, body: {} }))
    const version = first.body.termsVersion
    t.restore(); t = setup()
    const res = await t.mod.acceptPartnerTerms(ctxOf({ headers: { 'x-partner-token': 'dtok' }, body: { version } }))
    expect(res.body).toMatchObject({ success: true, alreadyAccepted: false })
    expect(t.st.updates[0]).toMatchObject({ terms_version: version })
    expect(t.st.inserts[0]).toMatchObject({ partner_id: 'p1', version, source: 'dashboard' })
  })
  it('an older client that sends no version still works (as before)', async () => {
    t = setup()
    const res = await t.mod.acceptPartnerTerms(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(res.body.success).toBe(true)
  })
})

describe('payoutDetailsEqual', () => {
  it('ignores spacing and case in identifiers and re-typed names', () => {
    t = setup()
    const eq = t.mod.payoutDetailsEqual
    expect(eq('BANK', { bankName: 'Equity  Bank', accountNumber: '0123 4567 89' }, 'BANK', { bankName: 'equity bank', accountNumber: '0123456789' })).toBe(true)
  })
  it('a name that differs only by where a space sits is a different destination', () => {
    t = setup()
    const eq = t.mod.payoutDetailsEqual
    expect(eq('BANK', { accountName: 'Jo Hn' }, 'BANK', { accountName: 'John' })).toBe(false)
    expect(eq('BANK', { accountNumber: '1234' }, 'BANK', { accountNumber: '1235' })).toBe(false)
  })
})

describe('payout guards', () => {
  it('an amount beyond int4 is refused at the boundary, not as a 500 from the RPC', async () => {
    t = setup()
    await expect(t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 2147483648 } }))).rejects.toThrow()
  })
  it('PAYOUT_REQUIRES_CURRENT_TERMS refuses a partner on an old version unless confirmed', async () => {
    t = setup()
    const res = await t.mod.adminRecordPayout(ctxOf({ env: { PAYOUT_REQUIRES_CURRENT_TERMS: '1' }, body: { amountCents: 1000 } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TERMS_NOT_ACCEPTED')
  })
  it('the gate is off by default', async () => {
    t = setup()
    let code
    try { code = (await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 1000 } }))).body?.code } catch (_) { code = 'threw-later' }
    expect(code).not.toBe('TERMS_NOT_ACCEPTED')
  })
  it('confirmedTerms passes the gate', async () => {
    t = setup()
    let code
    try { code = (await t.mod.adminRecordPayout(ctxOf({ env: { PAYOUT_REQUIRES_CURRENT_TERMS: '1' }, body: { amountCents: 1000, confirmedTerms: true } }))).body?.code } catch (_) { code = 'threw-later' }
    expect(code).not.toBe('TERMS_NOT_ACCEPTED')
  })
})

describe('trackClick for a paused partner', () => {
  const click = (t0, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537') => t0.mod.trackClick(ctxOf({ body: { code: 'PAUSEME' }, headers: { 'user-agent': ua } }))
  const row = status => ({ id: 'c1', code: 'PAUSEME', active: true, expires_at: null, usage_limit: null, uses_so_far: 0, user_id: null, partner_id: 'p1', partners: { status, email: 'k@x.co', previous_emails: [], commission_rate: 0.1 } })
  it('says retry:true so the browser keeps the visitor’s stored code', async () => {
    t = setup({ code: row('PAUSED') })
    const res = await click(t)
    expect(res.body).toMatchObject({ valid: false, retry: true })
  })
  it('an ENDED partner stays a plain invalid (no retry)', async () => {
    t = setup({ code: row('ENDED') })
    const res = await click(t)
    expect(res.body.valid).toBe(false)
    expect(res.body.retry).toBeUndefined()
  })
  it('an unknown code is a plain invalid', async () => {
    t = setup({ code: null })
    const res = await click(t)
    expect(res.body.valid).toBe(false)
    expect(res.body.retry).toBeUndefined()
  })
})

describe('adminReverseSale — partial refund', () => {
  const SALE = { id: 'l1', payment_id: 'pay1', partner_id: 'p1', kind: 'SALE', reverses_ledger_id: null, commission_amount_cents: 1000, commission_rate: 0.2, gross_amount_cents: 5000, currency: 'USD', payout_id: null }
  const ledger = () => ({ data: SALE, error: null })
  it('takes back the refunded share at the stamped rate through the capped RPC', async () => {
    t = setup({ ledger, rpc: () => ({ data: { status: 'ok', row: { adjustment_reason: 'x' }, remaining_cents: 600 }, error: null }) })
    const res = await t.mod.adminReverseSale(ctxOf({ params: { id: 'p1', ledgerId: 'l1' }, body: { reason: 'goodwill refund', refundCents: 2000 } }))
    expect(res.body).toMatchObject({ success: true, partial: true, commissionCents: -400, remainingCents: 600 })
    expect(t.st.rpcs[0].name).toBe('adjust_sale_commission')
    expect(t.st.rpcs[0].args).toMatchObject({ p_ledger_id: 'l1', p_amount_cents: 400 })
  })
  it('a refund larger than the sale is refused before anything is written', async () => {
    t = setup({ ledger })
    const res = await t.mod.adminReverseSale(ctxOf({ params: { id: 'p1', ledgerId: 'l1' }, body: { reason: 'goodwill refund', refundCents: 5001 } }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('REFUND_EXCEEDS_SALE')
    expect(t.st.rpcs).toHaveLength(0)
  })
  it('the RPC refusing (more than the sale still earns) comes back as 409 EXCEEDS', async () => {
    t = setup({ ledger, rpc: () => ({ data: { status: 'exceeds', remaining_cents: 100 }, error: null }) })
    const res = await t.mod.adminReverseSale(ctxOf({ params: { id: 'p1', ledgerId: 'l1' }, body: { reason: 'goodwill refund', refundCents: 4000 } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('EXCEEDS')
  })
})

describe('reverseCommission gives back what a partial adjustment already took', () => {
  const run = async partials => {
    const inserts = []
    const db = createFakeSupabase(q => {
      if (q.table === 'commission_ledger' && q.op === 'select' && q.filters.some(f => f[1] === 'payment_id'))
        return { data: { id: 'orig', partner_id: 'p1', referral_code_id: null, gross_amount_cents: 5000, commission_rate: 0.2, commission_amount_cents: 1000, currency: 'USD', payout_id: null }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select' && q.filters.some(f => f[1] === 'adjusts_ledger_id')) return { data: partials, error: null }
      if (q.table === 'commission_ledger' && q.op === 'insert') { inserts.push(q.values); return { data: null, error: null } }
      return undefined
    })
    const out = await require('../src/services/fulfillment.service').reverseCommission(db, 'pay1', 'REFUND')
    return { out, inserts }
  }
  it('inserts a positive correction equal to the partials', async () => {
    const { out, inserts } = await run([{ commission_amount_cents: -400 }, { commission_amount_cents: -100 }])
    expect(out.reversed).toBe(true)
    expect(inserts).toHaveLength(2)
    expect(inserts[1]).toMatchObject({ kind: 'ADJUSTMENT', commission_amount_cents: 500, adjusts_ledger_id: 'orig', partner_id: 'p1' })
  })
  it('adds nothing when there were no partials', async () => {
    const { inserts } = await run([])
    expect(inserts).toHaveLength(1)
  })
})

describe('why a code does not apply', () => {
  const rs = () => require('../src/services/referral.service')
  const base = { id: 'c', code: 'X', active: true, expires_at: null, usage_limit: null, uses_so_far: 0, user_id: null, partners: { status: 'ACTIVE' } }
  it('names expired / exhausted / paused / inactive, and hides personal codes as unknown', () => {
    const { unusableReason } = rs()
    expect(unusableReason(null)).toBe('unknown')
    expect(unusableReason({ ...base, user_id: 'u1' })).toBe('unknown')
    expect(unusableReason({ ...base, active: false })).toBe('inactive')
    expect(unusableReason({ ...base, expires_at: '2020-01-01T00:00:00Z' })).toBe('expired')
    expect(unusableReason({ ...base, usage_limit: 3, uses_so_far: 3 })).toBe('exhausted')
    expect(unusableReason({ ...base, partners: { status: 'PAUSED' } })).toBe('paused')
    expect(unusableReason({ ...base, partners: { status: 'ENDED' } })).toBe('inactive')
    expect(unusableReason(base)).toBe(null)
  })
  it('the price quote carries the reason', () => {
    const { priceForResolvedCode } = rs()
    const out = priceForResolvedCode('FIX', {}, { ...base, expires_at: '2020-01-01T00:00:00Z' })
    expect(out.referralApplied).toBe(false)
    expect(out.referralReason).toBe('expired')
  })
})

describe('mapper and statement', () => {
  it('partnerRowToCamel never returns the stored account number', () => {
    const { partnerRowToCamel } = require('../src/lib/mappers')
    const out = partnerRowToCamel({ id: 'p', payout_method: 'BANK', payout_details: { bankName: 'A', accountName: 'N', accountNumber: '0123456789' }, tax_id: 'enc:v1:x' })
    expect(out.payoutDetails.accountNumber).toBe('…6789')
    expect(JSON.stringify(out)).not.toContain('0123456789')
    expect(out.taxId).toBe(null)
  })
  it('foldStatementMonths keeps sales, reversals and adjustments apart, within the year only', () => {
    t = setup()
    const months = t.mod.foldStatementMonths([
      { created_at: '2026-03-05T10:00:00Z', kind: 'SALE', reverses_ledger_id: null, gross_amount_cents: 5000, commission_amount_cents: 1000 },
      { created_at: '2026-03-20T10:00:00Z', kind: 'SALE', reverses_ledger_id: 'x', gross_amount_cents: -5000, commission_amount_cents: -1000 },
      { created_at: '2026-03-21T10:00:00Z', kind: 'ADJUSTMENT', reverses_ledger_id: null, gross_amount_cents: 0, commission_amount_cents: -250 },
      { created_at: '2025-12-31T23:59:59Z', kind: 'SALE', reverses_ledger_id: null, gross_amount_cents: 900, commission_amount_cents: 90 },
    ], 2026)
    expect(months[2]).toMatchObject({ sales: 1, grossCents: 5000, commissionCents: 1000, reversalCents: -1000, adjustmentCents: -250, netCents: -250 })
    expect(months.reduce((s, m) => s + m.sales, 0)).toBe(1)
  })
})

describe('requestPartnerCode', () => {
  const body = { code: 'mynews', note: 'hello' }
  it('tells the owner once per hour, and refuses a taken code', async () => {
    t = setup()
    const ctx = ctxOf({ headers: { 'x-partner-token': 'dtok' }, body })
    const first = await t.mod.requestPartnerCode(ctx)
    expect(first.body.success).toBe(true)
    expect(t.st.alerts).toHaveLength(1)
    expect(t.st.alerts[0][2]).toContain('MYNEWS')
    const second = await t.mod.requestPartnerCode(ctx)
    expect(second.body.alreadyRequested).toBe(true)
    expect(t.st.alerts).toHaveLength(1)
    t.restore()
    t = setup({ code: { id: 'c', code: 'MYNEWS', partners: { status: 'ACTIVE' } } })
    const taken = await t.mod.requestPartnerCode(ctxOf({ headers: { 'x-partner-token': 'dtok' }, body }))
    expect(taken.status).toBe(409)
    expect(taken.body.code).toBe('CODE_TAKEN')
  })
  it('a paused partner cannot ask', async () => {
    t = setup({ partner: { ...PARTNER, status: 'PAUSED' } })
    const res = await t.mod.requestPartnerCode(ctxOf({ headers: { 'x-partner-token': 'dtok' }, body }))
    expect(res.status).toBe(409)
  })
})
