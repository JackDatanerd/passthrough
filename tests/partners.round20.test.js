import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 20: partner notice on code changes, reopening a rejected application, the cross-partner ledger, tax details,
// ENDED membership, held-until dates, one-call signup counts, and the bounded channel-tag read.

let t
afterEach(() => t?.restore())

const TOKEN = 'tok_payout_123'
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD', ...(over.env || {}) },
  get: () => ({ id: 'admin-1' }),
  req: {
    param: n => (over.params ? over.params[n] : 'p1'),
    query: n => (over.query ? over.query[n] : undefined),
    json: async () => over.body ?? {},
    header: n => (String(n).toLowerCase() === 'x-partner-token' ? over.token : undefined),
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

function load(resolver = () => undefined, email = {}) {
  const db = createFakeSupabase(resolver)
  const sent = []
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert: async () => true,
      sendPartnerCodeChanged: async (...a) => { sent.push(['codeChanged', ...a]); return true },
      sendPartnerStatusChanged: async (...a) => { sent.push(['status', ...a]); return true },
      sendPayoutDetailsChanged: async () => true,
      ...email,
    },
  })
  return { ...m, db, sent }
}

const CODE_BEFORE = { partner_id: 'p1', code: 'ANN10', active: true, tier_prices: { FIX: 3900 }, usage_limit: null, expires_at: null, partners: { name: 'Ann', email: 'ann@x.co', status: 'ACTIVE' } }

describe('partner is told when an admin changes a code (gap 1)', () => {
  const run = async (body, owner = CODE_BEFORE, after = {}) => {
    t = load(q => {
      if (q.table === 'referral_codes' && q.op === 'select' && q.maybe && !q.returning) return undefined
      if (q.table === 'referral_codes' && q.op === 'select') return { data: owner, error: null }
      if (q.table === 'referral_codes' && q.op === 'update') return { data: { id: 'c1', partner_id: 'p1', code: 'ANN10', active: owner.active, tier_prices: owner.tier_prices, usage_limit: owner.usage_limit, expires_at: owner.expires_at, ...after }, error: null }
      return undefined
    })
    const out = await t.mod.adminUpdateReferralCode(ctxOf({ body, params: { codeId: 'c1' } }))
    return out
  }
  it('switching a code off emails the partner exactly what changed', async () => {
    const out = await run({ active: false }, CODE_BEFORE, { active: false })
    expect(t.sent).toHaveLength(1)
    const [kind, , , email, name, code, changes, currency] = t.sent[0]
    expect([kind, email, name, code, currency]).toEqual(['codeChanged', 'ann@x.co', 'Ann', 'ANN10', 'USD'])
    expect(changes).toEqual([{ field: 'active', to: false }])
    expect(out.body.notified).toBe(true)
  })
  it('re-saving the same value says nothing', async () => {
    await run({ active: true }, CODE_BEFORE, { active: true })
    expect(t.sent).toHaveLength(0)
  })
  it('a price + limit + expiry edit reports each real change', async () => {
    await run({ tierPrices: { FIX: 2900 }, usageLimit: 5, expiresAt: '2099-01-01T23:59:59.999Z' }, CODE_BEFORE,
      { tier_prices: { FIX: 2900 }, usage_limit: 5, expires_at: '2099-01-01T23:59:59.999Z' })
    expect(t.sent[0][6].map(c => c.field)).toEqual(['tierPrices', 'usageLimit', 'expiresAt'])
  })
  it('a paused partner is not emailed (their codes do nothing anyway)', async () => {
    await run({ active: false }, { ...CODE_BEFORE, partners: { ...CODE_BEFORE.partners, status: 'PAUSED' } }, { active: false })
    expect(t.sent).toHaveLength(0)
  })
  it('an ended partner is not emailed either', async () => {
    await run({ active: false }, { ...CODE_BEFORE, partners: { ...CODE_BEFORE.partners, status: 'ENDED' } }, { active: false })
    expect(t.sent).toHaveLength(0)
  })
  it('an erased partner is never emailed', async () => {
    await run({ active: false }, { ...CODE_BEFORE, partners: { name: 'Removed partner', email: 'partner-x@removed.invalid', status: 'PAUSED' } }, { active: false })
    expect(t.sent).toHaveLength(0)
  })
  it('a failing email never fails the save', async () => {
    t = load(q => {
      if (q.table === 'referral_codes' && q.op === 'select') return { data: CODE_BEFORE, error: null }
      if (q.table === 'referral_codes' && q.op === 'update') return { data: { id: 'c1', partner_id: 'p1', code: 'ANN10', active: false, tier_prices: { FIX: 3900 }, usage_limit: null, expires_at: null }, error: null }
    }, { sendPartnerCodeChanged: async () => { throw new Error('smtp down') } })
    const out = await t.mod.adminUpdateReferralCode(ctxOf({ body: { active: false }, params: { codeId: 'c1' } }))
    expect(out.body.success).toBe(true)
    expect(out.body.notified).toBe(false)
  })
})

