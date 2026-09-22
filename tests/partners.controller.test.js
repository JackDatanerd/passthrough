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
})
