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