describe('reopen a rejected application (gap 5)', () => {
  it('moves only a REJECTED row back to PENDING and clears the review fields', async () => {
    t = load(q => (q.table === 'partner_applications' ? { data: { id: 'a1', name: 'Ann' }, error: null } : undefined))
    const out = await t.mod.adminReopenApplication(ctxOf({ params: { id: 'a1' } }))
    expect(out.body.success).toBe(true)
    const up = t.db.calls.find(c => c.table === 'partner_applications' && c.op === 'update')
    expect(up.patch).toEqual({ status: 'PENDING', reviewed_at: null, review_note: null })
    expect(up.filters).toContainEqual(['eq', 'status', 'REJECTED'])
  })
  it('404 when it is not rejected (approved / pending / missing)', async () => {
    t = load(() => ({ data: null, error: null }))
    const out = await t.mod.adminReopenApplication(ctxOf({ params: { id: 'a1' } }))
    expect(out.status).toBe(404)
  })
  it('409 with a plain message when the applicant already has another pending application', async () => {
    t = load(() => ({ data: null, error: { code: '23505', message: 'dup' } }))
    const out = await t.mod.adminReopenApplication(ctxOf({ params: { id: 'a1' } }))
    expect(out.status).toBe(409)
    expect(out.body.message).toMatch(/another application/i)
  })
})

describe('cross-partner commission ledger (gap 4)', () => {
  const row = (over = {}) => ({
    id: 'l1', created_at: '2026-10-03T10:00:00Z', partner_id: 'p1', kind: 'SALE', reverses_ledger_id: null, reversal_reason: null, adjustment_reason: null,
    gross_amount_cents: 3900, commission_rate: '0.2', commission_amount_cents: 780, currency: 'USD', payout_id: null, attribution_sub: 'news',
    partners: { name: 'Ann', email: 'ann@x.co' }, referral_codes: { code: 'ANN10' }, payments: { paystack_ref: 'ref_1' }, payouts: null, ...over,
  })
  it('classifies sale / reversal / adjustment and reports paid state', async () => {
    t = load(q => (q.table === 'commission_ledger' ? { data: [
      row(),
      row({ id: 'l2', reverses_ledger_id: 'l1', reversal_reason: 'REFUND', commission_amount_cents: -780, payout_id: 'po1', payouts: { paid_at: '2026-10-16T00:00:00Z', voided_at: null } }),
      row({ id: 'l3', kind: 'ADJUSTMENT', adjustment_reason: 'Goodwill', referral_codes: null, payments: null, gross_amount_cents: 0 }),
    ], count: 3, error: null } : undefined))
    const out = await t.mod.adminListLedger(ctxOf())
    expect(out.body.total).toBe(3)
    expect(out.body.data.map(r => r.type)).toEqual(['SALE', 'REVERSAL', 'ADJUSTMENT'])
    expect(out.body.data[0]).toMatchObject({ partnerName: 'Ann', code: 'ANN10', paymentRef: 'ref_1', commissionRate: 0.2, paid: false, sub: 'news' })
    expect(out.body.data[1]).toMatchObject({ paid: true, paidAt: '2026-10-16T00:00:00Z', reason: 'REFUND' })
    expect(out.body.data[2]).toMatchObject({ reason: 'Goodwill', code: null, paymentRef: null })
  })
  it('a date-only "to" runs through the end of that day, newest first, partner filter only for a real uuid', async () => {
    t = load(q => (q.table === 'commission_ledger' ? { data: [], count: 0, error: null } : undefined))
    await t.mod.adminListLedger(ctxOf({ query: { from: '2026-10-01', to: '2026-10-31', partnerId: 'not-a-uuid' } }))
    const q = t.db.calls.find(c => c.table === 'commission_ledger')
    expect(q.filters).toContainEqual(['gte', 'created_at', '2026-10-01T00:00:00.000Z'])
    expect(q.filters).toContainEqual(['lte', 'created_at', '2026-10-31T23:59:59.999Z'])
    expect(q.filters.some(f => f[1] === 'partner_id')).toBe(false)
    expect(q.orders[0]).toEqual(['created_at', { ascending: false }])
  })
})

