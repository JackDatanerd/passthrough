import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 41 (independent audit): stamped-rate read failures, partial refunds in per-code earnings, the payout sweep and the
// new partner reminder, the apply form's required terms version.

let t
afterEach(() => t?.restore())
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()
const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, _m: m } }

describe('B1 — the checkout rate stamp is never silently replaced by the current rate', () => {
  const { recordConversion } = require('../src/services/referral.service.js')
  const payment = { id: 'pay1', referral_code_id: 'rc1', amount_cents: 1900 }
  const db = payRes => createFakeSupabase(q => {
    if (q.table === 'referral_codes') return { data: { id: 'rc1', partner_id: 'p1' }, error: null }
    if (q.table === 'partners') return { data: { commission_rate: 0.2 }, error: null }
    if (q.table === 'payments') return payRes()
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: null, error: null }
    if (q.table === 'commission_ledger') return { data: { id: 'led1' }, error: null }
    if (q.op === 'rpc') return { error: null }
    return undefined
  })
  const inserted = d => d.calls.find(q => q.table === 'commission_ledger' && q.op === 'insert')

  it('a failed stamp read refuses the write instead of paying the partner\u2019s current rate', async () => {
    const d = db(() => ({ data: null, error: { code: '08006', message: 'connection reset' } }))
    const res = await recordConversion(d, payment)
    expect(res).toMatchObject({ ok: false, recorded: false, reason: 'rate-stamp-lookup' })
    expect(inserted(d)).toBeUndefined()
  })
  it('one transient failure is retried and the stamp is then honoured', async () => {
    let n = 0
    const d = db(() => (++n === 1 ? { data: null, error: { code: '08006', message: 'blip' } } : { data: { referral_commission_rate: 0.15 }, error: null }))
    await recordConversion(d, payment)
    expect(inserted(d).values).toMatchObject({ commission_rate: 0.15, commission_amount_cents: 285 })
  })
  it('a database without the column still falls back to the current rate', async () => {
    const d = db(() => ({ data: null, error: { code: '42703', message: 'column does not exist' } }))
    await recordConversion(d, payment)
    expect(inserted(d).values).toMatchObject({ commission_rate: 0.2 })
  })
})

describe('B2/B3 — partial refunds reach per-code earnings; refunded sales are not sales in the trend', () => {
  const ENV_MOD = () => loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => ({}) } })
  it('a partial-refund adjustment counts against the code of the sale it adjusts, and is not a conversion', () => {
    t = ENV_MOD()
    const stats = t.mod.buildCodeStats([
      { id: 's1', referral_code_id: 'c1', gross_amount_cents: 2900, commission_amount_cents: 580, kind: 'SALE' },
      { id: 'a1', referral_code_id: null, adjusts_ledger_id: 's1', gross_amount_cents: 0, commission_amount_cents: -200, kind: 'ADJUSTMENT' },
      { id: 'm1', referral_code_id: null, adjusts_ledger_id: null, gross_amount_cents: 0, commission_amount_cents: 999, kind: 'ADJUSTMENT' },
    ], [{ id: 'c1' }, { id: 'c2' }])
    expect(stats.c1).toEqual({ conversions: 1, grossCents: 2900, commissionCents: 380 })
    expect(stats.c2).toEqual({ conversions: 0, grossCents: 0, commissionCents: 0 })   // the manual adjustment adjusts no sale: no code
  })
  it('a sale reversed in a later cycle is not counted as a sale', () => {
    t = ENV_MOD()
    const trend = t.mod.buildCycleTrend([
      { id: 's1', created_at: new Date().toISOString(), commission_amount_cents: 500, kind: 'SALE' },
      { id: 'r1', created_at: new Date().toISOString(), commission_amount_cents: -500, kind: 'SALE', reverses_ledger_id: 's1' },
    ], 2)
    expect(trend[1]).toMatchObject({ commissionCents: 0, sales: 0 })
  })
})

