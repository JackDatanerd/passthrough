// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import FixBanner from '../../src/components/scan/FixBanner'

// After-scan offer redesign: score gap, one featured tier with a live "$X more" nudge, a guarantee
// that matches the product (free retries, then a credit), and no Credential-only option under the bar.
const PRICES = { FIX: { amount: 2900, originalAmount: 4900 }, FIX_PLAIN: { amount: 1900, originalAmount: 3900 }, BADGE: { amount: 900, originalAmount: 3900 } }
let promo = {}
let currency = 'USD'
vi.mock('../../src/hooks/usePricing', async orig => ({
  ...(await orig()),
  usePricing: () => ({ byTier: t => PRICES[t], pricing: { currency, ...promo }, pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }),
}))
vi.mock('../../src/components/ui/ReferralCodeEntry', () => ({ ReferralCodeEntry: () => null, PricingFailedNotice: () => null }))

const scan = over => ({ id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, atsScore: 52, badgeEligible: false, inputMode: 'text', ...over })
const show = (over, props) => render(<FixBanner scan={scan(over)} onPay={vi.fn()} onRedeemCredit={vi.fn()} {...props} />)

describe('FixBanner offer — below the credential bar', () => {
  it('names the score gap and offers only the two fix tiers', () => {
    promo = {}
    show()
    expect(screen.getByText(/28 points short of the 80/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Fix My Resume/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Fix \+ Verified Credential/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Verified Credential only/ })).not.toBeInTheDocument()
  })

  it('the featured card carries a nudge computed from the live prices', () => {
    show()
    expect(screen.getByText('Best for most people')).toBeInTheDocument()
    expect(screen.getByText(/Only .*10.* more than the plain fix/)).toBeInTheDocument()
  })

  it('states the guarantee the product actually has: free retries, then a credit, not a refund', () => {
    show()
    const g = screen.getByTestId('fix-guarantee')
    expect(g).toHaveTextContent(/2 free retries/)
    expect(g).toHaveTextContent(/free fix credit/)
    expect(g).toHaveTextContent(/not a refund/)
  })

  it('uses the 75-79 headline when the score passes but is under the credential bar', () => {
    show({ atsScore: 77, status: 'COMPLETE_PASS' })
    expect(screen.getByText('Boost your score and unlock Verified status')).toBeInTheDocument()
    expect(screen.getByText(/3 points short/)).toBeInTheDocument()
  })

  it('shows the launch countdown only for a live promo with a deadline', () => {
    promo = { promoActive: true, promoEndsAt: new Date(Date.now() + 3 * 3600_000).toISOString() }
    show()
    expect(screen.getByRole('timer')).toBeInTheDocument()
    promo = {}
  })
})

describe('FixBanner offer — reference prices and optional hardship link', () => {
  it('sets the full fix against a resume writer and doing nothing, in dollars', () => {
    promo = {}; currency = 'USD'
    show()
    const c = screen.getByTestId('writer-compare')
    expect(c).toHaveTextContent('Hire a resume writer')
    expect(c).toHaveTextContent(/\$150\+/)
    expect(c).toHaveTextContent('Change nothing')
  })

  it('hides the dollar reference when the charge currency is not USD', () => {
    currency = 'EUR'
    show()
    expect(screen.queryByTestId('writer-compare')).not.toBeInTheDocument()
    currency = 'USD'
  })

  it('shows no hardship link when no hardship code is configured', () => {
    show()
    expect(screen.queryByTestId('hardship-offer')).not.toBeInTheDocument()
  })
})

describe('FixBanner offer — credential-eligible', () => {
  it('leads with the credential and says a rewrite is optional', () => {
    promo = {}
    show({ status: 'COMPLETE_PASS', atsScore: 87, badgeEligible: true })
    expect(screen.getByText(/You may not need a rewrite/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Verified Credential only/ })).toBeInTheDocument()
    expect(screen.getByTestId('fix-guarantee')).toBeInTheDocument()
  })

  it('renders nothing once a fix is purchased', () => {
    const { container } = show({ fixPurchased: true })
    expect(container).toBeEmptyDOMElement()
  })
})
