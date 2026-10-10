import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 3: dispute hold, payout-destination guard, minimum payout,
// phantom-payout race, paused-partner code notice, partner applications,
// refund-before-commission, usage-slot release on refund.

let t
afterEach(() => t?.restore())

const ctxOf = (env, { body, params = { id: 'p1' }, query = {}, headers = {} } = {}) => ({
  env,
  req: { param: k => params[k ?? 'id'] ?? 'p1', query: k => query[k], json: async () => body ?? {}, header: k => headers[k] },
  header: () => {},
  json: (b, status = 200) => ({ body: b, status }),
})

// ── adminRecordPayout ───────────────────────────────────────────────────────
function setupPayout(o = {}) {
  const st = { inserts: [], deletes: [], alerts: [], sent: [] }
  const partner = o.partner ?? { id: 'p1', name: 'K', email: 'k@x.co', payout_method: 'BANK', payout_details: {}, payout_details_submitted_at: '2026-09-01T10:00:00.000Z' }
  const ledger = o.ledger ?? [{ id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, payments: { status: 'SUCCESS' } }]
  const db = createFakeSupabase(q => {
    if (q.table === 'partners' && q.op === 'select') return { data: partner, error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: ledger, error: null }
    if (q.table === 'payouts' && q.op === 'insert') { st.inserts.push(q.values); return { data: { id: 'po1', ...q.values }, error: null } }
    if (q.table === 'payouts' && q.op === 'delete') { st.deletes.push(q.filters); return { data: null, error: null } }
    if (q.table === 'commission_ledger' && q.op === 'update') return { data: o.claimed ?? ledger.filter(l => l.payments?.status !== 'DISPUTED'), error: null }
    if (q.table === 'payouts' && q.op === 'update') return { data: { id: 'po1', ...st.inserts[0], ...q.patch }, error: null }
  })
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert: async (e, subject) => { st.alerts.push(subject) },
      sendPayoutSent: async () => { st.sent.push(1); return true },
    },
  })
  return { ...m, st, db }
}