function sweepSetup({ partners, unpaid }) {
  const st = { alerts: [], reminders: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'partners' && q.op === 'select') return { data: partners, error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: unpaid, error: null }
    return undefined
  })
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert: async (...a) => { st.alerts.push(a); return true },
      sendPartnerPayoutDetailsReminder: async (...a) => { st.reminders.push(a); return true },
    },
  })
  return { ...m, db, st }
}
const ROW = (partner = 'p1') => ({ id: 'l1', partner_id: partner, commission_amount_cents: 2500, payout_id: null, reverses_ledger_id: null, kind: 'SALE', created_at: daysAgo(40), payments: { status: 'COMPLETED' } })
const ENV = (extra = {}) => ({ FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', OWNER_ALERT_EMAIL: 'owner@x.co', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv(), ...extra })

describe('B6 — the owner alert does not count a partner Run payouts would hold back', () => {
  it('payout details changed inside the hold window: counted as waiting, not ready', async () => {
    t = sweepSetup({ partners: [{ id: 'p1', email: 'k@x.co', payout_method: 'BANK', payout_details_submitted_at: new Date().toISOString(), terms_version: null }], unpaid: [ROW()] })
    const out = await t.mod.sweepPayoutDue(ENV(), t.db)
    expect(out).toMatchObject({ ready: 0, readyCents: 0, waiting: 1, waitingCents: 2500 })
    expect(t.st.alerts).toHaveLength(0)    // nothing to run yet, and waiting alone is not worth an alert
  })
  it('behind on the terms while PAYOUT_REQUIRES_CURRENT_TERMS=1: waiting; without the switch: ready', async () => {
    const partners = [{ id: 'p1', email: 'k@x.co', payout_method: 'BANK', payout_details_submitted_at: daysAgo(30), terms_version: 'old' }]
    t = sweepSetup({ partners, unpaid: [ROW()] })
    expect(await t.mod.sweepPayoutDue(ENV({ PAYOUT_REQUIRES_CURRENT_TERMS: '1' }), t.db)).toMatchObject({ ready: 0, waiting: 1 })
    t.restore()
    t = sweepSetup({ partners, unpaid: [ROW()] })
    expect(await t.mod.sweepPayoutDue(ENV(), t.db)).toMatchObject({ ready: 1, readyCents: 2500, waiting: 0 })
  })
})

describe('G1 — a partner with payable commission and no payout details is reminded, once per cycle', () => {
  const NODETAILS = { id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', payout_method: null, dashboard_token: null, dashboard_token_version: 0 }
  it('emails the dashboard link and the amount, and not again for the same cycle', async () => {
    t = sweepSetup({ partners: [NODETAILS, { ...NODETAILS, id: 'p2', email: 'b@x.co', payout_method: 'BANK' }, { ...NODETAILS, id: 'p3', email: 'c@x.co', status: 'PAUSED' }], unpaid: [ROW('p1'), ROW('p2'), ROW('p3')] })
    const env = ENV()
    const first = await t.mod.sweepPayoutDetailsReminders(env, t.db)
    expect(first.sent).toBe(1)
    expect(t.st.reminders).toHaveLength(1)
    const [, , to, name, cents, , url] = t.st.reminders[0]
    expect([to, name, cents]).toEqual(['k@x.co', 'Coach K', 2500])
    expect(url).toMatch(/^https:\/\/usepassthrough\.com\/partner\/dashboard\?token=/)
    await t.mod.sweepPayoutDetailsReminders(env, t.db)
    expect(t.st.reminders).toHaveLength(1)
  })
  it('sends nothing when nothing is payable yet (current cycle only, or below the minimum)', async () => {
    t = sweepSetup({ partners: [NODETAILS], unpaid: [{ ...ROW('p1'), created_at: new Date().toISOString() }] })
    expect((await t.mod.sweepPayoutDetailsReminders(ENV(), t.db)).sent).toBe(0)
  })
  it('does nothing without the KV (it could not remember it had already sent)', async () => {
    t = sweepSetup({ partners: [NODETAILS], unpaid: [ROW('p1')] })
    const env = ENV(); delete env.RATE_LIMIT_KV
    expect((await t.mod.sweepPayoutDetailsReminders(env, t.db)).sent).toBe(0)
  })
  it('a refused send (suppressed or throttled) is not retried every hour', async () => {
    t = sweepSetup({ partners: [NODETAILS], unpaid: [ROW('p1')] })
    t.restore()
    const st = { n: 0 }
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: [NODETAILS], error: null } : q.table === 'commission_ledger' ? { data: [ROW('p1')], error: null } : undefined))
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => true, sendPartnerPayoutDetailsReminder: async () => { st.n++; return false } } })
    const env = ENV()
    await t.mod.sweepPayoutDetailsReminders(env, db)
    // the finished pass is remembered for 6h, so the very next hourly sweep does not even re-read the ledger
    await t.mod.sweepPayoutDetailsReminders(env, db)
    expect(st.n).toBe(1)
  })
})

describe('B4 — the apply form must say which terms version it showed', () => {
  it('an application without a termsVersion is refused with a reload message, before anything is stored', async () => {
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => createFakeSupabase(() => ({ data: null, error: null })) } })
    const ctx = { env: {}, req: { json: async () => ({ name: 'Ann', email: 'ann@x.co', acceptTerms: true }), header: () => undefined }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
    const res = await t.mod.applyAsPartner(ctx)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TERMS_VERSION_REQUIRED')
  })
})
