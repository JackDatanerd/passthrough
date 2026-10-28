import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Partners round 45: a partner whose whole unpaid balance is in a non-platform currency is not batch-payable, and a code
// rename whose second step fails says so instead of a bare 500.
let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://x.co', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD' },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: { param: k => (over.params || {})[k ?? 'id'] ?? 'x1', query: k => (over.query || {})[k], json: async () => over.body ?? {}, header: () => undefined },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})

describe('foreign-currency balance is not batch-payable', () => {
  const run = async currency => {
    const partner = { id: 'p1', name: 'K', email: 'k@x.co', payout_method: 'BANK', payout_details: {}, created_at: '2026-01-01T00:00:00Z', dashboard_token_version: 0, terms_version: null }
    const ledger = [{ id: 'l1', partner_id: 'p1', commission_amount_cents: 5000, gross_amount_cents: 10000, currency, kind: 'SALE', payout_id: null, reverses_ledger_id: null, created_at: '2025-01-02T00:00:00Z', payments: { status: 'SUCCESS' } }]
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: [partner], error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: ledger, error: null }
      if (q.table === 'email_logs') return { data: [], error: null }
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return (await t.mod.adminListPartners(ctxOf())).body.data[0]
  }
  it('flags a lone KES balance on a USD platform', async () => { expect((await run('KES')).mixedCurrency).toBe(true) })
  it('leaves a USD balance payable', async () => { expect((await run('USD')).mixedCurrency).toBe(false) })
})

describe('rename then failed second step', () => {
  it('reports PARTIAL_UPDATE and audits the rename', async () => {
    const audits = []
    const owner = { partner_id: 'p1', code: 'OLD', active: true, tier_prices: { FIX: 900 }, usage_limit: null, expires_at: null, partners: { name: 'K', email: 'k@x.co', status: 'ACTIVE' } }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') return { data: 'OLD', error: null }
      if (q.table === 'admin_audit_log') { audits.push(q); return { data: null, error: null } }
      if (q.table === 'referral_codes' && q.op === 'select') return { data: { ...owner, id: 'c1' }, error: null }
      if (q.table === 'referral_codes' && q.op === 'update') return { data: null, error: { code: 'XX000', message: 'boom' } }
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const res = await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: 'c1' }, body: { code: 'new', active: false } }))
    expect(res.status).toBe(500)
    expect(res.body.code).toBe('PARTIAL_UPDATE')
    expect(audits.length).toBe(1)
  })
})
