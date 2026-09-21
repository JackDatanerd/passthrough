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
})
