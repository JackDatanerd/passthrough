import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Focused coverage for the payout-link admin fallback (AUDIT FIX, feature
// gap) — adminResendPayoutLink and adminRegeneratePayoutLink previously
// only reported whether the EMAIL sent, with no way for the admin to
// recover the URL itself if delivery failed. This locks in that both now
// echo payoutUrl back in their response, while leaving partnerRowToCamel's
// existing "never expose the token" invariant everywhere else untouched.

function setup(opts = {}) {
  const state = { emailSent: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'partners' && q.op === 'select') return { data: opts.partner ?? null, error: null }
    if (q.table === 'partners' && q.op === 'update')  return { data: opts.partner ?? null, error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendPartnerPayoutDetailsRequest: async () => { state.emailSent.push('resend'); return opts.emailOk ?? true },
      sendPartnerLinkRegenerated:      async () => { state.emailSent.push('regenerate'); return opts.emailOk ?? true },
    },
  })
  const env = { FRONTEND_URL: 'https://passthrough.dev' }
  const c = () => ({
    env,
    req: { param: () => 'p1' },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, c }
}

let t
afterEach(() => t?.restore())

describe('adminResendPayoutLink', () => {
  it('returns payoutUrl built from the existing token, alongside success', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co', payout_details_token: 'tok123' } })
    const res = await t.mod.adminResendPayoutLink(t.c())
    expect(res.body.success).toBe(true)
    expect(res.body.payoutUrl).toBe('https://passthrough.dev/partner/payout-details?token=tok123')
  })

  it('still returns payoutUrl even when the email send itself fails', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co', payout_details_token: 'tok123' }, emailOk: false })
    const res = await t.mod.adminResendPayoutLink(t.c())
    expect(res.body.success).toBe(false)
    expect(res.body.payoutUrl).toBe('https://passthrough.dev/partner/payout-details?token=tok123')
  })

  it('404s with no payoutUrl at all when the partner does not exist', async () => {
    t = setup({ partner: null })
    const res = await t.mod.adminResendPayoutLink(t.c())
    expect(res.status).toBe(404)
    expect(res.body.payoutUrl).toBeUndefined()
  })
})

describe('adminRegeneratePayoutLink', () => {
  it('returns payoutUrl built from the freshly rotated token', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co' } })
    const res = await t.mod.adminRegeneratePayoutLink(t.c())
    expect(res.body.success).toBe(true)
    expect(res.body.payoutUrl).toMatch(/^https:\/\/passthrough\.dev\/partner\/payout-details\?token=.+/)
  })

  it('still returns payoutUrl even when the notification email fails', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co' }, emailOk: false })
    const res = await t.mod.adminRegeneratePayoutLink(t.c())
    expect(res.body.emailed).toBe(false)
    expect(res.body.payoutUrl).toBeTruthy()
  })
})

// AUDIT FIX (bug — concurrent double-record): the ledger settlement used to
// have no guard against a row that a CONCURRENT adminRecordPayout call had
// already claimed — it just overwrote payout_id unconditionally for every id
// it read moments earlier. These lock in the atomic-claim fix: the
// settlement is now `.is('payout_id', null)`-guarded and reports back
// exactly what it won, and a partial claim (another payout beat it to some
// rows) corrects the auto-computed amount and alerts the owner instead of
// silently overstating what this payout settled.
function setupPayout(opts = {}) {
  const state = { payoutInserts: [], ledgerUpdateFilters: [], payoutCorrections: [], alerts: [], sendPayoutSentCalls: [] }
  const partner = 'partner' in opts ? opts.partner
    : { id: 'p1', name: 'Coach K', email: 'k@x.co', payout_method: 'BANK', payout_details: { bankName: 'X' } }
  const unpaidLedger = 'unpaidLedger' in opts
    ? opts.unpaidLedger
    : [{ id: 'l1', commission_amount_cents: 500 }, { id: 'l2', commission_amount_cents: 700 }]
  // What the atomic claim UPDATE...RETURNING actually reports as claimed —
  // defaults to "won everything it asked for" (the no-race case).
  const claimed = 'claimed' in opts ? opts.claimed : unpaidLedger

  const db = createFakeSupabase(q => {
    if (q.table === 'partners' && q.op === 'select') return { data: partner, error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: unpaidLedger, error: null }
    if (q.table === 'payouts' && q.op === 'insert') {
      state.payoutInserts.push(q.values)
      return { data: { id: 'payout1', ...q.values }, error: opts.insertError || null }
    }
    if (q.table === 'commission_ledger' && q.op === 'update') {
      state.ledgerUpdateFilters.push(q.filters)
      return { data: claimed, error: opts.settleError || null }
    }
    if (q.table === 'payouts' && q.op === 'update') {
      state.payoutCorrections.push(q.patch)
      return { data: { id: 'payout1', ...state.payoutInserts[0], ...q.patch }, error: opts.correctError || null }
    }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert:  async (e, subject, message) => { state.alerts.push({ subject, message }) },
      sendPayoutSent:  async (e, s, email, name, amountCents, currency) => {
        state.sendPayoutSentCalls.push({ amountCents, currency }); return true
      },
    },
  })
  const env = {}
  const c = (over = {}) => ({
    env,
    req: { param: () => 'p1', json: async () => (over.body ?? {}) },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, db, c }
}

