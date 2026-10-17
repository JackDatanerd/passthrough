import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 11: removed-partner write-off + finishing an erasure, price guardrails on the approve path,
// erasure that reaches earlier addresses, dashboard link on an email change, payout-due reminder, trend / mix.

let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', PAYSTACK_CURRENCY: 'USD', OWNER_ALERT_EMAIL: 'owner@x.co', ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? 'p1',
    query: k => (over.query || {})[k],
    json: async () => over.body ?? {},
    header: () => undefined,
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

const PARTNER = {
  id: 'p1', name: 'Coach K', email: 'new@x.co', status: 'ACTIVE', payout_method: 'BANK',
  payout_details: { bankName: 'Acme Bank', accountNumber: '0123 4567 89' },
  payout_details_submitted_at: '2020-01-01T00:00:00.000Z', terms_version: null,
  payout_details_token: 'ptok', dashboard_token: 'dtok', commission_rate: 0.1, notify_conversions: true,
  previous_emails: ['old@x.co'],
}
const REMOVED = { ...PARTNER, name: 'Removed partner', email: 'partner-p1@removed.invalid', payout_method: null, payout_details: null }
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()

function setup(o = {}) {
  const st = { audits: [], emails: [], inserts: [], updates: [], deletes: [], alerts: [], queries: [] }
  const partner = 'partner' in o ? o.partner : PARTNER
  const db = createFakeSupabase(q => {
    st.queries.push(q)
    if (q.table === 'admin_audit_log' && q.op === 'insert') { st.audits.push(q.values); return { data: null, error: null } }
    if (q.table === 'partners' && q.op === 'select') return { data: o.partnersList || partner, error: null }
    if (q.table === 'partners' && q.op === 'update') { st.updates.push({ table: 'partners', patch: q.patch }); return { data: { ...partner, ...q.patch }, error: null } }
    if (q.table === 'commission_ledger' && q.op === 'insert') { st.inserts.push(q.values); return { data: { id: 'adj1', created_at: 'now', ...q.values }, error: null } }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: o.unpaid ?? [], error: null }
    if (q.table === 'commission_ledger' && q.op === 'update') return { data: null, error: null }
    if (q.table === 'email_logs' && q.op === 'delete') { st.deletes.push(q); return { count: 1, error: null } }
    if (q.table === 'alert_logs' && q.op === 'delete') { st.deletes.push(q); return { count: 1, error: null } }
    if (q.table === 'payouts' && q.op === 'select') return { data: [], error: null }
    if (q.table === 'partner_applications' && q.op === 'delete') { st.deletes.push(q); return { data: null, error: null } }
    if (q.table === 'referral_codes' && q.op === 'update') return { data: null, error: null }
    return undefined
  })
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert: async (...a) => { st.alerts.push(a); return o.alertOk ?? true },
      sendPartnerBalanceAdjusted: async () => { st.emails.push('adjusted'); return true },
      sendPartnerStatusChanged: async () => true, sendPartnerRateChanged: async () => true,
      sendPartnerLinkRegenerated: async (...a) => { st.emails.push(['payoutLink', a[2]]); return true },
      sendPartnerDashboardLinkRegenerated: async (...a) => { st.emails.push(['dashLink', a[2], a[4]]); return true },
      sendPartnerEmailChanged: async () => true,
    },
  })
  return { ...m, st, db }
}

describe('B1 — a removed partner can be written off, and the erasure can always finish', () => {
  it('records a write-off on a removed partner without emailing or keeping the typed reason', async () => {
    t = setup({ partner: REMOVED })
    const res = await t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 500, reason: 'Anna Smith 0712 refund credit' } }))
    expect(res.status).toBe(200)
    expect(t.st.inserts[0].adjustment_reason).toBe('Adjustment (details removed)')
    expect(t.st.emails).not.toContain('adjusted')
    expect(t.st.audits[0].detail?.removedPartnerWriteOff ?? t.st.audits[0].details?.removedPartnerWriteOff).toBe(true)
  })

  it('re-running the removal on an already-removed partner with a leftover balance is no longer a dead end', async () => {
    t = setup({ partner: REMOVED, unpaid: [{ id: 'r1', commission_amount_cents: -500 }] })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'finish cleanup' } }))
    expect(res.status).toBe(200)
    expect(res.body.alreadyRemoved).toBe(true)
  })

  it('a partner who is NOT yet removed is still refused while commission is owed', async () => {
    t = setup({ unpaid: [{ id: 'r1', commission_amount_cents: 900 }] })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'gdpr request' } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('COMMISSION_OWED')
  })
})

describe('B3 — erasure reaches the addresses a partner used to have', () => {
  it('purges mail history for the current AND every earlier address, and clears the list', async () => {
    t = setup()
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'gdpr request' } }))
    expect(res.status).toBe(200)
    const mailDelete = t.st.deletes.find(q => q.table === 'email_logs')
    const inFilter = mailDelete.filters.find(f => f[0] === 'in' && f[1] === 'to')
    expect(inFilter[2]).toEqual(expect.arrayContaining(['new@x.co', 'old@x.co']))
    const rowWipe = t.st.updates.find(u => u.patch.name === 'Removed partner')
    expect(rowWipe.patch.previous_emails).toEqual([])
  })

  it('an admin email change remembers the old address (lower-case, de-duplicated)', async () => {
    t = setup({ partner: { ...PARTNER, email: 'Old2@X.co', previous_emails: ['old@x.co'] } })
    await t.mod.adminUpdatePartner(ctxOf({ body: { email: 'third@x.co' } }))
    const patch = t.st.updates.find(u => u.patch.email)?.patch
    expect(patch.previous_emails).toEqual(['old@x.co', 'old2@x.co'])
  })
})

