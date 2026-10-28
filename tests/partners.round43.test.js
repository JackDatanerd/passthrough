import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Partners round 43: a partner's own pages never add cents of different currencies together. After the platform currency was changed the
// ledger can hold both: the yearly statement is one block per currency, the dashboard says so, and every conversion row carries its currency.

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv() },
  get: () => undefined,
  req: { param: () => 'p1', query: k => (over.query || {})[k], json: async () => ({}), header: k => (over.headers || {})[String(k).toLowerCase()] },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})
const PARTNER = {
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', payout_method: null, payout_details: null, payout_details_submitted_at: null,
  terms_version: null, dashboard_token: 'dtok', dashboard_token_version: 0, commission_rate: 0.1, notify_conversions: true, referral_codes: [], payouts: [],
}
const row = (over) => ({ id: over.id, kind: 'SALE', reverses_ledger_id: null, adjusts_ledger_id: null, gross_amount_cents: 5000, commission_amount_cents: 500,
  currency: 'USD', payout_id: null, referral_code_id: null, created_at: '2026-03-05T10:00:00Z', ...over })
const LEDGER = [
  row({ id: 'a', commission_amount_cents: 1000, created_at: '2026-03-05T10:00:00Z' }),
  row({ id: 'b', commission_amount_cents: 700000, gross_amount_cents: 7000000, currency: 'KES', created_at: '2026-04-05T10:00:00Z' }),
  row({ id: 'c', commission_amount_cents: 300, currency: null, created_at: '2026-05-05T10:00:00Z' }),   // no currency of its own = the platform's
]

function setup({ ledger = LEDGER, payouts = [] } = {}) {
  const db = createFakeSupabase(q => {
    if (q.table === 'partners' && q.op === 'select') {
      const eq = q.filters.find(f => f[0] === 'eq' && /token/.test(f[1]))
      if (eq) return { data: eq[1] === 'dashboard_token' && eq[2] === 'dtok' ? PARTNER : null, error: null }
      return { data: PARTNER, error: null }
    }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: ledger, error: null }
    if (q.table === 'payouts' && q.op === 'select') return { data: payouts, error: null }
    if (q.table === 'referral_sub_clicks') return { data: [], error: null }
    return undefined
  })
  return loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
}

describe('yearly statement is per currency', () => {
  it('buildStatementCurrencies keeps each currency apart, platform currency first, null currency = platform', () => {
    t = setup()
    const out = t.mod.buildStatementCurrencies(LEDGER, [
      { amount_cents: 400, currency: 'USD' }, { amount_cents: 650000, currency: 'KES' },
    ], 2026, 'USD')
    expect(out.map(b => b.currency)).toEqual(['USD', 'KES'])
    expect(out[0]).toMatchObject({ earnedCents: 1300, paidCents: 400, payoutCount: 1 })
    expect(out[1]).toMatchObject({ earnedCents: 700000, paidCents: 650000, payoutCount: 1 })
  })
  it('the platform currency block is always present, even with nothing in the year', () => {
    t = setup()
    const out = t.mod.buildStatementCurrencies([], [], 2026, 'USD')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ currency: 'USD', earnedCents: 0, paidCents: 0, payoutCount: 0 })
  })
  it('getPartnerStatement: top-level figures are the platform currency only; the other currency is its own block', async () => {
    t = setup({ payouts: [{ amount_cents: 400, currency: 'USD', paid_at: '2026-06-01T00:00:00Z', voided_at: null }, { amount_cents: 650000, currency: 'KES', paid_at: '2026-06-02T00:00:00Z', voided_at: null }] })
    const res = await t.mod.getPartnerStatement(ctxOf({ headers: { 'x-partner-token': 'dtok' }, query: { year: '2026' } }))
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.currency).toBe('USD')
    expect(d.earnedCents).toBe(1300)            // was 701300: KES cents added to USD cents
    expect(d.paidCents).toBe(400)               // was 650400
    expect(d.payoutCount).toBe(1)
    expect(d.currencies.find(b => b.currency === 'KES')).toMatchObject({ earnedCents: 700000, paidCents: 650000 })
  })
})

describe('dashboard and conversions carry currency', () => {
  it('unpaidByCurrency sums unpaid rows per currency and ignores paid ones', () => {
    t = setup()
    expect(t.mod.unpaidByCurrency([...LEDGER, row({ id: 'd', commission_amount_cents: 99, payout_id: 'po1' })], 'USD')).toEqual({ USD: 1300, KES: 700000 })
  })
  it('getPartnerDashboard flags a ledger that spans currencies and gives each its own figure', async () => {
    t = setup()
    const res = await t.mod.getPartnerDashboard(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(res.status).toBe(200)
    expect(res.body.data.mixedCurrency).toBe(true)
    expect(res.body.data.unpaidByCurrency).toEqual({ USD: 1300, KES: 700000 })
    expect(res.body.data.conversions.find(c => c.id === 'b').currency).toBe('KES')
  })
  it('a single-currency ledger is not flagged', async () => {
    t = setup({ ledger: [LEDGER[0], LEDGER[2]] })
    const res = await t.mod.getPartnerDashboard(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(res.body.data.mixedCurrency).toBe(false)
  })
  it('getPartnerConversions returns each row\'s own currency', async () => {
    t = setup()
    const res = await t.mod.getPartnerConversions(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(res.body.data.map(r => r.currency)).toEqual(expect.arrayContaining(['USD', 'KES', null]))
  })
})