describe('adminRecordPayout', () => {
  it('settles every unpaid ledger row with the guarded atomic claim (no race): no correction, no alert', async () => {
    t = setupPayout()
    const res = await t.mod.adminRecordPayout(t.c())
    expect(res.body.success).toBe(true)
    expect(res.body.racedWithConcurrentPayout).toBe(false)
    expect(res.body.data.amountCents).toBe(1200)   // 500 + 700, auto-computed
    expect(t.state.payoutCorrections).toHaveLength(0)
    expect(t.state.alerts).toHaveLength(0)
    expect(t.state.sendPayoutSentCalls[0].amountCents).toBe(1200)
    // the settlement guard itself: still filtered on payout_id IS NULL
    expect(t.state.ledgerUpdateFilters[0].some(f => f[0] === 'is' && f[1] === 'payout_id' && f[2] === null)).toBe(true)
  })

  it('corrects the auto-computed amount down when a concurrent payout claimed some rows first, and alerts', async () => {
    // Only l1 was still available to claim by the time this call's UPDATE ran —
    // l2 was already grabbed by a concurrent adminRecordPayout for the same partner.
    t = setupPayout({ claimed: [{ id: 'l1', commission_amount_cents: 500 }] })
    const res = await t.mod.adminRecordPayout(t.c())
    expect(res.body.racedWithConcurrentPayout).toBe(true)
    expect(res.body.data.amountCents).toBe(500)   // corrected down from the stale 1200 read
    expect(t.state.payoutCorrections).toEqual([{ amount_cents: 500 }])
    expect(t.state.sendPayoutSentCalls[0].amountCents).toBe(500)   // notifies with the corrected amount
    expect(t.state.alerts.some(a => /raced/i.test(a.subject))).toBe(true)
  })

  it('does NOT silently override an explicitly-entered amount on a race, but still alerts', async () => {
    t = setupPayout({ claimed: [{ id: 'l1', commission_amount_cents: 500 }] })
    const res = await t.mod.adminRecordPayout(t.c({ body: { amountCents: 1200 } }))
    expect(res.body.racedWithConcurrentPayout).toBe(true)
    expect(res.body.data.amountCents).toBe(1200)   // left exactly as the admin typed it
    expect(t.state.payoutCorrections).toHaveLength(0)   // no auto-correction over a manual figure
    expect(t.state.alerts.some(a => /raced/i.test(a.subject))).toBe(true)
  })

  it('claiming everything it asked for is not treated as a race, even with zero unpaid rows', async () => {
    t = setupPayout({ unpaidLedger: [], claimed: [] })
    const res = await t.mod.adminRecordPayout(t.c({ body: { amountCents: 5000, note: 'Bonus' } }))
    expect(res.body.racedWithConcurrentPayout).toBe(false)
    expect(res.body.data.amountCents).toBe(5000)
    expect(t.state.alerts).toHaveLength(0)
  })

  it('400s when the partner has no payout method on file and none was provided', async () => {
    t = setupPayout({ partner: { id: 'p1', name: 'Coach K', email: 'k@x.co', payout_method: null } })
    const res = await t.mod.adminRecordPayout(t.c())
    expect(res.status).toBe(400)
  })

  it('404s for an unknown partner', async () => {
    t = setupPayout({ partner: null })
    const res = await t.mod.adminRecordPayout(t.c())
    expect(res.status).toBe(404)
  })

  // AUDIT FIX (Section 3/4 pass, bug): currency used to hardcode-default to
  // 'USD' regardless of the platform's actual configured currency, unlike
  // every other money-shaped field in this controller (adminGetPartner,
  // adminListPartners, getPartnerDashboard all derive it from
  // env.PAYSTACK_CURRENCY). It's now resolved the same way here too.
  it('defaults currency to env.PAYSTACK_CURRENCY, not a hardcoded USD, when the caller omits it', async () => {
    t = setupPayout()
    const call = t.c()
    call.env.PAYSTACK_CURRENCY = 'KES'
    const res = await t.mod.adminRecordPayout(call)
    expect(res.body.success).toBe(true)
    expect(t.state.payoutInserts.at(-1).currency).toBe('KES')
    expect(t.state.sendPayoutSentCalls.at(-1).currency).toBe('KES')
  })

  it('still respects an explicitly-supplied currency over the platform default', async () => {
    t = setupPayout()
    const call = t.c({ body: { currency: 'NGN' } })
    call.env.PAYSTACK_CURRENCY = 'KES'
    const res = await t.mod.adminRecordPayout(call)
    expect(res.body.success).toBe(true)
    expect(t.state.payoutInserts.at(-1).currency).toBe('NGN')
  })
})