describe('tax details with the payout details (gap 7)', () => {
  const bank = { payoutMethod: 'BANK', bankName: 'Equity', accountName: 'Ann', accountNumber: '1234567890' }
  const PREV = { payout_method: 'BANK', payout_details: { bankName: 'Equity', accountName: 'Ann', accountNumber: '1234567890' } }
  it('a tax-only edit with identical payout details saves the tax, restarts no hold, sends no alert', async () => {
    const alerts = []
    t = load(q => (q.table === 'partners' && q.op === 'select' ? { data: PREV, error: null } : undefined), { sendOwnerAlert: async (...a) => { alerts.push(a) } })
    const out = await t.mod.submitPayoutDetails(ctxOf({ token: TOKEN, body: { ...bank, taxCountry: 'ke', taxId: 'A123456789B' } }))
    expect(out.body.unchanged).toBe(true)
    const up = t.db.calls.find(c => c.table === 'partners' && c.op === 'update')
    expect(up.patch).toEqual({ tax_country: 'KE', tax_id: 'A123456789B' })
    expect(alerts).toHaveLength(0)
  })
  it('identical details and no tax fields write nothing at all (also safe before the migration)', async () => {
    t = load(q => (q.table === 'partners' && q.op === 'select' ? { data: PREV, error: null } : undefined))
    await t.mod.submitPayoutDetails(ctxOf({ token: TOKEN, body: bank }))
    expect(t.db.calls.some(c => c.op === 'update')).toBe(false)
  })
  it('tax fields never enter payout_details (so they cannot trip the equality / hold logic)', async () => {
    t = load(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: PREV, error: null }
      if (q.table === 'partners' && q.op === 'update') return { data: { name: 'Ann', email: 'a@x.co' }, error: null }
    })
    await t.mod.submitPayoutDetails(ctxOf({ token: TOKEN, body: { ...bank, accountNumber: '9999999999', confirm: undefined, taxCountry: 'KE' } }))
    const up = t.db.calls.find(c => c.table === 'partners' && c.op === 'update')
    expect(up.patch.payout_details).toEqual({ bankName: 'Equity', accountName: 'Ann', accountNumber: '9999999999' })
    expect(up.patch.tax_country).toBe('KE')
    expect(up.patch.payout_details_submitted_at).toBeTruthy()
  })
  it('an empty string clears; a malformed country is refused', async () => {
    t = load(q => (q.table === 'partners' && q.op === 'select' ? { data: PREV, error: null } : undefined))
    await t.mod.submitPayoutDetails(ctxOf({ token: TOKEN, body: { ...bank, taxCountry: '', taxId: '' } }))
    expect(t.db.calls.find(c => c.op === 'update').patch).toEqual({ tax_country: null, tax_id: null })
    await expect(t.mod.submitPayoutDetails(ctxOf({ token: TOKEN, body: { ...bank, taxCountry: 'KEN' } }))).rejects.toThrow()
    await expect(t.mod.submitPayoutDetails(ctxOf({ token: TOKEN, body: { ...bank, taxId: 'ab' } }))).rejects.toThrow()
  })
  it('the owner view returns the country and only the last four of the tax id', async () => {
    t = load(q => (q.table === 'partners' ? { data: { name: 'Ann', ...PREV, payout_details_submitted_at: null, dashboard_token: 'd', tax_country: 'KE', tax_id: 'A123456789B' }, error: null } : undefined))
    const out = await t.mod.getPartnerByToken(ctxOf({ token: TOKEN }))
    expect(out.body.data.taxCountry).toBe('KE')
    expect(out.body.data.taxIdMasked).toBe('\u2026789B')
    expect(JSON.stringify(out.body)).not.toContain('A123456789B')
  })
})

