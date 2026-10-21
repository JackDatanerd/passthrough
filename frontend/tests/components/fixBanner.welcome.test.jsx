// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import FixBanner from '../../src/components/scan/FixBanner'

// The banner prices against the welcome code and says so, but only when the quote confirms the discount is real.
const seen = []
let quote
vi.mock('../../src/hooks/usePricing', async orig => ({
  ...(await orig()),
  usePricing: code => { seen.push(code); return quote(code) },
}))
vi.mock('../../src/components/ui/ReferralCodeEntry', () => ({ ReferralCodeEntry: ({ referralCode }) => <span data-testid="entry">{referralCode || 'empty'}</span>, PricingFailedNotice: () => null }))

const OFFER = { code: 'FN-7K2QH', percentOff: 30, amountCents: 2030, listAmountCents: 2900, currency: 'USD', tier: 'FIX', expiresAt: '2026-11-04T12:00:00.000Z' }
const tiers = (fix, over = {}) => ({
  FIX: { amount: 2030, originalAmount: 4900, referralApplied: true, discountApplied: true, ...fix },
  FIX_PLAIN: { amount: 1900, originalAmount: 3900, referralApplied: false, discountApplied: false },
  BADGE: { amount: 900, originalAmount: 3900, referralApplied: false, discountApplied: false },
  ...over,
})
const priced = (fix, pricing = {}) => code => ({ byTier: t => tiers(fix)[t], pricing: { currency: 'USD', referralApplied: !!code, ...pricing }, pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 })
const scan = { id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, atsScore: 52, badgeEligible: false, inputMode: 'text' }
const show = props => render(<FixBanner scan={scan} onPay={vi.fn()} onRedeemCredit={vi.fn()} {...props} />)
beforeEach(() => { seen.length = 0; quote = priced({}) })

describe('FixBanner — welcome offer', () => {
  it('prices the page with the welcome code and says the welcome price is applied', () => {
    show({ welcomeOffer: OFFER })
    expect(seen).toContain('FN-7K2QH')
    const line = screen.getByTestId('welcome-applied')
    expect(line).toHaveTextContent('Welcome price applied: 30% off the Full fix + Verified, $20.30 instead of $29')
    expect(line).toHaveTextContent(/works once, until/)
  })

  it('does not present the welcome code as a code to type or remove (the entry stays empty)', () => {
    show({ welcomeOffer: OFFER })
    expect(screen.getByTestId('entry')).toHaveTextContent('empty')
  })

  it('says nothing when the quote does not confirm a discount (code spent, expired, or refused by the server)', () => {
    quote = priced({ referralApplied: false, discountApplied: false, amount: 2900 })
    show({ welcomeOffer: OFFER })
    expect(screen.queryByTestId('welcome-applied')).toBeNull()
    quote = priced({ discountApplied: false })
    show({ welcomeOffer: OFFER })
    expect(screen.queryByTestId('welcome-applied')).toBeNull()
  })

  it('says nothing with no offer, and prices with no code at all', () => {
    show({})
    expect(screen.queryByTestId('welcome-applied')).toBeNull()
    expect(seen[0]).toBe('')
  })

  it("an explicit code wins: the page is priced with it and the welcome line is not shown", () => {
    show({ welcomeOffer: OFFER, referralCode: 'PARTNER10' })
    expect(seen).toContain('PARTNER10')
    expect(seen).not.toContain('FN-7K2QH')
    expect(screen.queryByTestId('welcome-applied')).toBeNull()
    expect(screen.getByTestId('entry')).toHaveTextContent('PARTNER10')
  })
})