// AUDIT FIX (feature gap): getPartnerDashboard's referral_codes /
// commission_ledger / payouts sub-selects came back in whatever order
// Postgres felt like, and the partner-facing dashboard never rendered
// commissionLedger at all — a partner could see aggregate cycle totals but
// never "did the click from X actually convert, and when". Locks in both:
// the three sub-relations are now explicitly ordered newest-first, matching
// adminGetPartner's existing convention for the same three relations.
describe('getPartnerDashboard', () => {
  function setupDashboard(partner) {
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: partner, error: null }
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
    })
    const c = { env: {}, req: { query: () => 'tok123' }, json: (body, status = 200) => ({ body, status }) }
    return { mod, restore, db, c }
  }

  it('orders referral_codes, commission_ledger, and payouts newest-first', async () => {
    const { mod, restore, db, c } = setupDashboard({
      name: 'Coach K', commission_rate: 0.2, referral_codes: [], commission_ledger: [], payouts: [],
    })
    await mod.getPartnerDashboard(c)
    const q = db.calls.find(call => call.table === 'partners')
    expect(q.orders).toEqual([
      ['paid_at',    { foreignTable: 'payouts', ascending: false }],
      ['created_at', { foreignTable: 'referral_codes', ascending: false }],
      ['created_at', { foreignTable: 'commission_ledger', ascending: false }],
    ])
    restore()
  })

  it('returns commissionLedger (not just aggregated stats) for the frontend to render', async () => {
    const { mod, restore, c } = setupDashboard({
      name: 'Coach K', commission_rate: 0.2,
      referral_codes: [{ id: 'rc1', clicks: 5 }],
      commission_ledger: [{ id: 'l1', payment_id: 'p1', partner_id: 'pt1', referral_code_id: 'rc1',
        gross_amount_cents: 2900, commission_rate: 0.2, commission_amount_cents: 580, payout_id: null, created_at: '2026-09-01T00:00:00Z' }],
      payouts: [],
    })
    const r = await mod.getPartnerDashboard(c)
    expect(r.body.data.commissionLedger).toHaveLength(1)
    expect(r.body.data.commissionLedger[0]).toMatchObject({ grossAmountCents: 2900, commissionAmountCents: 580 })
    restore()
  })

  // Not yet covered elsewhere: the AUDIT FIX (bug) above this file's
  // buildCyclesSummary/totalConversions — a refund is a second ledger row
  // (reverses_ledger_id set), which must net out of "how many sales" rather
  // than counting as a second conversion.
  it('totalConversions counts only original sales, not their reversal rows', async () => {
    const { mod, restore, c } = setupDashboard({
      name: 'Coach K', commission_rate: 0.2,
      referral_codes: [],
      commission_ledger: [
        { id: 'l1', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null, created_at: '2026-09-01T00:00:00Z' },
        { id: 'l2', reverses_ledger_id: 'l1', gross_amount_cents: -2900, commission_amount_cents: -580, payout_id: null, created_at: '2026-09-02T00:00:00Z' },
      ],
      payouts: [],
    })
    const r = await mod.getPartnerDashboard(c)
    expect(r.body.data.stats.totalConversions).toBe(1)
    restore()
  })

  // AUDIT FIX (Section 3/4 pass, bug): getPartnerDashboard never selected or
  // returned the partner's own status, so a paused partner's dashboard had
  // no way to reflect it — PartnerDashboard.jsx's isCodeLive showed every
  // code as fully live regardless. `active` now mirrors isCodeUsable's
  // partner-status check (referral.service.js) for the frontend to use.
  it('returns active: true for an ACTIVE partner and active: false for a PAUSED one', async () => {
    const activeCase = setupDashboard({ name: 'Coach K', commission_rate: 0.2, status: 'ACTIVE', referral_codes: [], commission_ledger: [], payouts: [] })
    const activeRes = await activeCase.mod.getPartnerDashboard(activeCase.c)
    expect(activeRes.body.data.active).toBe(true)
    activeCase.restore()

    const pausedCase = setupDashboard({ name: 'Coach K', commission_rate: 0.2, status: 'PAUSED', referral_codes: [], commission_ledger: [], payouts: [] })
    const pausedRes = await pausedCase.mod.getPartnerDashboard(pausedCase.c)
    expect(pausedRes.body.data.active).toBe(false)
    pausedCase.restore()
  })

  // AUDIT FIX (Section 3/4 pass, bug): commission_ledger has no currency
  // column, and every commission-derived figure on this page (Pending, Paid
  // to date, per-tier prices) used to render via formatCents with no
  // currency argument, always defaulting to USD regardless of what's
  // actually configured.
  it('returns env.PAYSTACK_CURRENCY as currency, defaulting to USD when unset', async () => {
    const { mod, restore, c } = setupDashboard({ name: 'Coach K', commission_rate: 0.2, referral_codes: [], commission_ledger: [], payouts: [] })
    const r = await mod.getPartnerDashboard(c)
    expect(r.body.data.currency).toBe('USD')
    restore()

    const kes = setupDashboard({ name: 'Coach K', commission_rate: 0.2, referral_codes: [], commission_ledger: [], payouts: [] })
    kes.c.env = { PAYSTACK_CURRENCY: 'KES' }
    const r2 = await kes.mod.getPartnerDashboard(kes.c)
    expect(r2.body.data.currency).toBe('KES')
    kes.restore()
  })
})

