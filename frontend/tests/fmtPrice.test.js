import { describe, it, expect } from 'vitest'
import { fmtPrice } from '../src/hooks/usePricing'

// Section 3/4 audit (bug): fmtPrice used to toFixed(0) unconditionally, so a
// partner code priced at a non-round-dollar amount (tier_prices only requires
// a positive integer of cents; the admin UI inputs are step="0.01") showed a
// different number than Paystack actually charged.
describe('fmtPrice', () => {
  it('keeps the clean whole-dollar look for round amounts', () => {
    expect(fmtPrice(4900)).toBe('$49')
    expect(fmtPrice(2900)).toBe('$29')
    expect(fmtPrice(900)).toBe('$9')
  })
  it('never drops real cents', () => {
    expect(fmtPrice(2949)).toBe('$29.49')
    expect(fmtPrice(2950)).toBe('$29.50')
    expect(fmtPrice(2951)).toBe('$29.51')
    expect(fmtPrice(5)).toBe('$0.05')
  })
  it('non-USD currencies get a plain number + code, with the same cents rule', () => {
    expect(fmtPrice(150000, 'KES')).toBe('1500 KES')
    expect(fmtPrice(150050, 'KES')).toBe('1500.50 KES')
  })
})
