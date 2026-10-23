import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 33: the welcome-code system partner is never mailed on redemption/refund, the overview uses one aggregate query (with a
// fallback), and the legacy dashboard-link converter skips ids that already failed and is visible in the partner list.

let t
afterEach(() => t?.restore())
const WELCOME = '00000000-0000-4000-8000-00000000e1c0'
const REAL = '0b0c8c64-1d0f-4f7e-9a49-0a6a4b1f4c11'
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123' },
  get: () => ({ id: 'admin-1' }),
  req: { param: k => (over.params || {})[k] ?? REAL, query: k => (over.query || {})[k], json: async () => over.body ?? {}, header: () => undefined },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})

describe('no partner mail for the welcome-code system partner', () => {
  const load = sent => (t = loadWithStubs('services/referral.service.js', {
    'services/email.service.js': {
      sendPartnerCodeLimitReached: async (...a) => { sent.push(['limit', a[2]]); return true },
      sendPartnerCommissionReversed: async (...a) => { sent.push(['reversed', a[2]]); return true },
      sendPartnerConversionEarned: async (...a) => { sent.push(['earned', a[2]]); return true },
      sendOwnerAlert: async () => {},
    } }))
  const limitDb = () => createFakeSupabase(q => q.table === 'referral_codes' ? { data: { code: 'FN-ABCDE', usage_limit: 1, uses_so_far: 1 }, error: null } : { data: null, count: 0, error: null })
  it('a welcome-code redemption does not send "limit reached"; a partner code that hit its limit still does', async () => {
    const sent = []; const { mod } = load(sent)
    const partner = { name: 'X', email: 'welcome-codes@system.invalid', notify_conversions: false }
    await mod.afterConversionNotices(limitDb(), { RATE_LIMIT_KV: null }, { id: 'c1', partner_id: WELCOME, code: 'FN-ABCDE' }, partner)
    expect(sent).toEqual([])
    await mod.afterConversionNotices(limitDb(), {}, { id: 'c2', partner_id: REAL, code: 'COACH' }, { name: 'Kim', email: 'k@x.co' })
    expect(sent).toEqual([['limit', 'k@x.co']])
  })
  it('a refund of a welcome-code sale is not mailed, a real partner still is', async () => {
    const sent = []; const { mod } = load(sent)
    const db = createFakeSupabase(q => q.table === 'partners' ? { data: { name: 'P', email: 'p@x.co', status: 'ACTIVE', id: REAL, dashboard_token_version: 0 }, error: null } : undefined)
    expect(await mod.notifyPartnerReversal({ JWT_SECRET: 'x'.repeat(32), FRONTEND_URL: 'https://x.co' }, db, WELCOME, 0, 'USD')).toBe(false)
    expect(db.calls).toHaveLength(0)
    expect(await mod.notifyPartnerReversal({ JWT_SECRET: 'x'.repeat(32), FRONTEND_URL: 'https://x.co' }, db, REAL, 500, 'USD')).toBe(true)
    expect(sent).toEqual([['reversed', 'p@x.co']])
  })
})

describe('admin overview totals', () => {
  const load = db => (t = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {} } }))
  it('reads the four money totals from one SQL function and scans no table', async () => {
    const db = createFakeSupabase(q => q.op === 'rpc' && q.name === 'partners_overview_totals'
      ? { data: { paid_out_cents: 1200, lifetime_commission_cents: 9000, owed_cents: 700, credit_cents: 50 }, error: null }
      : { data: [], count: 3, error: null })
    const res = await load(db).mod.adminPartnersOverview(ctxOf())
    expect(res.body.data).toMatchObject({ paidOutCents: 1200, lifetimeCommissionCents: 9000, owedCents: 700, creditCents: 50 })
    expect(db.calls.find(q => q.op === 'rpc').args).toEqual({ p_exclude_partner: WELCOME })
    expect(db.calls.filter(q => q.table === 'commission_ledger' || q.table === 'payouts')).toHaveLength(0)
  })
  it('falls back to the old scan when the function is not there yet', async () => {
    const db = createFakeSupabase(q => q.op === 'rpc' ? { data: null, error: { message: 'function does not exist' } }
      : q.table === 'payouts' ? { data: [{ id: 'a', amount_cents: 400 }], error: null }
      : q.table === 'commission_ledger' ? { data: [{ id: 'l1', partner_id: REAL, commission_amount_cents: 250 }], error: null }
      : { data: [], count: 1, error: null })
    const res = await load(db).mod.adminPartnersOverview(ctxOf())
    expect(res.body.data).toMatchObject({ paidOutCents: 400, lifetimeCommissionCents: 250, owedCents: 250, creditCents: 0 })
  })
})

describe('legacy dashboard-link converter', () => {
  const load = (db, email) => (t = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {}, ...email } }))
  it('leaves out the ids the caller says already failed, so they cannot block the batch', async () => {
    const db = createFakeSupabase()
    await load(db).mod.adminConvertLegacyDashboardLinks(ctxOf({ body: { skipIds: [REAL] } }))
    expect(db.calls[0].filters.some(f => f[0] === 'not' && f[1] === 'id' && String(f[3] ?? f[2]).includes(REAL))).toBe(true)
  })
  it('rejects a skip list that is not uuids', async () => {
    await expect(load(createFakeSupabase()).mod.adminConvertLegacyDashboardLinks(ctxOf({ body: { skipIds: ['nope'] } }))).rejects.toThrow()
  })
  it('flags the partners still on a stored link in the admin list (not removed ones)', async () => {
    const row = (id, email, tok) => ({ id, name: id, email, dashboard_token: tok, status: 'ACTIVE', commission_rate: 0.2, created_at: '2026-01-01T00:00:00Z' })
    const db = createFakeSupabase(q => q.table === 'partners' ? { data: [row('a', 'a@x.co', 'legacy'), row('b', 'b@x.co', null), row('c', 'partner-c@removed.invalid', 'legacy')], error: null } : { data: [], error: null })
    const res = await load(db).mod.adminListPartners(ctxOf())
    expect(res.body.data.map(p => [p.id, p.legacyDashboardLink])).toEqual([['a', true], ['b', false], ['c', false]])
  })
})