describe('adminRecordPayout — payout destination guard', () => {
  it('409s when the details changed since the admin opened the screen, writing nothing', async () => {
    t = setupPayout()
    const res = await t.mod.adminRecordPayout(ctxOf({}, { body: { expectedDetailsSubmittedAt: '2026-08-01T00:00:00.000Z' } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PAYOUT_DETAILS_CHANGED')
    expect(t.st.inserts).toHaveLength(0)
  })
  it('proceeds when the timestamp matches (as an instant, not a string)', async () => {
    t = setupPayout()
    const res = await t.mod.adminRecordPayout(ctxOf({}, { body: { expectedDetailsSubmittedAt: '2026-09-01T10:00:00Z' } }))
    expect(res.body.success).toBe(true)
  })
  it('is optional: omitting it keeps scripts working', async () => {
    t = setupPayout()
    expect((await t.mod.adminRecordPayout(ctxOf({}))).body.success).toBe(true)
  })
})

describe('adminRecordPayout — disputes, minimum, phantom race', () => {
  it('commission on a DISPUTED payment is not settled or counted as owed', async () => {
    t = setupPayout({ ledger: [
      { id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, payments: { status: 'SUCCESS' } },
      { id: 'l2', commission_amount_cents: 900, reverses_ledger_id: null, payments: { status: 'DISPUTED' } },
    ] })
    const res = await t.mod.adminRecordPayout(ctxOf({}))
    expect(res.body.success).toBe(true)
    expect(t.st.inserts[0].amount_cents).toBe(500)
    expect(t.st.inserts[0].settled_commission_cents).toBe(500)
  })
  it('a cycle-scoped payout below COMMISSION_MIN_PAYOUT_CENTS is refused (carries forward)', async () => {
    t = setupPayout()
    const res = await t.mod.adminRecordPayout(ctxOf({ COMMISSION_MIN_PAYOUT_CENTS: '1000' },
      { body: { periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-15T23:59:59.999Z' } }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('BELOW_MINIMUM')
    expect(t.st.inserts).toHaveLength(0)
  })
  it('an ad hoc payout is the deliberate override of the minimum', async () => {
    t = setupPayout()
    const res = await t.mod.adminRecordPayout(ctxOf({ COMMISSION_MIN_PAYOUT_CENTS: '1000' }))
    expect(res.body.success).toBe(true)
  })
  it('loses the race for EVERY row with an auto amount: payout row removed, no email, 409', async () => {
    t = setupPayout({ claimed: [] })
    const res = await t.mod.adminRecordPayout(ctxOf({}))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PAYOUT_RACED')
    expect(t.st.deletes).toHaveLength(1)
    expect(t.st.sent).toHaveLength(0)
    expect(t.st.alerts.some(a => /lost a race/i.test(a))).toBe(true)
  })
})

// ── list/dashboard figures ──────────────────────────────────────────────────
describe('held / ready / net figures', () => {
  const old = '2020-01-01T00:00:00Z'
  function setupList(ledger, partnerOver = {}) {
    const row = { id: 'p1', name: 'K', email: 'k@x.co', status: 'ACTIVE', commission_rate: 0.2, payouts: [], referral_codes: [], commission_ledger: ledger, ...partnerOver }
    // Round 4: the list reads the unpaid ledger in its own query (see adminListPartners).
    const { commission_ledger, ...bare } = row
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: [bare], error: null }
      if (q.table === 'commission_ledger') return { data: ledger.filter(l => !l.payout_id).map(l => ({ partner_id: 'p1', ...l })), error: null }
      return undefined
    })
    return loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  }
  it('commission on a DISPUTED payment is held, not ready to pay', async () => {
    t = setupList([
      { id: 'a', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null, created_at: old, payments: { status: 'SUCCESS' } },
      { id: 'b', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null, created_at: old, payments: { status: 'DISPUTED' } },
    ])
    const r = await t.mod.adminListPartners(ctxOf({}))
    expect(r.body.data[0]).toMatchObject({ readyToPayCents: 580, heldCents: 580 })
  })
  it('payable below the minimum is carried forward and shown as 0 ready', async () => {
    t = setupList([{ id: 'a', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null, created_at: old, payments: { status: 'SUCCESS' } }])
    const r = await t.mod.adminListPartners(ctxOf({ COMMISSION_MIN_PAYOUT_CENTS: '2000' }))
    expect(r.body.data[0]).toMatchObject({ readyToPayCents: 0, carriedForwardCents: 580, belowMinimum: true, minPayoutCents: 2000 })
  })
  it('netConversions (detail view) drops a refunded sale; the list no longer carries it', async () => {
    const ledger = [
      { id: 'a', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: 'po1', created_at: old },
      { id: 'r', reverses_ledger_id: 'a', gross_amount_cents: -2900, commission_amount_cents: -580, payout_id: 'po1', created_at: old },
    ]
    t = setupList(ledger)
    expect((await t.mod.adminListPartners(ctxOf({}))).body.data[0].netConversions).toBeUndefined()
    t.restore()
    const row = { id: 'p1', name: 'K', email: 'k@x.co', status: 'ACTIVE', commission_rate: 0.2, payouts: [], referral_codes: [], commission_ledger: ledger }
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: row, error: null } : undefined))
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    expect((await t.mod.adminGetPartner(ctxOf({}, { params: { id: 'p1' } }))).body.data.netConversions).toBe(0)
  })
})

describe('getPartnerDashboard — new fields', () => {
  function setupDash(partner) {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: partner, error: null } : undefined))
    return loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  }
  const base = { name: 'K', commission_rate: 0.2, status: 'ACTIVE', payout_method: null, payouts: [], commission_ledger: [], referral_codes: [] }
  it('reports whether payout details are on file', async () => {
    t = setupDash(base)
    expect((await t.mod.getPartnerDashboard(ctxOf({}, { query: { token: 'x' } }))).body.data.hasPayoutDetails).toBe(false)
    t.restore()
    t = setupDash({ ...base, payout_method: 'BANK' })
    expect((await t.mod.getPartnerDashboard(ctxOf({}, { query: { token: 'x' } }))).body.data.hasPayoutDetails).toBe(true)
  })
  it('attaches per-code conversions + conversion rate (net of refunds)', async () => {
    t = setupDash({ ...base, referral_codes: [{ id: 'rc1', code: 'A', clicks: 10, uses_so_far: 2, tier_prices: {}, active: true }], commission_ledger: [
      { id: 'a', referral_code_id: 'rc1', gross_amount_cents: 2900, commission_amount_cents: 580, created_at: '2026-09-01T00:00:00Z' },
      { id: 'b', referral_code_id: 'rc1', gross_amount_cents: 2900, commission_amount_cents: 580, created_at: '2026-09-02T00:00:00Z' },
      { id: 'r', referral_code_id: 'rc1', reverses_ledger_id: 'b', gross_amount_cents: -2900, commission_amount_cents: -580, created_at: '2026-09-03T00:00:00Z' },
    ] })
    const d = (await t.mod.getPartnerDashboard(ctxOf({}, { query: { token: 'x' } }))).body.data
    expect(d.referralCodes[0].stats).toEqual({ conversions: 1, conversionRate: 0.1 })
  })
  it('sets Cache-Control: no-store on token responses', async () => {
    t = setupDash(base)
    const seen = {}
    const c = ctxOf({}, { query: { token: 'x' } }); c.header = (k, v) => { seen[k] = v }
    await t.mod.getPartnerDashboard(c)
    expect(seen['Cache-Control']).toBe('no-store')
  })
})

