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
    header: () => {}, json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, c }
}

let t
afterEach(() => t?.restore())

describe('adminResendPayoutLink', () => {
  it('does NOT return the write-token URL when the email was sent', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co', payout_details_token: 'tok123' } })
    const res = await t.mod.adminResendPayoutLink(t.c())
    expect(res.body.success).toBe(true)
    // Round 6: the write-token URL is only handed back when the email did not go.
    expect(res.body.payoutUrl).toBeUndefined()
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
    header: () => {}, json: (body, status = 200) => ({ body, status }),
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
    expect(t.state.payoutCorrections).toEqual([{ settled_commission_cents: 500, amount_cents: 500 }])
    expect(t.state.sendPayoutSentCalls[0].amountCents).toBe(500)   // notifies with the corrected amount
    expect(t.state.alerts.some(a => /raced/i.test(a.subject))).toBe(true)
  })

  it('does NOT silently override an explicitly-entered amount on a race, but still alerts', async () => {
    t = setupPayout({ claimed: [{ id: 'l1', commission_amount_cents: 500 }] })
    const res = await t.mod.adminRecordPayout(t.c({ body: { amountCents: 1200 } }))
    expect(res.body.racedWithConcurrentPayout).toBe(true)
    expect(res.body.data.amountCents).toBe(1200)   // left exactly as the admin typed it
    // the amount is left as typed; only the true settled figure is recorded
    expect(t.state.payoutCorrections).toEqual([{ settled_commission_cents: 500 }])
    expect(t.state.alerts.some(a => /raced/i.test(a.subject))).toBe(true)
  })

  it('claiming everything it asked for is not treated as a race, even with zero unpaid rows', async () => {
    t = setupPayout({ unpaidLedger: [], claimed: [] })
    const res = await t.mod.adminRecordPayout(t.c({ body: { amountCents: 5000, note: 'Bonus', acknowledgeDifference: true } }))
    expect(res.body.racedWithConcurrentPayout).toBe(false)
    expect(res.body.data.amountCents).toBe(5000)
    expect(t.state.alerts).toHaveLength(0)
  })

  it('records what the payout settled (settled_commission_cents) alongside the amount sent', async () => {
    t = setupPayout()
    await t.mod.adminRecordPayout(t.c())
    expect(t.state.payoutInserts[0].settled_commission_cents).toBe(1200)
  })

  it('400s AMOUNT_DIFFERS when the amount differs from the settled commission without acknowledgement + note', async () => {
    t = setupPayout()
    let res = await t.mod.adminRecordPayout(t.c({ body: { amountCents: 1000 } }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('AMOUNT_DIFFERS')
    res = await t.mod.adminRecordPayout(t.c({ body: { amountCents: 1000, acknowledgeDifference: true } }))   // no note
    expect(res.status).toBe(400)
    expect(t.state.payoutInserts).toHaveLength(0)   // nothing recorded, nothing settled
  })

  it('allows a different amount once acknowledged with a note, keeping both figures on the payout', async () => {
    t = setupPayout()
    const res = await t.mod.adminRecordPayout(t.c({ body: { amountCents: 1000, acknowledgeDifference: true, note: 'bank fee' } }))
    expect(res.body.success).toBe(true)
    expect(t.state.payoutInserts[0]).toMatchObject({ amount_cents: 1000, settled_commission_cents: 1200, note: 'bank fee' })
  })

  it('with COMMISSION_HOLD_DAYS set, only settles reversals and rows older than the hold window', async () => {
    t = setupPayout()
    const call = t.c()
    call.env.COMMISSION_HOLD_DAYS = '14'
    await t.mod.adminRecordPayout(call)
    const ledgerSelect = t.db.calls.find(q => q.table === 'commission_ledger' && q.op === 'select')
    expect(ledgerSelect.or).toHaveLength(1)
    expect(ledgerSelect.or[0]).toMatch(/^reverses_ledger_id\.not\.is\.null,created_at\.lte\./)
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
    // Round 6: an explicit currency must now MATCH the commission being settled, so the rows are NGN too.
    t = setupPayout({ unpaidLedger: [{ id: 'l1', commission_amount_cents: 500, currency: 'NGN' }, { id: 'l2', commission_amount_cents: 700, currency: 'NGN' }] })
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
    const c = { env: {}, req: { query: () => 'tok123' }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
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

  // AUDIT FIX (Section 3/4 re-audit, feature gap + minor data-exposure bug):
  // this data used to be shipped as a raw commissionLedgerRowToCamel pass-
  // through under `commissionLedger` — fetched every time, never rendered by
  // PartnerDashboard.jsx, and carrying paymentId/partnerId internal ids with
  // no partner-facing purpose. It's now `conversions`: the same rows, but
  // trimmed to partner-relevant fields, with referral_code_id resolved to
  // the actual code string (useful for a partner running more than one
  // code) instead of exposed as a bare id.
  it('returns conversions (not just aggregated stats) for the frontend to render, with internal ids trimmed', async () => {
    const { mod, restore, c } = setupDashboard({
      name: 'Coach K', commission_rate: 0.2,
      referral_codes: [{ id: 'rc1', code: 'COACHK10', clicks: 5 }],
      commission_ledger: [{ id: 'l1', payment_id: 'p1', partner_id: 'pt1', referral_code_id: 'rc1',
        gross_amount_cents: 2900, commission_rate: 0.2, commission_amount_cents: 580, payout_id: null, created_at: '2026-09-01T00:00:00Z' }],
      payouts: [],
    })
    const r = await mod.getPartnerDashboard(c)
    expect(r.body.data.commissionLedger).toBeUndefined()
    expect(r.body.data.conversions).toHaveLength(1)
    expect(r.body.data.conversions[0]).toMatchObject({
      id: 'l1', code: 'COACHK10', grossAmountCents: 2900, commissionAmountCents: 580, paid: false, isReversal: false
    })
    expect(r.body.data.conversions[0].paymentId).toBeUndefined()
    expect(r.body.data.conversions[0].partnerId).toBeUndefined()
    expect(r.body.data.conversions[0].referralCodeId).toBeUndefined()
    restore()
  })

  it('conversions: a reversal row resolves its own code, is marked isReversal, and carries the reason', async () => {
    const { mod, restore, c } = setupDashboard({
      name: 'Coach K', commission_rate: 0.2,
      referral_codes: [{ id: 'rc1', code: 'COACHK10', clicks: 5 }],
      commission_ledger: [
        { id: 'l1', referral_code_id: 'rc1', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null, created_at: '2026-09-01T00:00:00Z' },
        { id: 'l2', referral_code_id: 'rc1', reverses_ledger_id: 'l1', reversal_reason: 'refunded', gross_amount_cents: -2900, commission_amount_cents: -580, payout_id: null, created_at: '2026-09-02T00:00:00Z' },
      ],
      payouts: [],
    })
    const r = await mod.getPartnerDashboard(c)
    expect(r.body.data.conversions[1]).toMatchObject({ code: 'COACHK10', isReversal: true, reversalReason: 'refunded', commissionAmountCents: -580 })
    restore()
  })

  it('conversions: paid reflects whether a payout_id is set', async () => {
    const { mod, restore, c } = setupDashboard({
      name: 'Coach K', commission_rate: 0.2,
      referral_codes: [],
      commission_ledger: [{ id: 'l1', referral_code_id: null, gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: 'payout1', created_at: '2026-09-01T00:00:00Z' }],
      payouts: [],
    })
    const r = await mod.getPartnerDashboard(c)
    expect(r.body.data.conversions[0]).toMatchObject({ code: null, paid: true })
    restore()
  })

  // Not yet covered elsewhere: the AUDIT FIX (bug) above this file's
  // buildCyclesSummary/totalConversions — a refund is a second ledger row
  // (reverses_ledger_id set), which must net out of "how many sales" rather
  // than counting as a second conversion.
  it('totalConversions is NET of refunds: a sale and its reversal row count as zero conversions', async () => {
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
    expect(r.body.data.stats.totalConversions).toBe(0)
    restore()
  })

  it('totalConversions counts an un-refunded original as 1 even when another sale was refunded', async () => {
    const { mod, restore, c } = setupDashboard({
      name: 'Coach K', commission_rate: 0.2, referral_codes: [],
      commission_ledger: [
        { id: 'l1', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null, created_at: '2026-09-01T00:00:00Z' },
        { id: 'l2', reverses_ledger_id: 'l1', gross_amount_cents: -2900, commission_amount_cents: -580, payout_id: null, created_at: '2026-09-02T00:00:00Z' },
        { id: 'l3', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null, created_at: '2026-09-03T00:00:00Z' },
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
    const c = { env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { json: async () => opts.body ?? { name: 'Coach K', email: 'k@x.co' } }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
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

  // Section 10 audit: partners.email had no uniqueness check anywhere.
  it('rejects an email already used by another partner (case-insensitive) without inserting', async () => {
    const state = { inserted: null }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select' && q.filters.some(f => f[0] === 'ilike' && f[1] === 'email'))
        return { data: [{ id: 'p-existing' }], error: null }
      if (q.table === 'partners' && q.op === 'insert') { state.inserted = q.values; return { data: { id: 'p1', ...q.values }, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPartnerPayoutDetailsRequest: async () => {} },
      'lib/crypto.js': { randomToken: () => 'tok-fixed' },
    })
    const c = { env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { json: async () => ({ name: 'Coach K2', email: 'K@X.CO' }) }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.adminCreatePartner(c)
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(state.inserted).toBeNull()
    restore()
  })

  // Section 3/4 audit (bug): ilike treats `_`/`%` as wildcards. The duplicate
  // check is an EXACT case-insensitive match, so those must be escaped —
  // otherwise john.smith@x.co "collides" with an existing john_smith@x.co.
  it('escapes LIKE wildcards in the duplicate-email check so john_smith does not match john.smith', async () => {
    const seen = []
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') {
        seen.push(q.filters.find(f => f[0] === 'ilike' && f[1] === 'email')[2])
        return { data: [], error: null }
      }
      if (q.table === 'partners' && q.op === 'insert') return { data: { id: 'p1', ...q.values }, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPartnerPayoutDetailsRequest: async () => {} },
      'lib/crypto.js': { randomToken: () => 'tok-fixed' },
    })
    const c = { env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { json: async () => ({ name: 'Coach', email: 'john_smith@x.co' }) }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
    await mod.adminCreatePartner(c)
    expect(seen[0]).toBe('john\\_smith@x.co')
    restore()
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
        sendPartnerLinkRegenerated: async (...a) => state.notifications.push({ type: 'linkRotated', to: a[2], url: a[4] }),
        sendPartnerRateChanged:     async (...a) => state.notifications.push({ type: 'rateChanged', to: a[2], from: a[4], toRate: a[5] }),
      },
    })
    const c = (over = {}) => ({ env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { param: () => 'p1', json: async () => over.body ?? {} }, header: () => {}, json: (body, status = 200) => ({ body, status }) })
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

  it('rotates the payout token when the email changes and sends the fresh link to the NEW address only', async () => {
    t = setupUpdate({ before: { email: 'old@x.co' }, updated: { id: 'p1', email: 'new@x.co', name: 'X' } })
    await t.mod.adminUpdatePartner(t.c({ body: { email: 'new@x.co' } }))
    expect(typeof t.state.patch.payout_details_token).toBe('string')
    expect(t.state.patch.payout_details_token.length).toBeGreaterThan(20)
    const rot = t.state.notifications.filter(n => n.type === 'linkRotated')
    expect(rot).toHaveLength(1)
    expect(rot[0].to).toBe('new@x.co')
    expect(rot[0].url).toBe(`https://passthrough.dev/partner/payout-details?token=${t.state.patch.payout_details_token}`)
  })

  it('does NOT rotate the token for a casing-only, missing, or unchanged email', async () => {
    t = setupUpdate({ before: { email: 'same@x.co' }, updated: { id: 'p1', email: 'same@x.co', name: 'X' } })
    await t.mod.adminUpdatePartner(t.c({ body: { email: 'same@x.co', status: 'ACTIVE' } }))
    expect(t.state.patch.payout_details_token).toBeUndefined()
  })

  it('emails the partner when the commission rate actually changes (and not when it is re-sent unchanged)', async () => {
    t = setupUpdate({ before: { email: 'a@x.co', commission_rate: '0.1250' }, updated: { id: 'p1', email: 'a@x.co', name: 'X', commission_rate: '0.2000' } })
    await t.mod.adminUpdatePartner(t.c({ body: { commissionRate: 0.2 } }))
    expect(t.state.notifications.filter(n => n.type === 'rateChanged')).toHaveLength(1)
    t.restore()

    t = setupUpdate({ before: { email: 'a@x.co', commission_rate: '0.1250' }, updated: { id: 'p1', email: 'a@x.co', name: 'X', commission_rate: '0.1250' } })
    await t.mod.adminUpdatePartner(t.c({ body: { commissionRate: 0.125 } }))
    expect(t.state.notifications.filter(n => n.type === 'rateChanged')).toHaveLength(0)
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
    const res = await mod.adminUpdatePartner({ env: {}, req: { param: () => 'p1', json: async () => ({ status: 'PAUSED' }) }, header: () => {}, json: (body, status = 200) => ({ body, status }) })
    expect(res.body.success).toBe(true)
    restore()
  })

  it('rejects a commissionRate outside 0-1', async () => {
    t = setupUpdate()
    await expect(t.mod.adminUpdatePartner(t.c({ body: { commissionRate: 1.5 } }))).rejects.toThrow()
  })

  // Section 10 audit: same uniqueness gap on the update path.
  it('rejects reassigning a partner to another partner\'s email (case-insensitive) without updating', async () => {
    const state = { updateCalled: false }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select' && q.filters.some(f => f[0] === 'ilike' && f[1] === 'email'))
        return { data: [{ id: 'p-other' }], error: null }
      if (q.table === 'partners' && q.op === 'select') return { data: { email: 'old@x.co' }, error: null }
      if (q.table === 'partners' && q.op === 'update') { state.updateCalled = true; return { data: { id: 'p1', email: 'taken@x.co' }, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPartnerEmailChanged: async () => {}, sendOwnerAlert: async () => {} },
    })
    const c = { env: {}, req: { param: () => 'p1', json: async () => ({ email: 'TAKEN@X.CO' }) }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.adminUpdatePartner(c)
    expect(res.status).toBe(400)
    expect(state.updateCalled).toBe(false)
    restore()
  })

  it('skips the duplicate check entirely when only the casing of the current address differs', async () => {
    const calls = []
    const db = createFakeSupabase(q => {
      calls.push(q)
      if (q.table === 'partners' && q.op === 'select') return { data: { email: 'old@x.co' }, error: null }
      if (q.table === 'partners' && q.op === 'update') return { data: { id: 'p1', email: 'OLD@X.CO' }, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPartnerEmailChanged: async () => {}, sendOwnerAlert: async () => {} },
    })
    const c = { env: {}, req: { param: () => 'p1', json: async () => ({ email: 'OLD@X.CO' }) }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.adminUpdatePartner(c)
    expect(res.body.success).toBe(true)
    expect(calls.some(q => q.filters.some(f => f[0] === 'ilike'))).toBe(false)
    restore()
  })
})

describe('adminListPartners', () => {
  function setupList(rows) {
    // Round 4: the list reads partners and the UNPAID ledger in two queries (it used to embed
    // every partner's whole ledger), so the fixtures' per-partner commission_ledger arrays
    // are served from the commission_ledger table, unpaid rows only — as the real query does.
    const ledger = rows.flatMap(r => (r.commission_ledger || []).filter(l => !l.payout_id).map(l => ({ partner_id: r.id, ...l })))
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: rows.map(({ commission_ledger, ...r }) => r), error: null }
      if (q.table === 'commission_ledger') return { data: ledger, error: null }
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: {}, header: () => {}, json: (body, status = 200) => ({ body, status }) }
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

  it('with COMMISSION_HOLD_DAYS, a young prior-cycle row is held (not ready to pay); reversals are never held', async () => {
    const old = new Date(); old.setUTCMonth(old.getUTCMonth() - 2)
    const young = new Date(Date.now() - 2 * 86400_000)
    t = setupList([{
      id: 'p1', name: 'K', email: 'k@x.co', status: 'ACTIVE', commission_rate: '0.2500', payouts: [], referral_codes: [],
      commission_ledger: [
        { id: 'l1', partner_id: 'p1', gross_amount_cents: 1, commission_amount_cents: 500, payout_id: null, reverses_ledger_id: null, created_at: old.toISOString() },
        { id: 'l2', partner_id: 'p1', gross_amount_cents: 1, commission_amount_cents: 300, payout_id: null, reverses_ledger_id: null, created_at: young.toISOString() },
        { id: 'l3', partner_id: 'p1', gross_amount_cents: 1, commission_amount_cents: -100, payout_id: null, reverses_ledger_id: 'l0', created_at: young.toISOString() },
      ],
    }])
    t.c.env.COMMISSION_HOLD_DAYS = '7'
    const p = (await t.mod.adminListPartners(t.c)).body.data[0]
    expect(p.heldCents).toBe(300)
    // l1 (old) is always payable; l2 is held; the reversal l3 (never held) counts only if 2 days ago fell in a
    // prior cycle — so 400 or 500 depending on today's date, but never 800 (l2 must not leak in).
    expect([400, 500]).toContain(p.readyToPayCents)
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
    const res2 = await kes.mod.adminListPartners({ env: { PAYSTACK_CURRENCY: 'KES' }, req: {}, header: () => {}, json: (body, status = 200) => ({ body, status }) })
    expect(res2.body.data[0].currency).toBe('KES')
    kes.restore()
  })
})

describe('adminGetPartner', () => {
  function setupGet(row) {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: row, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: { param: () => 'p1' }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
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
    const res2 = await kes.mod.adminGetPartner({ env: { PAYSTACK_CURRENCY: 'KES' }, req: { param: () => 'p1' }, header: () => {}, json: (body, status = 200) => ({ body, status }) })
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
    const c = { env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { param: () => 'p1', json: async () => opts.body ?? { code: 'coach20', tierPrices: { FIX: 1900 } } }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
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

  it('rejects codes containing characters that break ?ref= links, and a past expiry', async () => {
    for (const bad of ['A&B', 'has space', 'x#y', '50%off', 'a+b', 'a']) {
      t = setupCreateCode({ partner: { name: 'K', email: 'k@x.co' }, body: { code: bad, tierPrices: { FIX: 1900 } } })
      await expect(t.mod.adminCreateReferralCode(t.c)).rejects.toThrow()
      expect(t.state.inserted).toBeNull()
      t.restore()
    }
    t = setupCreateCode({ partner: { name: 'K', email: 'k@x.co' },
      body: { code: 'OK20', tierPrices: { FIX: 1900 }, expiresAt: new Date(Date.now() - 86400_000).toISOString() } })
    await expect(t.mod.adminCreateReferralCode(t.c)).rejects.toThrow()
    expect(t.state.inserted).toBeNull()
  })

  it('accepts hyphen/underscore codes', async () => {
    t = setupCreateCode({ partner: { name: 'K', email: 'k@x.co', payout_details_token: 'tok' }, body: { code: 'coach_20-x', tierPrices: { FIX: 1900 } } })
    await t.mod.adminCreateReferralCode(t.c)
    expect(t.state.inserted.code).toBe('COACH_20-X')
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
    const c = { env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { param: () => 'p1', json: async () => ({ code: 'coach20', tierPrices: { FIX: 1900 } }) }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
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
    const c = (over = {}) => ({ env: {}, req: { param: () => 'rc1', json: async () => over.body ?? {} }, header: () => {}, json: (body, status = 200) => ({ body, status }) })
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
    const c = { env: {}, req: { query: () => opts.token }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
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
    const state = { patch: null, notified: [], alerts: [], updates: 0 }
    const db = createFakeSupabase(q => {
      // Round 6: the handler reads what it is replacing (for the owner alert) before it writes.
      if (q.table === 'partners' && q.op === 'select')
        return { data: opts.previous === undefined ? { payout_method: null, payout_details: null } : opts.previous, error: null }
      if (q.table === 'partners' && q.op === 'update')
        return (state.updates++, state.patch = q.patch, { data: opts.updated ?? null, error: null })
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendPayoutDetailsChanged: async () => state.notified.push('partner'),
        sendOwnerAlert:           async (...args) => { state.alerts.push(args); state.notified.push('owner') },
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
    const c = (over = {}) => ({ env: {}, req: { query: () => 'token' in over ? over.token : 'tok123', json: async () => over.body ?? {} }, header: () => {}, json: (body, status = 200) => ({ body, status }) })
    return { mod, restore, state, c }
  }

  it('400s with no token', async () => {
    t = setupSubmit()
    const res = await t.mod.submitPayoutDetails(t.c({ token: undefined }))
    expect(res.status).toBe(400)
  })

  it('rejects whitespace-only fields and trims what it stores', async () => {
    t = setupSubmit({ updated: { name: 'K', email: 'k@x.co' } })
    await expect(t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: '   ', accountName: 'K', accountNumber: '12345678' } }))).rejects.toThrow()
    await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: ' Equity ', accountName: ' K ', accountNumber: ' 12345678 ' } }))
    expect(t.state.patch.payout_details).toEqual({ bankName: 'Equity', accountName: 'K', accountNumber: '12345678' })
  })

  it('rejects a body missing required BANK fields', async () => {
    t = setupSubmit()
    await expect(t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK' } }))).rejects.toThrow()
  })

  it('accepts BANK details and stores them under payout_details', async () => {
    t = setupSubmit({ updated: { name: 'Coach K', email: 'k@x.co' } })
    await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: 'X', accountName: 'Coach K', accountNumber: '12345678' } }))
    expect(t.state.patch.payout_method).toBe('BANK')
    expect(t.state.patch.payout_details).toEqual({ bankName: 'X', accountName: 'Coach K', accountNumber: '12345678' })
  })

  it('accepts MOBILE_MONEY details', async () => {
    t = setupSubmit({ updated: { name: 'Coach K', email: 'k@x.co' } })
    await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'MOBILE_MONEY', provider: 'M-Pesa', accountName: 'Coach K', phoneNumber: '0700123456' } }))
    expect(t.state.patch.payout_method).toBe('MOBILE_MONEY')
  })

  it('404s for an unknown/expired token', async () => {
    t = setupSubmit({ updated: null })
    const res = await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: 'X', accountName: 'Y', accountNumber: '12345678' } }))
    expect(res.status).toBe(404)
  })

  it('notifies both the partner and the owner on a successful change', async () => {
    t = setupSubmit({ updated: { name: 'Coach K', email: 'k@x.co' } })
    await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: 'X', accountName: 'Y', accountNumber: '12345678' } }))
    expect(t.state.notified.sort()).toEqual(['owner', 'partner'])
  })
  // Round 6
  it('404s for an unknown token WITHOUT attempting the update', async () => {
    t = setupSubmit({ previous: null })
    const res = await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'BANK', bankName: 'X', accountName: 'Y', accountNumber: '12345678' } }))
    expect(res.status).toBe(404)
    expect(t.state.updates).toBe(0)
  })

  it('the owner alert says what changed (method + last 4, old -> new) and never carries a full number', async () => {
    t = setupSubmit({
      previous: { payout_method: 'BANK', payout_details: { bankName: 'Old', accountName: 'K', accountNumber: '1111222233334444' } },
      updated: { name: 'Coach K', email: 'k@x.co' }
    })
    await t.mod.submitPayoutDetails(t.c({ body: { payoutMethod: 'MOBILE_MONEY', provider: 'M-Pesa', accountName: 'K', phoneNumber: '+254 700 123 456' } }))
    const [, subject, body] = t.state.alerts[0]
    expect(subject).toBe('Partner payout details changed')
    expect(body).toContain('before: BANK ...4444')
    expect(body).toContain('after:  MOBILE_MONEY ...3456')
    expect(body).not.toContain('1111222233334444')
    expect(body).not.toContain('700 123')
  })

  it('two changes with the same token each raise their own alert (distinct dedupe keys)', async () => {
    t = setupSubmit({ updated: { name: 'Coach K', email: 'k@x.co' } })
    const body = { payoutMethod: 'BANK', bankName: 'X', accountName: 'Y', accountNumber: '12345678' }
    await t.mod.submitPayoutDetails(t.c({ body }))
    await new Promise(r => setTimeout(r, 5))
    await t.mod.submitPayoutDetails(t.c({ body: { ...body, accountNumber: '87654321' } }))
    const keys = t.state.alerts.map(a => a[3].dedupeKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })
})

