import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

function setup(opts = {}) {
  const db = createFakeSupabase(q => {
    if (q.table === 'referral_codes') return { data: opts.codeRow ?? null, error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/pricing.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
  })
  const c = (over = {}) => ({
    env: opts.env ?? {},
    get: k => (k === 'user' ? opts.user : undefined),
    req: { query: k => (over.query ?? {})[k] },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, c, db }
}

let t
afterEach(() => t?.restore())

describe('getPricing', () => {
  it('defaults to USD when PAYSTACK_CURRENCY is unset', async () => {
    t = setup()
    const res = await t.mod.getPricing(t.c())
    expect(res.body.data.currency).toBe('USD')
  })

  // AUDIT FIX: this used to always return the hardcoded c.CURRENCY ('USD'),
  // while the actual charge (paystack.service.js, payments.controller.js's
  // insert) uses env.PAYSTACK_CURRENCY || c.CURRENCY. A deployment with
  // PAYSTACK_CURRENCY set would have quoted the wrong currency here.
  it('quotes env.PAYSTACK_CURRENCY when set', async () => {
    t = setup({ env: { PAYSTACK_CURRENCY: 'KES' } })
    const res = await t.mod.getPricing(t.c())
    expect(res.body.data.currency).toBe('KES')
  })

  it('still quotes env.PAYSTACK_CURRENCY when a referral code is present', async () => {
    t = setup({
      env: { PAYSTACK_CURRENCY: 'KES' },
      codeRow: { id: 'rc1', active: true, tier_prices: { FIX: 1900 }, partners: { status: 'ACTIVE' } },
    })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    expect(res.body.data.currency).toBe('KES')
    expect(res.body.data.referralApplied).toBe(true)
  })

  it('returns standard pricing for all three tiers with no referral code', async () => {
    t = setup()
    const res = await t.mod.getPricing(t.c())
    const byTier = tier => res.body.data.tiers.find(x => x.tier === tier)
    expect(byTier('FIX').amount).toBe(4900)
    expect(byTier('BADGE').amount).toBe(3900)
    expect(byTier('FIX_PLAIN').amount).toBe(3900)
    expect(res.body.data.referralApplied).toBe(false)
  })

  // AUDIT FIX (Section 3/4 pass, perf): used to call referral.service.js's
  // resolvePrice() once per tier, each doing its own independent
  // referral_codes lookup for the identical code — three DB round trips per
  // request. resolvePricesForTiers does the lookup once and reuses it for
  // all three tiers.
  it('looks up a referral code exactly once, not once per tier', async () => {
    t = setup({
      codeRow: { id: 'rc1', active: true, tier_prices: { FIX: 1900, BADGE: 1500, FIX_PLAIN: 1200 }, partners: { status: 'ACTIVE' } },
    })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    const referralLookups = t.db.calls.filter(c => c.table === 'referral_codes' && c.op === 'select')
    expect(referralLookups).toHaveLength(1)
    // And the single lookup's result was actually applied to all three tiers.
    const byTier = tier => res.body.data.tiers.find(x => x.tier === tier)
    expect(byTier('FIX').amount).toBe(1900)
    expect(byTier('BADGE').amount).toBe(1500)
    expect(byTier('FIX_PLAIN').amount).toBe(1200)
  })
})

// Payments & Pricing pass 1: B8 (discountApplied), B11 (buyerEmail self-referral
// guard threaded through), G5 (badgeThreshold/maxFixRetries in the quote).
describe('getPricing — Payments & Pricing pass 1 additions', () => {
  it('discountApplied is true when the code genuinely beats the standard price', async () => {
    t = setup({ codeRow: { id: 'rc1', active: true, tier_prices: { FIX: 1900 }, partners: { status: 'ACTIVE' } } })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    const fix = res.body.data.tiers.find(x => x.tier === 'FIX')
    expect(fix.referralApplied).toBe(true)
    expect(fix.discountApplied).toBe(true)
  })
  it('B8 regression: referralApplied stays true but discountApplied is false when the site promo already beats the code price', async () => {
    // PROMO_PRICE_FIX is a fixed constant (2900), not env-settable; a $19
    // code (1900) is genuinely BELOW that promo price, so use a code priced
    // ABOVE it (3500) to put the promo in the winning position.
    t = setup({
      env: { PROMO_ACTIVE: 'true', PROMO_ENDS_AT: new Date(Date.now() + 999999).toISOString() },
      codeRow: { id: 'rc1', active: true, tier_prices: { FIX: 3500 }, partners: { status: 'ACTIVE' } },
    })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    const fix = res.body.data.tiers.find(x => x.tier === 'FIX')
    expect(fix.amount).toBe(2900) // PROMO_PRICE_FIX wins over the code's 3500
    expect(fix.referralApplied).toBe(true)
    expect(fix.discountApplied).toBe(false)
  })
  it('discountApplied is false with no referral code at all', async () => {
    t = setup()
    const res = await t.mod.getPricing(t.c())
    expect(res.body.data.tiers.every(x => x.discountApplied === false)).toBe(true)
  })
  it('B11: passes the signed-in user\'s email through so a partner browsing their own code gets the TRUE (undiscounted) quote', async () => {
    t = setup({
      user: { email: 'partner@example.com' },
      codeRow: { id: 'rc1', active: true, tier_prices: { FIX: 1900 }, partners: { status: 'ACTIVE', email: 'partner@example.com' } },
    })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    const fix = res.body.data.tiers.find(x => x.tier === 'FIX')
    expect(fix.amount).toBe(4900) // standard FIX price — code did not apply
    expect(fix.referralApplied).toBe(false)
  })
  it('B11: an anonymous visitor (no user on context) is unaffected — undefined buyerEmail behaves exactly as before', async () => {
    t = setup({ codeRow: { id: 'rc1', active: true, tier_prices: { FIX: 1900 }, partners: { status: 'ACTIVE', email: 'partner@example.com' } } })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    expect(res.body.data.tiers.find(x => x.tier === 'FIX').amount).toBe(1900)
  })
  it('G5: returns badgeThreshold and maxFixRetries so the frontend never hardcodes them', async () => {
    t = setup()
    const res = await t.mod.getPricing(t.c())
    expect(res.body.data.badgeThreshold).toBe(80)
    expect(res.body.data.maxFixRetries).toBe(2)
  })
})

// Payments & Pricing round 2: top-level discountApplied/selfReferral (B2), ref cap.
describe('getPricing — round 2 additions', () => {
  const code = tp => ({ id: 'rc1', active: true, tier_prices: tp, partners: { status: 'ACTIVE', email: 'partner@example.com' } })

  it('top-level discountApplied is true when the code lowers at least one tier below today\'s price', async () => {
    t = setup({ codeRow: code({ FIX: 1900 }) })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    expect(res.body.data.referralApplied).toBe(true)
    expect(res.body.data.discountApplied).toBe(true)
  })
  it('B2: referralApplied true but top-level discountApplied false when the promo already beats every tier the code covers', async () => {
    t = setup({
      env: { PROMO_ACTIVE: 'true', PROMO_ENDS_AT: new Date(Date.now() + 999999).toISOString() },
      codeRow: code({ FIX: 3500 }),
    })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    expect(res.body.data.referralApplied).toBe(true)
    expect(res.body.data.discountApplied).toBe(false)
  })
  it('no code -> discountApplied false and selfReferral false at the top level', async () => {
    t = setup()
    const res = await t.mod.getPricing(t.c())
    expect(res.body.data.discountApplied).toBe(false)
    expect(res.body.data.selfReferral).toBe(false)
    expect(res.body.data.tiers.every(x => x.selfReferral === false)).toBe(true)
  })
  it('a partner browsing their OWN code is flagged selfReferral (so the UI can say so), with standard prices and referralApplied false', async () => {
    t = setup({ user: { id: 'u9', email: 'Partner@Example.com' }, codeRow: code({ FIX: 1900, BADGE: 1500, FIX_PLAIN: 1200 }) })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    expect(res.body.data.referralApplied).toBe(false)
    expect(res.body.data.selfReferral).toBe(true)
    expect(res.body.data.tiers.find(x => x.tier === 'FIX')).toMatchObject({ amount: 4900, selfReferral: true, referralApplied: false })
  })
  it('a different logged-in user on that same code is NOT flagged', async () => {
    t = setup({ user: { id: 'u2', email: 'buyer@example.com' }, codeRow: code({ FIX: 1900 }) })
    const res = await t.mod.getPricing(t.c({ query: { ref: 'coach20' } }))
    expect(res.body.data.selfReferral).toBe(false)
    expect(res.body.data.referralApplied).toBe(true)
  })
  it('caps the public ?ref= value at 100 characters before it reaches the lookup', async () => {
    t = setup()
    await t.mod.getPricing(t.c({ query: { ref: 'x'.repeat(5000) } }))
    const lookup = t.db.calls.find(c => c.table === 'referral_codes')
    const used = lookup.filters.find(f => f[0] === 'eq' && f[1] === 'code')[2]
    expect(used.length).toBe(100)
  })
})