// ── paused-partner code notice ──────────────────────────────────────────────
describe('adminCreateReferralCode — paused partner', () => {
  function setupCode(status) {
    const st = { mails: 0 }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: { name: 'K', email: 'k@x.co', payout_details_token: 'tok', status }, error: null }
      if (q.table === 'referral_codes' && q.op === 'insert') return { data: { id: 'rc1', code: 'COACH20', tier_prices: { FIX: 1900 }, ...q.values }, error: null }
    })
    return { st, ...loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendReferralCodeCreated: async () => { st.mails++ } },
    }) }
  }
  it('creates the code but does NOT email "your code is ready" to a PAUSED partner', async () => {
    t = setupCode('PAUSED')
    const r = await t.mod.adminCreateReferralCode(ctxOf({ FRONTEND_URL: 'https://x' }, { body: { code: 'coach20', tierPrices: { FIX: 1900 } } }))
    expect(r.body).toMatchObject({ success: true, notified: false, partnerPaused: true })
    expect(t.st.mails).toBe(0)
  })
  it('still emails an ACTIVE partner', async () => {
    t = setupCode('ACTIVE')
    const r = await t.mod.adminCreateReferralCode(ctxOf({ FRONTEND_URL: 'https://x' }, { body: { code: 'coach20', tierPrices: { FIX: 1900 } } }))
    expect(r.body.notified).toBe(true)
    expect(t.st.mails).toBe(1)
  })
})

