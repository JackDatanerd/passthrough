import { describe, it, expect } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
const referral = require('../src/services/referral.service.js')

// Payments & Pricing round 4, B1: the public quote must apply the same capacity rule the checkout
// claim does (uses_so_far + LIVE reservations), or it promises a discount checkout then withholds.
const code = (over = {}) => ({
  id: 'rc1', code: 'LIMITED', active: true, usage_limit: 5, uses_so_far: 2, expires_at: null,
  tier_prices: { FIX: 1500, BADGE: 500, FIX_PLAIN: 900 }, partners: { status: 'ACTIVE' }, ...over,
})
function dbWith({ codeRow, live = 0, countError = null }) {
  return createFakeSupabase(q => {
    if (q.table === 'referral_codes') return { data: codeRow, error: null }
    if (q.table === 'referral_code_reservations') return { count: live, data: null, error: countError }
    return undefined
  })
}
const quote = db => referral.resolvePricesForTiers(db, ['FIX', 'BADGE', 'FIX_PLAIN'], {}, 'limited')

describe('resolvePricesForTiers — live reservations (B1)', () => {
  it('still discounts while uses + live reservations leave room', async () => {
    const r = await quote(dbWith({ codeRow: code(), live: 2 }))   // 2 + 2 < 5
    expect(r.FIX).toMatchObject({ amount: 1500, referralApplied: true })
  })

  it('does NOT quote a discount when completed uses + live reservations already fill the limit', async () => {
    const r = await quote(dbWith({ codeRow: code(), live: 3 }))   // 2 + 3 >= 5 — the claim would be denied
    for (const t of ['FIX', 'BADGE', 'FIX_PLAIN']) expect(r[t]).toMatchObject({ referralApplied: false, referralCode: null })
    expect(r.FIX.amount).toBeGreaterThan(1500)
  })

  it('only counts reservations younger than the claim\'s own TTL', async () => {
    const db = dbWith({ codeRow: code(), live: 0 })
    await quote(db)
    const q = db.calls.find(c => c.table === 'referral_code_reservations')
    expect(q.selectOpts).toMatchObject({ count: 'exact', head: true })
    const since = q.filters.find(f => f[0] === 'gt' && f[1] === 'created_at')[2]
    expect(Date.now() - Date.parse(since)).toBeGreaterThan(3590 * 1000)
    expect(Date.now() - Date.parse(since)).toBeLessThan(3610 * 1000)
  })

  it('an unlimited code never looks at reservations', async () => {
    const db = dbWith({ codeRow: code({ usage_limit: null }), live: 99 })
    const r = await quote(db)
    expect(r.FIX.referralApplied).toBe(true)
    expect(db.calls.some(c => c.table === 'referral_code_reservations')).toBe(false)
  })

  it('a failed reservation count fails OPEN — the discount is still quoted (checkout is the real gate)', async () => {
    const realErr = console.error; console.error = () => {}
    try {
      const r = await quote(dbWith({ codeRow: code(), live: 0, countError: { message: 'boom' } }))
      expect(r.FIX.referralApplied).toBe(true)
    } finally { console.error = realErr }
  })
})

// Payments & Pricing round 7 (B4): the BUYER'S OWN pending checkout holds a reservation on the code. It must
// not count against them — initializePayment resumes that checkout without a new claim, so quoting the full
// price while the resume still honours the discount contradicted itself.
describe('resolvePricesForTiers — own reservations (round 7)', () => {
  function dbOwn({ live, own }) {
    return createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: code({ usage_limit: 3, uses_so_far: 2 }), error: null }
      if (q.table === 'referral_code_reservations') return { count: live, data: null, error: null }
      if (q.table === 'payments') return { count: own, data: null, error: null }
      return undefined
    })
  }
  const q2 = (db, opts) => referral.resolvePricesForTiers(db, ['FIX'], {}, 'limited', opts)

  it('quotes the discount to a buyer whose OWN pending checkout holds the last slot', async () => {
    const r = await q2(dbOwn({ live: 1, own: 1 }), { buyerUserId: 'u1', buyerScanId: 's1' })   // 2 uses + 1 live (their own) = 3, limit 3
    expect(r.FIX).toMatchObject({ amount: 1500, referralApplied: true })
  })

  it('still withholds it when the held slot is someone else\'s (or the viewer is anonymous)', async () => {
    expect((await q2(dbOwn({ live: 1, own: 0 }), { buyerUserId: 'u1', buyerScanId: 's1' })).FIX.referralApplied).toBe(false)
    expect((await q2(dbOwn({ live: 1, own: 1 }), {})).FIX.referralApplied).toBe(false)   // no buyer id → nothing is netted off
  })

  it('looks only at this buyer\'s PENDING payments that hold a reservation on this code', async () => {
    const db = dbOwn({ live: 1, own: 1 })
    await q2(db, { buyerUserId: 'u1', buyerScanId: 's1' })
    const c = db.calls.find(x => x.table === 'payments')
    const f = c.filters.map(x => x.join(':'))
    expect(f).toEqual(expect.arrayContaining(['eq:user_id:u1', 'eq:scan_id:s1', 'eq:status:PENDING', 'eq:referral_code_id:rc1']))
  })
})

// Payments & Pricing round 9 (B2): a held slot only counts as the buyer's own for the SAME scan.
describe('resolvePricesForTiers — own reservations are scan-scoped (round 9)', () => {
  const db = () => createFakeSupabase(q => {
    if (q.table === 'referral_codes') return { data: code({ usage_limit: 3, uses_so_far: 2 }), error: null }
    if (q.table === 'referral_code_reservations') return { count: 1, data: null, error: null }
    if (q.table === 'payments') return { count: 0, data: null, error: null }   // none on the scan being bought
    return undefined
  })
  it('no scan given: nothing is netted off (a quote with no checkout in view is conservative)', async () => {
    const d = db()
    const r = await referral.resolvePricesForTiers(d, ['FIX'], {}, 'limited', { buyerUserId: 'u1' })
    expect(r.FIX.referralApplied).toBe(false)
    expect(d.calls.some(x => x.table === 'payments')).toBe(false)
  })
  it('a held slot on a DIFFERENT scan is not the buyer\'s own for this one', async () => {
    const r = await referral.resolvePricesForTiers(db(), ['FIX'], {}, 'limited', { buyerUserId: 'u1', buyerScanId: 's2' })
    expect(r.FIX.referralApplied).toBe(false)
  })
})