describe('held-until on the cycle summary (gap 2)', () => {
  const now = Date.now()
  const iso = d => new Date(now - d * 86400000).toISOString()
  const row = (id, ageDays, over = {}) => ({ id, created_at: iso(ageDays), commission_amount_cents: 1000, gross_amount_cents: 5000, payout_id: null, reverses_ledger_id: null, kind: 'SALE', payments: { status: 'SUCCESS' }, ...over })
  it('reports when the age hold ends and how much sits on a disputed payment', async () => {
    t = load()
    const rows = [row('a', 2), row('b', 1), row('c', 0.5, { payments: { status: 'DISPUTED' } })]
    const cycles = t.mod.buildCyclesSummary(rows, 1, 7)
    const c = cycles[0]
    expect(c.heldCents).toBe(3000)
    expect(c.heldDisputeCents).toBe(1000)
    // the LAST age-held sale (1 day old) frees up 7 days after it was made
    expect(Date.parse(c.heldUntil)).toBe(Date.parse(iso(1)) + 7 * 86400000)
  })
  it('no hold -> no date, no dispute -> zero', async () => {
    t = load()
    const c = t.mod.buildCyclesSummary([row('a', 2)], 1, 0)[0]
    expect(c.heldUntil).toBeNull()
    expect(c.heldDisputeCents).toBe(0)
  })
})

describe('one-call signup counts + bounded channel read', () => {
  it('the dashboard reads channel tags most-visited first, with a limit', async () => {
    const PARTNER = { name: 'Ann', commission_rate: 0.2, status: 'ACTIVE', payout_method: null, payout_details: null, referral_codes: [{ id: 'c1', partner_id: 'p1', code: 'ANN10', clicks: 1, uses_so_far: 0, active: true, tier_prices: { FIX: 3900 } }], commission_ledger: [], payouts: [] }
    t = load(q => (q.table === 'partners' ? { data: PARTNER, error: null } : undefined))
    await t.mod.getPartnerDashboard(ctxOf({ token: TOKEN }))
    const q = t.db.calls.find(c => c.table === 'referral_sub_clicks')
    expect(q.orders[0]).toEqual(['clicks', { ascending: false }])
    expect(q.limit).toBe(500)
  })
})

describe('ENDED membership (gap 6)', () => {
  it('the partner update schema accepts ENDED and emails the ended notice', async () => {
    t = load(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { email: 'ann@x.co', status: 'ACTIVE', commission_rate: 0.2, previous_emails: [] }, error: null }
      if (q.table === 'partners' && q.op === 'update') return { data: { id: 'p1', name: 'Ann', email: 'ann@x.co', status: 'ENDED', commission_rate: 0.2 }, error: null }
    })
    const out = await t.mod.adminUpdatePartner(ctxOf({ body: { status: 'ENDED' } }))
    expect(out.body.success).toBe(true)
    expect(t.sent.find(s => s[0] === 'status')[5]).toBe('ENDED')
  })
  it('an unknown status is still refused', async () => {
    t = load()
    await expect(t.mod.adminUpdatePartner(ctxOf({ body: { status: 'GONE' } }))).rejects.toThrow()
  })
})
