import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 18: per-channel clicks, reject one sale, the missing-commissions list, the terms notice reaching paused
// partners, a signup count that respects the attribution window, and real handsets no longer mistaken for bots.

let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD' },
  get: () => ({ id: 'admin-1' }),
  req: {
    param: n => (over.params ? over.params[n] : 'p1'), query: () => undefined,
    json: async () => over.body ?? {},
    header: n => (String(n).toLowerCase() === 'user-agent' ? (over.ua ?? 'Mozilla/5.0 (Linux; Android 12; TECNO KG5k) Chrome/120 Mobile Safari/537.36') : undefined),
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
      notifyPartnerReversal: async () => {}, ...(extra.referral || {}),
    },
    ...(extra.stubs || {}),
  })
  return { ...m, db }
}

describe('trackClick (round 18)', () => {
  it('counts the channel tag as well as the code', async () => {
    t = load()
    const out = await t.mod.trackClick(ctxOf({ body: { code: 'ANN10', sub: ' NewsLetter ' } }))
    expect(out.body.valid).toBe(true)
    const subCall = t.db.calls.find(c => c.op === 'rpc' && c.name === 'increment_referral_sub_clicks')
    expect(subCall.args).toEqual({ p_code: 'ANN10', p_sub: 'newsletter' })
  })
  it('sends no channel call when there is no usable tag', async () => {
    t = load()
    await t.mod.trackClick(ctxOf({ body: { code: 'ANN10', sub: 'two words' } }))
    expect(t.db.calls.some(c => c.name === 'increment_referral_sub_clicks')).toBe(false)
    expect(t.db.calls.some(c => c.name === 'increment_referral_code_clicks')).toBe(true)
  })
  it('still treats crawlers as bots, but a real "CUBOT" handset is a visitor', async () => {
    t = load()
    await t.mod.trackClick(ctxOf({ body: { code: 'ANN10' }, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }))
    expect(t.db.calls.some(c => c.name === 'increment_referral_code_clicks')).toBe(false)
    await t.mod.trackClick(ctxOf({ body: { code: 'ANN10' }, ua: 'Mozilla/5.0 (Linux; Android 11; CUBOT P40) Chrome/120 Mobile Safari/537.36' }))
    expect(t.db.calls.some(c => c.name === 'increment_referral_code_clicks')).toBe(true)
  })
})

describe('buildSubMix with clicks (round 18)', () => {
  it('shows a tag that has visits but no sale yet, and carries clicks next to sales', () => {
    t = load()
    const rows = [{ id: 'l1', attribution_sub: 'news', commission_amount_cents: 100 }]
    const out = t.mod.buildSubMix(rows, { news: 40, yt: 12 })
    expect(out).toEqual([
      { sub: 'news', sales: 1, commissionCents: 100, clicks: 40 },
      { sub: 'yt', sales: 0, commissionCents: 0, clicks: 12 },
    ])
  })
})

describe('adminReverseSale (round 18)', () => {
  const sale = { id: 'l1', payment_id: 'pay1', partner_id: 'p1', kind: 'SALE', reverses_ledger_id: null, commission_amount_cents: 250, payout_id: null }
  const original = { ...sale, referral_code_id: 'rc1', gross_amount_cents: 1000, commission_rate: 0.25, currency: 'USD' }
  const resolver = (over = {}) => q => {
    if (q.table === 'commission_ledger' && q.op === 'select' && q.filters.some(f => f[1] === 'payment_id')) return { data: over.original === undefined ? original : over.original, error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: over.row === undefined ? sale : over.row, error: null }
    if (q.table === 'commission_ledger' && q.op === 'insert') return { data: null, error: over.insertError || null }
    return undefined
  }
  it('writes a negative row pointing at the sale, logs the reason, and keeps it out of the partner-visible reason', async () => {
    t = load(resolver())
    const out = await t.mod.adminReverseSale(ctxOf({ params: { id: 'p1', ledgerId: 'l1' }, body: { reason: 'Own second account' } }))
    expect(out.body.success).toBe(true)
    const ins = t.db.calls.find(c => c.table === 'commission_ledger' && c.op === 'insert')
    expect(ins.values).toMatchObject({ commission_amount_cents: -250, reverses_ledger_id: 'l1', reversal_reason: 'ADMIN_REVERSED' })
    const audit = t.db.calls.find(c => c.table === 'admin_audit_log' && c.op === 'insert')
    expect(JSON.stringify(audit.values)).toContain('Own second account')
  })
  it('refuses an adjustment, an existing reversal, and a sale that was already reversed', async () => {
    t = load(resolver({ row: { ...sale, kind: 'ADJUSTMENT' } }))
    expect((await t.mod.adminReverseSale(ctxOf({ params: { id: 'p1', ledgerId: 'l1' }, body: { reason: 'Mistaken entry' } }))).status).toBe(400)
    t.restore()
    t = load(resolver({ insertError: { code: '23505', message: 'dup' } }))
    expect((await t.mod.adminReverseSale(ctxOf({ params: { id: 'p1', ledgerId: 'l1' }, body: { reason: 'Mistaken entry' } }))).status).toBe(409)
  })
  it('404s when the sale is not this partner\'s', async () => {
    t = load(resolver({ row: null }))
    expect((await t.mod.adminReverseSale(ctxOf({ params: { id: 'p1', ledgerId: 'l1' }, body: { reason: 'Mistaken entry' } }))).status).toBe(404)
  })
})

describe('adminListUnrecordedCommissions (round 18)', () => {
  it('lists successful code payments that have no commission row', async () => {
    const pays = [
      { id: 'a', scan_id: 's1', paystack_ref: 'ref_a', amount_cents: 5000, currency: 'USD', created_at: '2026-10-01T00:00:00Z', referral_codes: { code: 'ANN10', partners: { id: 'p1', name: 'Ann' } } },
      { id: 'b', scan_id: 's2', paystack_ref: 'ref_b', amount_cents: 5000, currency: 'USD', created_at: '2026-10-02T00:00:00Z', referral_codes: { code: 'ANN10', partners: { id: 'p1', name: 'Ann' } } },
    ]
    t = load(q => {
      if (q.table === 'payments') return { data: pays, error: null }
      if (q.table === 'commission_ledger') return { data: [{ payment_id: 'b' }], error: null }
      if (q.table === 'scans') return { data: [{ id: 's1', user_id: 'u1', fix_payment_id: 'a' }, { id: 's2', user_id: 'u1', fix_payment_id: 'b' }], error: null }
      if (q.table === 'users') return { data: [{ id: 'u1', deleted_at: null }], error: null }
      return undefined
    })
    const out = await t.mod.adminListUnrecordedCommissions(ctxOf())
    expect(out.body.data).toHaveLength(1)
    expect(out.body.data[0]).toMatchObject({ reference: 'ref_a', partnerName: 'Ann', code: 'ANN10' })
    const pq = t.db.calls.find(c => c.table === 'payments')
    expect(pq.filters.some(f => f[0] === 'eq' && f[1] === 'status' && f[2] === 'SUCCESS')).toBe(true)
  })
})

describe('terms notice and signup count (round 18)', () => {
  it('the terms notice includes paused partners', async () => {
    t = load(q => (q.table === 'partners' ? { data: [], count: 0, error: null } : undefined))
    await t.mod.adminSendTermsNotice(ctxOf())
    const q = t.db.calls.find(c => c.table === 'partners' && c.op === 'select')
    const statusFilter = q.filters.find(f => f[1] === 'status')
    expect(statusFilter[0]).toBe('in')
    expect(statusFilter[2]).toEqual(['ACTIVE', 'PAUSED'])
  })
})