describe('trackClick', () => {
  function setupTrack() {
    const state = { rpcCalls: [] }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') { state.rpcCalls.push(q); return { data: null, error: null } }
      // Round 6: trackClick now looks the code up first (to report `valid`); this fixture's code is a real, usable one.
      if (q.table === 'referral_codes') return { data: { id: 'c1', code: 'COACH20', active: true, expires_at: null, usage_limit: null, uses_so_far: 0, partners: { status: 'ACTIVE' } }, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = (over = {}) => ({ env: {}, req: { json: async () => over.body ?? {}, header: () => 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' }, header: () => {}, json: (body, status = 200) => ({ body, status }) })
    return { mod, restore, state, c }
  }

  it('normalizes the code (trim + uppercase) before the RPC call', async () => {
    t = setupTrack()
    await t.mod.trackClick(t.c({ body: { code: '  coach20 ' } }))
    expect(t.state.rpcCalls[0].name).toBe('increment_referral_code_clicks')
    expect(t.state.rpcCalls[0].args).toEqual({ p_code: 'COACH20' })
  })

  it('an absurdly long code is a silent no-op (never reaches the RPC)', async () => {
    t = setupTrack()
    const res = await t.mod.trackClick(t.c({ body: { code: 'A'.repeat(51) } }))
    expect(res.body.success).toBe(true)
    expect(res.body.valid).toBe(false)   // round 7: say it is not a code, so the browser drops it
    expect(t.state.rpcCalls).toHaveLength(0)
  })

  it('a blank code is a silent no-op — still 200, no RPC call', async () => {
    t = setupTrack()
    const res = await t.mod.trackClick(t.c({ body: { code: '   ' } }))
    expect(res.body.success).toBe(true)
    expect(t.state.rpcCalls).toHaveLength(0)
  })

  it('crawlers / link-preview fetchers / UA-less scripts are not counted as clicks', async () => {
    t = setupTrack()
    const mk = ua => ({ env: {}, req: { json: async () => ({ code: 'COACH20' }), header: () => ua }, header: () => {}, json: (body, status = 200) => ({ body, status }) })
    for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'facebookexternalhit/1.1', 'curl/8.4.0', 'python-requests/2.31', '', undefined]) {
      const res = await t.mod.trackClick(mk(ua))
      expect(res.body.success).toBe(true)
    }
    expect(t.state.rpcCalls).toHaveLength(0)
    t.restore()
  })

  it('a malformed JSON body never throws (caught and treated as empty)', async () => {
    const state = { rpcCalls: [] }
    const db = createFakeSupabase(q => { if (q.op === 'rpc') state.rpcCalls.push(q) })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: { json: async () => { throw new Error('bad json') } }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.trackClick(c)
    expect(res.body.success).toBe(true)
    restore()
  })

  it('an RPC error is logged, not thrown — the frontend never has to handle a failure here', async () => {
    const db = createFakeSupabase(q => (q.op === 'rpc' ? { data: null, error: new Error('rpc down') } : undefined))
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, req: { json: async () => ({ code: 'ABC' }), header: () => 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' }, header: () => {}, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.trackClick(c)
    expect(res.body.success).toBe(true)
    restore()
  })
})

// SECTION 12 AUDIT (feature gap): status/email changes already sent an owner
// alert EMAIL, but recording a payout and rotating a payout link — both real
// money/security actions — left no record at all of which admin did them, and
// even the emailed changes weren't queryable. All four admin mutations now
// also write to admin_audit_log. The log carries ids, amounts and status
// values only — never an email address or any payout/bank details.
describe('partner admin actions — audit trail', () => {
  function setupAudit(opts = {}) {
    const audits = []
    const partner = 'partner' in opts ? opts.partner : { id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', payout_method: 'BANK', payout_details: { bankName: 'SecretBank', accountNumber: '0123456789' } }
    const unpaid = [{ id: 'l1', commission_amount_cents: 500 }, { id: 'l2', commission_amount_cents: 700 }]
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: partner, error: null }
      if (q.table === 'partners' && q.op === 'update') return { data: opts.updated ?? partner, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: unpaid, error: null }
      if (q.table === 'commission_ledger' && q.op === 'update') return { data: unpaid, error: null }
      if (q.table === 'payouts' && q.op === 'insert') return { data: { id: 'payout1', ...q.values }, error: null }
      if (q.table === 'admin_audit_log' && q.op === 'insert') { audits.push(q.values); return { data: null, error: opts.auditError ?? null } }
      return undefined
    })
    const ok = async () => true
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendPartnerEmailChanged: ok, sendPartnerStatusChanged: ok, sendOwnerAlert: ok,
        sendPartnerLinkRegenerated: ok, sendPayoutSent: ok,
      },
    })
    const c = (over = {}) => ({
      env: { FRONTEND_URL: 'https://passthrough.dev' },
      get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
      req: { param: () => 'p1', json: async () => over.body ?? {} },
      header: () => {}, json: (body, status = 200) => ({ body, status }),
    })
    return { mod, restore, audits, c }
  }

  it('a status change logs from/to — and never the partner email', async () => {
    t = setupAudit({ updated: { id: 'p1', email: 'k@x.co', name: 'Coach K', status: 'PAUSED' } })
    await t.mod.adminUpdatePartner(t.c({ body: { status: 'PAUSED' } }))
    expect(t.audits).toEqual([{
      actor_id: 'admin-1', action: 'partner.update', target_type: 'partner', target_id: 'p1',
      detail: { emailChanged: false, statusFrom: 'ACTIVE', statusTo: 'PAUSED' },
    }])
    expect(JSON.stringify(t.audits)).not.toContain('k@x.co')
  })
  it('an email change logs emailChanged:true but neither address', async () => {
    t = setupAudit({ updated: { id: 'p1', email: 'new@x.co', name: 'Coach K', status: 'ACTIVE' } })
    await t.mod.adminUpdatePartner(t.c({ body: { email: 'new@x.co' } }))
    expect(t.audits).toHaveLength(1)
    expect(t.audits[0].detail).toEqual({ emailChanged: true, payoutLinkRotated: true })
    const raw = JSON.stringify(t.audits)
    expect(raw).not.toContain('new@x.co'); expect(raw).not.toContain('k@x.co')
  })
  it('logs nothing when status/email are unchanged, or only harmless fields (name/rate) changed', async () => {
    t = setupAudit({ updated: { id: 'p1', email: 'k@x.co', name: 'Coach K', status: 'ACTIVE' } })
    await t.mod.adminUpdatePartner(t.c({ body: { status: 'ACTIVE', commissionRate: 0.3, name: 'Coach K' } }))
    expect(t.audits).toHaveLength(0)
  })
  it('regenerating a payout link logs payout_link_regenerated (and never the token/url)', async () => {
    t = setupAudit()
    const res = await t.mod.adminRegeneratePayoutLink(t.c())
    expect(res.body.success).toBe(true)
    expect(t.audits).toEqual([{
      actor_id: 'admin-1', action: 'partner.payout_link_regenerated', target_type: 'partner', target_id: 'p1',
      detail: { emailed: true, scope: 'payout' },
    }])
    expect(JSON.stringify(t.audits)).not.toContain('token=')
  })
  it('regenerating for a partner that does not exist (404) logs nothing', async () => {
    t = setupAudit({ partner: null })
    const res = await t.mod.adminRegeneratePayoutLink(t.c())
    expect(res.status).toBe(404)
    expect(t.audits).toHaveLength(0)
  })
  it('recording a payout logs partner.payout_recorded with amount/currency — and no bank details', async () => {
    t = setupAudit()
    const res = await t.mod.adminRecordPayout(t.c())
    expect(res.body.success).toBe(true)
    expect(t.audits).toHaveLength(1)
    expect(t.audits[0]).toMatchObject({
      actor_id: 'admin-1', action: 'partner.payout_recorded', target_type: 'payout', target_id: 'payout1',
      detail: { partnerId: 'p1', amountCents: 1200, racedWithConcurrentPayout: false, ledgerSettlementFailed: false },
    })
    expect(typeof t.audits[0].detail.currency).toBe('string')
    const raw = JSON.stringify(t.audits)
    expect(raw).not.toContain('SecretBank'); expect(raw).not.toContain('0123456789')
  })
  it('a failed audit write never fails the payout that already happened', async () => {
    const realErr = console.error; console.error = () => {}
    try {
      t = setupAudit({ auditError: { message: 'audit down' } })
      const res = await t.mod.adminRecordPayout(t.c())
      expect(res.body.success).toBe(true)
    } finally { console.error = realErr }
  })
})