// SECTION 12 AUDIT: the remaining 9 of 15 functions in this file had zero
// coverage — CRUD on partners and referral codes, the two public
// token-gated endpoints, and click tracking.

describe('adminCreatePartner', () => {
  function setupCreate(opts = {}) {
    const state = { inserted: null, emailed: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'insert') { state.inserted = q.values; return { data: { id: 'p1', ...q.values }, error: opts.insertError || null } }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPartnerPayoutDetailsRequest: async (...a) => { state.emailed.push(a); if (opts.emailThrows) throw new Error('mail down') } },
      'lib/crypto.js': { randomToken: () => 'tok-fixed' },
    })
    const c = { env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { json: async () => opts.body ?? { name: 'Coach K', email: 'k@x.co' } }, json: (body, status = 200) => ({ body, status }) }
    return { mod, restore, state, c, db }
  }

  it('creates the partner with a fresh token and never returns the token in the response', async () => {
    t = setupCreate()
    const res = await t.mod.adminCreatePartner(t.c)
    expect(res.body.success).toBe(true)
    expect(t.state.inserted).toMatchObject({ name: 'Coach K', email: 'k@x.co', payout_details_token: 'tok-fixed' })
    expect(res.body.data.payoutDetailsToken).toBeUndefined()
    expect(JSON.stringify(res.body.data)).not.toContain('tok-fixed')
  })

  it('a failed notification email never fails partner creation', async () => {
    t = setupCreate({ emailThrows: true })
    const res = await t.mod.adminCreatePartner(t.c)
    expect(res.body.success).toBe(true)
  })

  it('rejects an invalid email', async () => {
    t = setupCreate({ body: { name: 'Coach K', email: 'not-an-email' } })
    await expect(t.mod.adminCreatePartner(t.c)).rejects.toThrow()
  })

  it('propagates an insert error', async () => {
    t = setupCreate({ insertError: new Error('db down') })
    await expect(t.mod.adminCreatePartner(t.c)).rejects.toThrow('db down')
  })
})

