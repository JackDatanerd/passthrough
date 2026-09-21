import { describe, it, expect } from 'vitest'
import c from '../src/config/constants.js'

const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const PAST = new Date(Date.now() - 3600_000).toISOString()

describe('isPromoActive', () => {
  it('is active only with PROMO_ACTIVE="true" AND a future deadline', () => {
    expect(c.isPromoActive({ PROMO_ACTIVE: 'true', PROMO_ENDS_AT: FUTURE })).toBe(true)
  })
  it('expires the moment the deadline passes', () => {
    expect(c.isPromoActive({ PROMO_ACTIVE: 'true', PROMO_ENDS_AT: PAST })).toBe(false)
  })
  it('is off when the flag is anything but the string "true"', () => {
    for (const flag of ['false', 'TRUE', '1', '', undefined, true])
      expect(c.isPromoActive({ PROMO_ACTIVE: flag, PROMO_ENDS_AT: FUTURE })).toBe(false)
  })
  it('is off without a deadline, and FAILS SAFE (standard pricing) on an unparseable one', () => {
    expect(c.isPromoActive({ PROMO_ACTIVE: 'true' })).toBe(false)
    expect(c.isPromoActive({ PROMO_ACTIVE: 'true', PROMO_ENDS_AT: 'next tuesday' })).toBe(false)
  })
  it('tolerates a missing env', () => {
    expect(c.isPromoActive(undefined)).toBe(false)
    expect(c.isPromoActive({})).toBe(false)
  })
})

describe('priceForTier / standardPriceForTier', () => {
  const promoEnv = { PROMO_ACTIVE: 'true', PROMO_ENDS_AT: FUTURE }

  it('charges standard prices with no promo', () => {
    expect(c.priceForTier('FIX', {})).toBe(4900)
    expect(c.priceForTier('BADGE', {})).toBe(3900)
    expect(c.priceForTier('FIX_PLAIN', {})).toBe(3900)
  })
  it('charges promo prices during the promo', () => {
    expect(c.priceForTier('FIX', promoEnv)).toBe(2900)
    expect(c.priceForTier('BADGE', promoEnv)).toBe(900)
    expect(c.priceForTier('FIX_PLAIN', promoEnv)).toBe(1900)
  })
  it('an unknown tier falls back to the FIX price rather than 0/undefined', () => {
    expect(c.priceForTier('WHATEVER', {})).toBe(4900)
  })
  it('standardPriceForTier is the un-promoted anchor price, regardless of any promo', () => {
    expect(c.standardPriceForTier('FIX')).toBe(4900)
    expect(c.standardPriceForTier('BADGE')).toBe(3900)
    expect(c.standardPriceForTier('FIX_PLAIN')).toBe(3900)
  })
  it('every promo price is strictly below its standard price (a "discount" can never be an increase)', () => {
    for (const t of ['FIX', 'BADGE', 'FIX_PLAIN'])
      expect(c.priceForTier(t, promoEnv)).toBeLessThan(c.standardPriceForTier(t))
  })
})