describe('G2 — an email change delivers BOTH rotated links to the new address', () => {
  it('sends the payout link and the dashboard link', async () => {
    t = setup({ partner: { ...PARTNER, email: 'old@x.co', previous_emails: [] } })
    await t.mod.adminUpdatePartner(ctxOf({ body: { email: 'fresh@x.co' } }))
    expect(t.st.emails.filter(e => Array.isArray(e)).map(e => e[0])).toEqual(expect.arrayContaining(['payoutLink', 'dashLink']))
    const dash = t.st.emails.find(e => e[0] === 'dashLink')
    expect(dash[2]).toMatch(/\/partner\/dashboard\?token=/)
    expect(dash[2]).not.toContain('token=dtok')   // the OLD token is dead
  })
})

describe('B2 — the approve path enforces the same price guardrail', () => {
  it('refuses a first code priced far below standard unless confirmed - before claiming anything', async () => {
    t = setup()
    const res = await t.mod.adminApproveApplication(ctxOf({ params: { id: 'app1' }, body: { referralCode: { code: 'ANNA20', tierPrices: { FIX: 49 } } } }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PRICE_TOO_LOW')
    expect(t.st.queries.some(q => q.table === 'partner_applications' && q.op === 'update')).toBe(false)
  })
})

describe('G1 — owner is told once per closed cycle that payouts are ready', () => {
  const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } } }
  const ACTIVE = { id: 'p1', email: 'k@x.co', payout_method: 'BANK' }
  const ROW = { id: 'l1', partner_id: 'p1', commission_amount_cents: 2500, payout_id: null, reverses_ledger_id: null, kind: 'SALE', created_at: daysAgo(40), payments: { status: 'COMPLETED' } }

  it('sends one alert with counts and totals (no names), and not again for the same cycle', async () => {
    t = setup({ partnersList: [ACTIVE], unpaid: [ROW] })
    const env = { OWNER_ALERT_EMAIL: 'owner@x.co', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv() }
    const first = await t.mod.sweepPayoutDue(env, t.db)
    expect(first).toMatchObject({ sent: true, ready: 1, readyCents: 2500 })
    expect(t.st.alerts).toHaveLength(1)
    expect(t.st.alerts[0][2]).toContain('25.00')
    expect(t.st.alerts[0][2]).not.toContain('k@x.co')
    await t.mod.sweepPayoutDue(env, t.db)
    expect(t.st.alerts).toHaveLength(1)
  })

  it('a failed alert is not marked, so the next hourly sweep retries', async () => {
    t = setup({ partnersList: [ACTIVE], unpaid: [ROW], alertOk: false })
    const env = { OWNER_ALERT_EMAIL: 'owner@x.co', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv() }
    expect((await t.mod.sweepPayoutDue(env, t.db)).sent).toBe(false)
    expect((await t.mod.sweepPayoutDue(env, t.db)).sent).toBe(false)
    expect(t.st.alerts).toHaveLength(2)
  })

  it('stays silent with nothing ready, or no owner address configured', async () => {
    t = setup({ partnersList: [ACTIVE], unpaid: [] })
    await t.mod.sweepPayoutDue({ OWNER_ALERT_EMAIL: 'owner@x.co', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv() }, t.db)
    await t.mod.sweepPayoutDue({ PAYSTACK_CURRENCY: 'USD' }, t.db)
    // no KV => no way to remember "already sent" => never alert (it would repeat every hour)
    await t.mod.sweepPayoutDue({ OWNER_ALERT_EMAIL: 'owner@x.co', PAYSTACK_CURRENCY: 'USD' }, t.db)
    expect(t.st.alerts).toHaveLength(0)
  })
})

describe('G3/G4 — trend and attribution mix', () => {
  it('buildCycleTrend nets reversals/adjustments and counts only real sales, oldest first', async () => {
    t = setup()
    const now = new Date().toISOString()
    const trend = t.mod.buildCycleTrend([
      { id: 'a', created_at: now, commission_amount_cents: 1000, kind: 'SALE' },
      { id: 'b', created_at: now, commission_amount_cents: -400, kind: 'SALE', reverses_ledger_id: 'a' },
      { id: 'c', created_at: now, commission_amount_cents: 100, kind: 'ADJUSTMENT' },
    ], 4)
    expect(trend).toHaveLength(4)
    expect(trend[3]).toMatchObject({ isCurrent: true, commissionCents: 700, sales: 1 })
    expect(trend[0].commissionCents).toBe(0)
  })
  it('buildAttributionMix skips refunded sales, reversals and adjustments; old rows are "unknown"', async () => {
    t = setup()
    const mix = t.mod.buildAttributionMix([
      { id: '1', attribution_source: 'link' }, { id: '2', attribution_source: 'typed' },
      { id: '3', attribution_source: 'link' }, { id: 'r', reverses_ledger_id: '3', attribution_source: 'link' },
      { id: '4' }, { id: '5', kind: 'ADJUSTMENT' },
    ])
    expect(mix).toEqual({ link: 1, typed: 1, account: 0, unknown: 1 })
  })
})