describe('adminUpdatePartner', () => {
  function setupUpdate(opts = {}) {
    const state = { patch: null, notifications: [] }
    const before = 'before' in opts ? opts.before : { email: 'old@x.co' }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: before, error: null }
      if (q.table === 'partners' && q.op === 'update') { state.patch = q.patch; return { data: opts.updated ?? null, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendPartnerEmailChanged:  async (...a) => state.notifications.push({ type: 'emailChanged', to: a[2] }),
        sendPartnerStatusChanged: async (...a) => state.notifications.push({ type: 'statusChanged', to: a[2], status: a[4] }),
        sendOwnerAlert:           async (...a) => state.notifications.push({ type: 'ownerAlert', subject: a[1] }),
      },
    })
    const c = (over = {}) => ({ env: {}, req: { param: () => 'p1', json: async () => over.body ?? {} }, json: (body, status = 200) => ({ body, status }) })
    return { mod, restore, state, c }
  }

  it('rejects an empty body', async () => {
    t = setupUpdate()
    await expect(t.mod.adminUpdatePartner(t.c({ body: {} }))).rejects.toThrow()
  })

  it('404s when the partner does not exist', async () => {
    t = setupUpdate({ updated: null })
    const res = await t.mod.adminUpdatePartner(t.c({ body: { status: 'PAUSED' } }))
    expect(res.status).toBe(404)
  })

  it('updates status/commissionRate via the generic mapper, and name/email as explicit fields', async () => {
    t = setupUpdate({ updated: { id: 'p1', email: 'old@x.co', name: 'X' } })
    await t.mod.adminUpdatePartner(t.c({ body: { status: 'PAUSED', commissionRate: 0.3, name: 'New Name' } }))
    expect(t.state.patch).toMatchObject({ status: 'PAUSED', commission_rate: 0.3, name: 'New Name' })
  })

  it('notifies both old and new addresses (plus the owner) only when the email actually changes', async () => {
    t = setupUpdate({ before: { email: 'old@x.co' }, updated: { id: 'p1', email: 'new@x.co', name: 'X' } })
    await t.mod.adminUpdatePartner(t.c({ body: { email: 'new@x.co' } }))
    expect(t.state.notifications.filter(n => n.type === 'emailChanged')).toHaveLength(2)
    expect(t.state.notifications.some(n => n.type === 'ownerAlert')).toBe(true)
  })

  it('does not notify when email is provided but unchanged, or not provided at all', async () => {
    t = setupUpdate({ before: { email: 'same@x.co' }, updated: { id: 'p1', email: 'same@x.co', name: 'X' } })
    await t.mod.adminUpdatePartner(t.c({ body: { email: 'same@x.co' } }))
    expect(t.state.notifications).toHaveLength(0)
    t.restore()

    t = setupUpdate({ updated: { id: 'p1', email: 'old@x.co', name: 'X' } })
    await t.mod.adminUpdatePartner(t.c({ body: { status: 'ACTIVE' } }))
    expect(t.state.notifications).toHaveLength(0)
  })

  // AUDIT FIX (feature gap): status (ACTIVE/PAUSED) previously had no
  // notification at all, unlike every other account-affecting change in
  // this endpoint (email). Mirrors the email-change tests above.
  it('notifies the partner and the owner when status actually changes', async () => {
    t = setupUpdate({ before: { email: 'k@x.co', status: 'ACTIVE' }, updated: { id: 'p1', email: 'k@x.co', name: 'Coach K', status: 'PAUSED' } })
    await t.mod.adminUpdatePartner(t.c({ body: { status: 'PAUSED' } }))
    const statusNotif = t.state.notifications.find(n => n.type === 'statusChanged')
    expect(statusNotif).toMatchObject({ to: 'k@x.co', status: 'PAUSED' })
    expect(t.state.notifications.some(n => n.type === 'ownerAlert' && /Partner status changed/.test(n.subject))).toBe(true)
  })

  it('does not notify on status when it is provided but unchanged', async () => {
    t = setupUpdate({ before: { email: 'k@x.co', status: 'ACTIVE' }, updated: { id: 'p1', email: 'k@x.co', name: 'Coach K', status: 'ACTIVE' } })
    await t.mod.adminUpdatePartner(t.c({ body: { status: 'ACTIVE', commissionRate: 0.3 } }))
    expect(t.state.notifications.filter(n => n.type === 'statusChanged')).toHaveLength(0)
  })

  it('a failed status-change notification never fails the update itself', async () => {
    t = setupUpdate({ before: { email: 'k@x.co', status: 'ACTIVE' }, updated: { id: 'p1', email: 'k@x.co', name: 'Coach K', status: 'PAUSED' } })
    t.restore()
    const state = t.state
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { email: 'k@x.co', status: 'ACTIVE' }, error: null }
      if (q.table === 'partners' && q.op === 'update') return { data: { id: 'p1', email: 'k@x.co', name: 'Coach K', status: 'PAUSED' }, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendPartnerStatusChanged: async () => { throw new Error('resend down') },
        sendOwnerAlert:           async () => { throw new Error('resend down') },
      },
    })
    const res = await mod.adminUpdatePartner({ env: {}, req: { param: () => 'p1', json: async () => ({ status: 'PAUSED' }) }, json: (body, status = 200) => ({ body, status }) })
    expect(res.body.success).toBe(true)
    restore()
  })

  it('rejects a commissionRate outside 0-1', async () => {
    t = setupUpdate()
    await expect(t.mod.adminUpdatePartner(t.c({ body: { commissionRate: 1.5 } }))).rejects.toThrow()
  })
})

describe('adminListPartners', () => {
  function setupList(rows) {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: rows, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: {}, json: (body, status = 200) => ({ body, status }) }
    return { mod, restore, c }
  }

  it('an unpaid ledger row from a PRIOR cycle counts as ready-to-pay; one from the CURRENT cycle only counts as accruing', async () => {
    const old = new Date(); old.setUTCMonth(old.getUTCMonth() - 2)
    t = setupList([{
      id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commission_rate: '0.2500',
      payouts: [], referral_codes: [],
      commission_ledger: [
        { id: 'l1', partner_id: 'p1', gross_amount_cents: 4900, commission_amount_cents: 500, payout_id: null, created_at: old.toISOString() },
        { id: 'l2', partner_id: 'p1', gross_amount_cents: 3900, commission_amount_cents: 300, payout_id: null, created_at: new Date().toISOString() },
      ],
    }])
    const res = await t.mod.adminListPartners(t.c)
    const p = res.body.data[0]
    expect(p.pendingCommissionCents).toBe(800)
    expect(p.currentCycleAccruedCents).toBe(300)
    expect(p.readyToPayCents).toBe(500)
    expect(p.commissionLedger).toBeUndefined()   // never shipped in the list view
  })

  it('a paid ledger row never counts toward pending', async () => {
    t = setupList([{
      id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commission_rate: '0.2500',
      payouts: [], referral_codes: [],
      commission_ledger: [{ id: 'l1', gross_amount_cents: 4900, commission_amount_cents: 500, payout_id: 'payout1', created_at: new Date().toISOString() }],
    }])
    const res = await t.mod.adminListPartners(t.c)
    expect(res.body.data[0].pendingCommissionCents).toBe(0)
    expect(res.body.data[0].readyToPayCents).toBe(0)
  })

  // AUDIT FIX (Section 3/4 pass, bug): commission_ledger has no currency
  // column — every commission-derived figure here (readyToPayCents,
  // currentCycleAccruedCents, pendingCommissionCents) used to render via
  // AdminPartners.jsx's formatCents with no currency argument, always
  // defaulting to USD regardless of what's actually configured.
  it('carries env.PAYSTACK_CURRENCY as each partner\'s currency, defaulting to USD', async () => {
    const rows = [{ id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commission_rate: '0.2500', payouts: [], referral_codes: [], commission_ledger: [] }]
    t = setupList(rows)
    const res = await t.mod.adminListPartners(t.c)
    expect(res.body.data[0].currency).toBe('USD')

    const db2 = createFakeSupabase(q => (q.table === 'partners' ? { data: rows, error: null } : undefined))
    const kes = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db2 } })
    const res2 = await kes.mod.adminListPartners({ env: { PAYSTACK_CURRENCY: 'KES' }, req: {}, json: (body, status = 200) => ({ body, status }) })
    expect(res2.body.data[0].currency).toBe('KES')
    kes.restore()
  })
})