// ── applications ────────────────────────────────────────────────────────────
describe('partner applications', () => {
  function setupApp(o = {}) {
    const st = { inserts: [], alerts: [], updates: [], created: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: o.existingPartner ? [{ id: 'x' }] : [], error: null }
      if (q.table === 'partners' && q.op === 'insert') { st.created.push(q.values); return { data: { id: 'newp', commission_rate: 0.25, ...q.values }, error: null } }
      if (q.table === 'partner_applications' && q.op === 'insert') { st.inserts.push(q.values); return { data: null, error: o.insertError || null } }
      if (q.table === 'partner_applications' && q.op === 'update') {
        st.updates.push(q.patch)
        return { data: q.patch.status === 'APPROVED' ? (o.claimable === false ? null : { id: 'a1', name: 'Ann', email: 'ann@x.co' }) : { id: 'a1', name: 'Ann', email: 'ann@x.co' }, error: null }
      }
    })
    return { st, ...loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendOwnerAlert: async (e, s) => { st.alerts.push(s) },
        sendPartnerPayoutDetailsRequest: async () => true,
        sendPartnerApplicationReceived: async (...a) => { st.received = (st.received || []).concat([a.slice(3)]); return true },
        sendPartnerApplicationRejected: async (...a) => { st.rejectedEmails = (st.rejectedEmails || []).concat([a.slice(3)]); return true },
      },
    }) }
  }
  const body = { name: 'Ann', email: 'ann@x.co', audience: 'newsletter', acceptTerms: true }
  it('stores a valid application and alerts the owner', async () => {
    t = setupApp()
    const r = await t.mod.applyAsPartner(ctxOf({}, { body }))
    expect(r.body.success).toBe(true)
    expect(t.st.inserts[0]).toMatchObject({ name: 'Ann', email: 'ann@x.co', audience: 'newsletter' })
    expect(t.st.alerts).toContain('New partner application')
    // Round 6: acceptance is recorded with the version, and the applicant is acknowledged.
    expect(t.st.inserts[0].terms_accepted_at).toEqual(expect.any(String))
    expect(t.st.inserts[0].terms_version).toBe('2026-10')
    expect(t.st.received).toEqual([['Ann']])   // (name) — slice(3) of (env, db, email, name)
  })
  it('honeypot: pretends success, stores nothing', async () => {
    t = setupApp()
    const r = await t.mod.applyAsPartner(ctxOf({}, { body: { ...body, company: 'spam inc' } }))
    expect(r.body.success).toBe(true)
    expect(t.st.inserts).toHaveLength(0)
  })
  it('an existing partner email gets the SAME answer and no row (no enumeration)', async () => {
    t = setupApp({ existingPartner: true })
    const r = await t.mod.applyAsPartner(ctxOf({}, { body }))
    expect(r.body.success).toBe(true)
    expect(t.st.inserts).toHaveLength(0)
  })
  it('a duplicate pending application (23505) is also a quiet success', async () => {
    t = setupApp({ insertError: { code: '23505', message: 'dup' } })
    expect((await t.mod.applyAsPartner(ctxOf({}, { body }))).body.success).toBe(true)
    expect(t.st.alerts).toHaveLength(0)
  })
  it('rejects an invalid email with a validation error', async () => {
    t = setupApp()
    await expect(t.mod.applyAsPartner(ctxOf({}, { body: { name: 'A', email: 'nope' } }))).rejects.toThrow()
  })
  it('approve: claims PENDING atomically and creates the partner', async () => {
    t = setupApp()
    const r = await t.mod.adminApproveApplication(ctxOf({ FRONTEND_URL: 'https://x' }, { params: { id: 'a1' } }))
    expect(r.body.success).toBe(true)
    expect(t.st.created[0]).toMatchObject({ name: 'Ann', email: 'ann@x.co' })
  })
  it('approve: an already-reviewed application is a 404 and creates nothing', async () => {
    t = setupApp({ claimable: false })
    const r = await t.mod.adminApproveApplication(ctxOf({}, { params: { id: 'a1' } }))
    expect(r.status).toBe(404)
    expect(t.st.created).toHaveLength(0)
  })
  it('approve: if the email is already a partner the claim is put back to PENDING', async () => {
    t = setupApp({ existingPartner: true })
    const r = await t.mod.adminApproveApplication(ctxOf({}, { params: { id: 'a1' } }))
    expect(r.status).toBe(400)
    expect(t.st.updates.some(u => u.status === 'PENDING')).toBe(true)
  })
  it('reject: PENDING -> REJECTED', async () => {
    t = setupApp()
    expect((await t.mod.adminRejectApplication(ctxOf({}, { params: { id: 'a1' } }))).body.success).toBe(true)
    expect(t.st.updates[0].status).toBe('REJECTED')
  })
})

