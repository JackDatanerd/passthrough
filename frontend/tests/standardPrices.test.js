import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { STANDARD_PRICES } from '../src/hooks/usePricing'

// Payments & Pricing round 8: usePricing.js's STANDARD_PRICES is the last-resort price shown when /api/pricing
// cannot be fetched. It is a second copy of the backend's standard prices with nothing tying the two together —
// a price change in config/constants.js would leave the fallback quoting the OLD price (while checkout charges
// the new one) until someone remembered. This fails the build instead.
const require = createRequire(import.meta.url)
const backend = require('../../src/config/constants.js')

describe('usePricing STANDARD_PRICES fallback', () => {
  it('equals the backend standard (non-promo) price for every tier', () => {
    for (const tier of ['FIX', 'BADGE', 'FIX_PLAIN'])
      expect(STANDARD_PRICES[tier], `${tier} fallback price drifted from constants.standardPriceForTier`).toBe(backend.standardPriceForTier(tier))
  })
  it('covers exactly the tiers the backend prices', () => {
    expect(Object.keys(STANDARD_PRICES).sort()).toEqual(['BADGE', 'FIX', 'FIX_PLAIN'])
  })
})