describe('adminGetPartner', () => {
  function setupGet(row) {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: row, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: { param: () => 'p1' }, json: (body, status = 200) => ({ body, status }) }
    return { mod, restore, db, c }
  }

  it('404s for an unknown partner', async () => {
    t = setupGet(null)
    const res = await t.mod.adminGetPartner(t.c)
    expect(res.status).toBe(404)
  })

  it('returns the full ledger and a 12-cycle summary', async () => {
    t = setupGet({
      id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commission_rate: '0.2500',
      payouts: [], referral_codes: [],
      commission_ledger: [{ id: 'l1', payment_id: 'pay1', partner_id: 'p1', referral_code_id: 'rc1', gross_amount_cents: 4900, commission_rate: '0.2500', commission_amount_cents: 1225, payout_id: null, created_at: new Date().toISOString() }],
    })
    const res = await t.mod.adminGetPartner(t.c)
    expect(res.body.data.commissionLedger).toHaveLength(1)
    expect(res.body.data.cyclesSummary).toHaveLength(12)
    expect(res.body.data.pendingCommissionCents).toBe(1225)
  })

  // AUDIT FIX (feature gap) under test: payout_details_snapshot is written by
  // adminRecordPayout specifically to preserve which account a payout
  // actually went to, independent of whatever the partner's payout_details
  // says NOW — it was never selected back anywhere until this fix.
  it('surfaces each payout\'s point-in-time payoutDetailsSnapshot', async () => {
    t = setupGet({
      id: 'p1', name: 'Coach K', payouts: [
        { id: 'po1', partner_id: 'p1', amount_cents: 5000, currency: 'USD', payout_method: 'BANK', status: 'PAID', created_at: new Date().toISOString(), payout_details_snapshot: { bankName: 'Old Bank', accountNumber: '0001' } },
      ],
      referral_codes: [], commission_ledger: [],
    })
    const res = await t.mod.adminGetPartner(t.c)
    expect(res.body.data.payouts[0].payoutDetailsSnapshot).toEqual({ bankName: 'Old Bank', accountNumber: '0001' })
  })

  it('orders payouts/referral_codes/commission_ledger newest-first', async () => {
    t = setupGet({ id: 'p1', name: 'X', payouts: [], referral_codes: [], commission_ledger: [] })
    await t.mod.adminGetPartner(t.c)
    const call = t.db.calls.find(c => c.table === 'partners')
    expect(call.orders).toEqual([
      ['paid_at', { foreignTable: 'payouts', ascending: false }],
      ['created_at', { foreignTable: 'referral_codes', ascending: false }],
      ['created_at', { foreignTable: 'commission_ledger', ascending: false }],
    ])
  })

  // AUDIT FIX (Section 3/4 pass, bug): same currency-drift gap as
  // adminListPartners above — commissionLedger/pendingCommissionCents/
  // cyclesSummary figures here rendered via PartnerDetail.jsx's formatCents
  // with no currency argument, always defaulting to USD.
  it('returns env.PAYSTACK_CURRENCY as currency, defaulting to USD when unset', async () => {
    t = setupGet({ id: 'p1', name: 'X', payouts: [], referral_codes: [], commission_ledger: [] })
    const res = await t.mod.adminGetPartner(t.c)
    expect(res.body.data.currency).toBe('USD')

    const row = { id: 'p1', name: 'X', payouts: [], referral_codes: [], commission_ledger: [] }
    const db2 = createFakeSupabase(q => (q.table === 'partners' ? { data: row, error: null } : undefined))
    const kes = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db2 } })
    const res2 = await kes.mod.adminGetPartner({ env: { PAYSTACK_CURRENCY: 'KES' }, req: { param: () => 'p1' }, json: (body, status = 200) => ({ body, status }) })
    expect(res2.body.data.currency).toBe('KES')
    kes.restore()
  })
})

