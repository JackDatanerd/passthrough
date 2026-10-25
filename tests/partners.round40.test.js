import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Partners round 40: atomic code rename, the inactive-partner guards on codes, the readable terms-acceptance trail,
// the code-request status on the dashboard, and the reversal notice carrying the NET amount.

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv() },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: { param: k => (over.params || {})[k ?? 'id'] ?? 'x1', query: k => (over.query || {})[k], json: async () => over.body ?? {}, header: k => (over.headers || {})[String(k).toLowerCase()] },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})
const TIER = { FIX: 900 }

function setup(o = {}) {
  const st = { rpcs: [], updates: [], alerts: [] }
  const owner = { partner_id: 'p1', code: 'OLD', active: true, tier_prices: TIER, usage_limit: null, expires_at: null,
    partners: { name: 'K', email: 'k@x.co', status: o.partnerStatus || 'ACTIVE' } }
  const db = createFakeSupabase(q => {
    if (q.op === 'rpc') {
      st.rpcs.push(q)
      if (q.name === 'rename_referral_code') return { data: o.rpcData ?? 'OLD', error: o.rpcError || null }
      return undefined
    }
    if (q.table === 'referral_codes' && q.op === 'select') return { data: { ...owner, id: 'c1' }, error: null }
    if (q.table === 'referral_codes' && q.op === 'update') { st.updates.push({ table: q.table, patch: q.patch }); return { data: { id: 'c1', partner_id: 'p1', ...owner, ...q.patch }, error: null } }
    if (q.op === 'update') { st.updates.push({ table: q.table, patch: q.patch }); return { data: null, error: null } }
    if (q.table === 'partners' && q.op === 'select') return { data: { id: 'p1', name: 'K', email: 'k@x.co', status: o.partnerStatus || 'ACTIVE', dashboard_token: 'd', dashboard_token_version: 0 }, error: null }
    return undefined
  })
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendPartnerCodeChanged: async () => true, sendReferralCodeCreated: async () => true, sendOwnerAlert: async () => true },
  })
  return { ...m, st, db }
}

describe('code rename is one database call', () => {
  it('uses rename_referral_code and no separate users / payments writes', async () => {
    t = setup()
    const res = await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: 'c1' }, body: { code: 'new' } }))
    expect(res.body.success).toBe(true)
    expect(res.body.renamed).toEqual({ from: 'OLD', to: 'NEW' })
    expect(t.st.rpcs).toHaveLength(1)
    expect(t.st.rpcs[0].args).toEqual({ p_code_id: 'c1', p_new_code: 'NEW' })
    expect(t.st.updates.filter(u => u.table === 'users' || u.table === 'payments')).toHaveLength(0)
  })
  it('a taken code text is a 409', async () => {
    t = setup({ rpcError: { code: '23505', message: 'dup' } })
    const res = await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: 'c1' }, body: { code: 'new' } }))
    expect(res.status).toBe(409)
  })
  it('falls back to the old sequence when migration 0117 is not applied', async () => {
    t = setup({ rpcError: { code: 'PGRST202', message: 'no function' } })
    const res = await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: 'c1' }, body: { code: 'new' } }))
    expect(res.body.success).toBe(true)
    expect(t.st.updates.some(u => u.table === 'users' && u.patch.referred_by_code === 'NEW')).toBe(true)
    expect(t.st.updates.some(u => u.table === 'payments' && u.patch.referral_code === 'NEW')).toBe(true)
  })
})

describe('codes of a partner who is not active', () => {
  it('editing a code of a paused partner says it will not apply', async () => {
    t = setup({ partnerStatus: 'PAUSED' })
    const res = await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: 'c1' }, body: { active: true } }))
    expect(res.body.partnerInactive).toBe(true)
    expect(res.body.warnings.join(' ')).toMatch(/paused/)
  })
  it('an active partner gets no such warning', async () => {
    t = setup()
    const res = await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: 'c1' }, body: { active: true } }))
    expect(res.body.partnerInactive).toBe(false)
  })
  it('a code cannot be created for an ended partner', async () => {
    t = setup({ partnerStatus: 'ENDED' })
    const res = await t.mod.adminCreateReferralCode(ctxOf({ params: { id: 'p1' }, body: { code: 'NEWCODE', tierPrices: TIER } }))
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/ended/)
  })
})

describe('terms-acceptance trail', () => {
  const rows = [
    { id: 'a', version: 'v1', source: 'dashboard', accepted_at: '2026-10-02T10:00:00Z', ip_hash: 'h1', user_agent: 'UA' },
  ]
  const appRows = [{ id: 'b', version: 'v1', source: 'application', accepted_at: '2026-09-01T10:00:00Z', ip_hash: 'h0', user_agent: 'UA0' }]
  const mk = (ownErr = null) => {
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: { id: 'p1', email: 'k@x.co' }, error: null }
      if (q.table === 'partner_terms_acceptances') {
        if (ownErr) return { data: null, error: ownErr }
        return q.filters.some(f => f[0] === 'is') ? { data: appRows, error: null } : { data: rows, error: null }
      }
      return undefined
    })
    return loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  }
  it('lists dashboard and application-time acceptances newest first', async () => {
    t = mk()
    const res = await t.mod.adminListTermsAcceptances(ctxOf({ params: { id: 'p1' } }))
    expect(res.body.data.map(r => r.id)).toEqual(['a', 'b'])
    expect(res.body.data[0]).toMatchObject({ version: 'v1', source: 'dashboard', ipHash: 'h1', userAgent: 'UA' })
  })
  it('is an empty list, not an error, before the table exists', async () => {
    t = mk({ code: '42P01', message: 'no table' })
    const res = await t.mod.adminListTermsAcceptances(ctxOf({ params: { id: 'p1' } }))
    expect(res.body).toEqual({ success: true, data: [] })
  })
})

describe('reversal reports the net commission lost', () => {
  it('subtracts what an earlier partial refund already took', async () => {
    const db = createFakeSupabase(q => {
      if (q.table === 'commission_ledger' && q.op === 'select' && q.filters.some(f => f[1] === 'payment_id'))
        return { data: { id: 'orig', partner_id: 'p1', referral_code_id: null, gross_amount_cents: 5000, commission_rate: 0.2, commission_amount_cents: 1000, currency: 'USD', payout_id: null }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: [{ commission_amount_cents: -400 }], error: null }
      return undefined
    })
    const out = await require('../src/services/fulfillment.service').reverseCommission(db, 'pay1', 'REFUND')
    expect(out.reversed).toBe(true)
    expect(out.commissionCents).toBe(600)
  })
  it('is the full amount when there was no partial refund', async () => {
    const db = createFakeSupabase(q => {
      if (q.table === 'commission_ledger' && q.op === 'select' && q.filters.some(f => f[1] === 'payment_id'))
        return { data: { id: 'orig', partner_id: 'p1', referral_code_id: null, gross_amount_cents: 5000, commission_rate: 0.2, commission_amount_cents: 1000, currency: 'USD', payout_id: null }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: [], error: null }
      return undefined
    })
    const out = await require('../src/services/fulfillment.service').reverseCommission(db, 'pay1', 'REFUND')
    expect(out.commissionCents).toBe(1000)
  })
})