// ── referral.service / fulfillment.service ──────────────────────────────────
describe('recordConversion — refund landed before the commission', () => {
  it('reverses immediately instead of leaving a positive commission on a REFUNDED sale', async () => {
    const inserts = []
    const db = createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: { id: 'rc1', partner_id: 'p1', code: 'A' }, error: null }
      if (q.table === 'partners') return { data: { name: 'K', email: 'k@x.co', commission_rate: 0.2, payout_details_token: 't' }, error: null }
      if (q.table === 'payments') return { data: { status: 'REFUNDED' }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'insert') { inserts.push(q.values); return { data: { id: inserts.length === 1 ? 'led1' : 'rev1' }, error: null } }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: { id: 'led1', payment_id: 'pay1', partner_id: 'p1', referral_code_id: 'rc1', gross_amount_cents: 1900, commission_rate: 0.2, commission_amount_cents: 380, usage_counted: true, payout_id: null }, error: null }
      if (q.op === 'rpc') return { data: true, error: null }
    })
    t = loadWithStubs('services/referral.service.js', {})
    const r = await t.mod.recordConversion(db, { id: 'pay1', referral_code_id: 'rc1', amount_cents: 1900, currency: 'USD' })
    expect(r).toMatchObject({ ok: true, recorded: true, reversedImmediately: true })
    expect(inserts).toHaveLength(2)
    expect(inserts[1]).toMatchObject({ reverses_ledger_id: 'led1', commission_amount_cents: -380, reversal_reason: 'REFUND' })
  })
})

describe('reverseCommission — usage slot', () => {
  const original = (over = {}) => ({ id: 'led1', payment_id: 'pay1', partner_id: 'p1', referral_code_id: 'rc1', gross_amount_cents: 1900, commission_rate: 0.2, commission_amount_cents: 380, usage_counted: true, payout_id: null, currency: 'USD', ...over })
  function run(orig, insertError = null) {
    const rpcs = []
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') { rpcs.push(q); return { data: null, error: null } }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: orig, error: null }
      if (q.table === 'commission_ledger' && q.op === 'insert') return { data: null, error: insertError }
    })
    t = loadWithStubs('services/fulfillment.service.js', {})
    return t.mod.reverseCommission(db, 'pay1', 'REFUND').then(r => ({ r, rpcs }))
  }
  it('frees the code usage slot exactly once and carries currency + partner on the reversal', async () => {
    const { r, rpcs } = await run(original())
    expect(r).toMatchObject({ reversed: true, partnerId: 'p1', currency: 'USD' })
    expect(rpcs.map(x => x.name)).toEqual(['release_referral_code_usage_for_ledger'])
    expect(rpcs[0].args).toEqual({ p_ledger_id: 'led1' })
  })
  // Section 4 round 9: whether a slot was really consumed is decided in SQL under the ledger row's lock, AFTER the
  // reversal exists (a stale usage_counted read here is exactly what leaked slots). So an uncounted-looking row
  // still asks — and the migration's function refuses when nothing was counted.
  it('asks the database to release even when the row read says usage was not counted yet (race-safe)', async () => {
    const { rpcs } = await run(original({ usage_counted: false }))
    expect(rpcs.map(x => x.name)).toEqual(['release_referral_code_usage_for_ledger'])
  })
  it('a sale with no referral code releases nothing', async () => {
    const { rpcs } = await run(original({ referral_code_id: null }))
    expect(rpcs).toHaveLength(0)
  })
  it('an already-reversed sale (23505) frees nothing a second time', async () => {
    const { r, rpcs } = await run(original(), { code: '23505', message: 'dup' })
    expect(r.reversed).toBe(false)
    expect(rpcs).toHaveLength(0)
  })
})