describe('adminCreateReferralCode', () => {
  function setupCreateCode(opts = {}) {
    const state = { inserted: null, emailed: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: opts.partner ?? null, error: null }
      if (q.table === 'referral_codes' && q.op === 'insert') { state.inserted = q.values; return { data: { id: 'rc1', ...q.values }, error: opts.insertError || null } }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendReferralCodeCreated: async (...a) => state.emailed.push(a) },
    })
    const c = { env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { param: () => 'p1', json: async () => opts.body ?? { code: 'coach20', tierPrices: { FIX: 1900 } } }, json: (body, status = 200) => ({ body, status }) }
    return { mod, restore, state, c }
  }

  it('404s for an unknown partner, before ever inserting a code', async () => {
    t = setupCreateCode({ partner: null })
    const res = await t.mod.adminCreateReferralCode(t.c)
    expect(res.status).toBe(404)
    expect(t.state.inserted).toBeNull()
  })

  it('uppercases and trims the code before storing it', async () => {
    t = setupCreateCode({ partner: { name: 'Coach K', email: 'k@x.co', payout_details_token: 'tok' } })
    await t.mod.adminCreateReferralCode(t.c)
    expect(t.state.inserted.code).toBe('COACH20')
  })

  it('rejects a body with no tier prices set', async () => {
    t = setupCreateCode({ partner: { name: 'Coach K', email: 'k@x.co' }, body: { code: 'X20', tierPrices: {} } })
    await expect(t.mod.adminCreateReferralCode(t.c)).rejects.toThrow()
  })

  it('a failed notification email never fails code creation', async () => {
    const state = { inserted: null }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { name: 'Coach K', email: 'k@x.co', payout_details_token: 'tok' }, error: null }
      if (q.table === 'referral_codes' && q.op === 'insert') { state.inserted = q.values; return { data: { id: 'rc1', ...q.values }, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendReferralCodeCreated: async () => { throw new Error('mail down') } },
    })
    const c = { env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { param: () => 'p1', json: async () => ({ code: 'coach20', tierPrices: { FIX: 1900 } }) }, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.adminCreateReferralCode(c)
    expect(res.body.success).toBe(true)
    restore()
  })
})

describe('adminUpdateReferralCode', () => {
  function setupUpdateCode(opts = {}) {
    const state = { patch: null }
    const db = createFakeSupabase(q => {
      if (q.table === 'referral_codes' && q.op === 'update') { state.patch = q.patch; return { data: opts.updated ?? null, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = (over = {}) => ({ env: {}, req: { param: () => 'rc1', json: async () => over.body ?? {} }, json: (body, status = 200) => ({ body, status }) })
    return { mod, restore, state, c }
  }

  it('rejects an empty body', async () => {
    t = setupUpdateCode()
    await expect(t.mod.adminUpdateReferralCode(t.c({ body: {} }))).rejects.toThrow()
  })

  it('404s for an unknown code', async () => {
    t = setupUpdateCode({ updated: null })
    const res = await t.mod.adminUpdateReferralCode(t.c({ body: { active: false } }))
    expect(res.status).toBe(404)
  })

  it('toggling active alone leaves pricing/limits untouched', async () => {
    t = setupUpdateCode({ updated: { id: 'rc1', active: false } })
    await t.mod.adminUpdateReferralCode(t.c({ body: { active: false } }))
    expect(t.state.patch).toEqual({ active: false })
  })

  it('an explicit null usageLimit/expiresAt clears the field (distinct from omitting it)', async () => {
    t = setupUpdateCode({ updated: { id: 'rc1' } })
    await t.mod.adminUpdateReferralCode(t.c({ body: { usageLimit: null, expiresAt: null } }))
    expect(t.state.patch).toEqual({ usage_limit: null, expires_at: null })
  })

  it('never allows changing the code string itself (not in the schema at all)', async () => {
    t = setupUpdateCode({ updated: { id: 'rc1' } })
    await t.mod.adminUpdateReferralCode(t.c({ body: { active: true, code: 'HACKED' } }))
    expect(t.state.patch.code).toBeUndefined()
  })
})

describe('getPartnerByToken', () => {
  function setupToken(opts = {}) {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: opts.partner ?? null, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: { query: () => opts.token }, json: (body, status = 200) => ({ body, status }) }
    return { mod, restore, c }
  }

  it('400s with no token at all', async () => {
    t = setupToken({ token: undefined })
    const res = await t.mod.getPartnerByToken(t.c)
    expect(res.status).toBe(400)
  })

  it('404s for an unknown/expired token', async () => {
    t = setupToken({ token: 'bad', partner: null })
    const res = await t.mod.getPartnerByToken(t.c)
    expect(res.status).toBe(404)
  })

  it('returns partner details without ever leaking the token itself', async () => {
    t = setupToken({ token: 'tok123', partner: { name: 'Coach K', payout_method: 'BANK', payout_details: { bankName: 'X' }, payout_details_submitted_at: 't', payout_details_token: 'tok123' } })
    const res = await t.mod.getPartnerByToken(t.c)
    expect(res.body.data.name).toBe('Coach K')
    expect(JSON.stringify(res.body.data)).not.toContain('tok123')
  })
})

describe('submitPayoutDetails', () => {
  function setupSubmit(opts = {}) {
    const state = { patch: null, notified: [] }
    const db = createFakeSupabase(q => (q.table === 'partners' && q.op === 'update'
      ? (state.patch = q.patch, { data: opts.updated ?? null, error: null }) : undefined))
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendPayoutDetailsChanged: async () => state.notified.push('partner'),
        sendOwnerAlert:           async () => state.notified.push('owner'),
      },
    })
    // BUG FIX (traced from Section 9/10 pass — out of scope but found via the
    // full test-suite run, so fixed here per the "trace it and we fix it"
    // rule): `over.token ?? 'tok123'` can't distinguish "caller explicitly
    // passed token: undefined to simulate a missing token" from "caller
    // didn't mention token at all" — both read as `over.token === undefined`,
    // so `??` picked the 'tok123' default either way. That made the "400s
    // with no token" test below call the real submitPayoutDetails with a
    // truthy token, skip its `if (!token)` guard entirely, and fail for an
    // unrelated reason (an empty body failing Zod validation further down) —
    // a false failure that would just as easily have been a false PASS if a
    // real regression had actually removed that guard. The production guard
    // in submitPayoutDetails was never broken; only this mock couldn't
    // exercise it.
    const c = (over = {}) => ({ env: {}, req: { query: () => 'token' in over ? over.token : 'tok123', json: async () => over.body ?? {} }, json: (body, status = 200) => ({ body, status }) })
    return { mod, restore, state, c }
  }

  it('400s with no token', async () => {
    t = setupSubmit()
    const res = await t.mod.submitPayoutDetails(t.c({ token: undefined }))
    expect(res.status).toBe(400)
  })

  it('rejects a body missing required BANK fields', async () => {
    t = setupSubmit()
    await expect(t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK' } }))).rejects.toThrow()
  })

  it('accepts BANK details and stores them under payout_details', async () => {
    t = setupSubmit({ updated: { name: 'Coach K', email: 'k@x.co' } })
    await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: 'X', accountName: 'Coach K', accountNumber: '123' } }))
    expect(t.state.patch.payout_method).toBe('BANK')
    expect(t.state.patch.payout_details).toEqual({ bankName: 'X', accountName: 'Coach K', accountNumber: '123' })
  })

  it('accepts MOBILE_MONEY details', async () => {
    t = setupSubmit({ updated: { name: 'Coach K', email: 'k@x.co' } })
    await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'MOBILE_MONEY', provider: 'M-Pesa', accountName: 'Coach K', phoneNumber: '0700' } }))
    expect(t.state.patch.payout_method).toBe('MOBILE_MONEY')
  })

  it('404s for an unknown/expired token', async () => {
    t = setupSubmit({ updated: null })
    const res = await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: 'X', accountName: 'Y', accountNumber: '1' } }))
    expect(res.status).toBe(404)
  })

  it('notifies both the partner and the owner on a successful change', async () => {
    t = setupSubmit({ updated: { name: 'Coach K', email: 'k@x.co' } })
    await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: 'X', accountName: 'Y', accountNumber: '1' } }))
    expect(t.state.notified.sort()).toEqual(['owner', 'partner'])
  })
})

describe('trackClick', () => {
  function setupTrack() {
    const state = { rpcCalls: [] }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') { state.rpcCalls.push(q); return { data: null, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = (over = {}) => ({ env: {}, req: { json: async () => over.body ?? {} }, json: (body, status = 200) => ({ body, status }) })
    return { mod, restore, state, c }
  }

  it('normalizes the code (trim + uppercase) before the RPC call', async () => {
    t = setupTrack()
    await t.mod.trackClick(t.c({ body: { code: '  coach20 ' } }))
    expect(t.state.rpcCalls[0].name).toBe('increment_referral_code_clicks')
    expect(t.state.rpcCalls[0].args).toEqual({ p_code: 'COACH20' })
  })

  it('a blank code is a silent no-op — still 200, no RPC call', async () => {
    t = setupTrack()
    const res = await t.mod.trackClick(t.c({ body: { code: '   ' } }))
    expect(res.body.success).toBe(true)
    expect(t.state.rpcCalls).toHaveLength(0)
  })

  it('a malformed JSON body never throws (caught and treated as empty)', async () => {
    const state = { rpcCalls: [] }
    const db = createFakeSupabase(q => { if (q.op === 'rpc') state.rpcCalls.push(q) })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: { json: async () => { throw new Error('bad json') } }, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.trackClick(c)
    expect(res.body.success).toBe(true)
    restore()
  })

  it('an RPC error is logged, not thrown — the frontend never has to handle a failure here', async () => {
    const db = createFakeSupabase(q => (q.op === 'rpc' ? { data: null, error: new Error('rpc down') } : undefined))
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: { json: async () => ({ code: 'ABC' }) }, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.trackClick(c)
    expect(res.body.success).toBe(true)
    restore()
  })
})
