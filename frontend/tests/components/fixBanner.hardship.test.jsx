// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The hardship code is read from the environment when the component module loads.
vi.stubEnv('VITE_HARDSHIP_CODE', 'hardship')

const q = (fix, flags = { referralApplied: true, discountApplied: true }) => ({
  byTier: t => (t === 'FIX' ? { amount: fix, originalAmount: 4900, ...flags } : { amount: fix, originalAmount: 4900, ...flags }),
  pricing: { currency: 'USD' }, pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0,
})
let hardshipQuote = q(1450)
vi.mock('../../src/hooks/usePricing', async orig => ({
  ...(await orig()),
  usePricing: code => (code === 'HARDSHIP' ? hardshipQuote : q(2900, { referralApplied: false, discountApplied: false })),
}))
vi.mock('../../src/components/ui/ReferralCodeEntry', () => ({ ReferralCodeEntry: () => null, PricingFailedNotice: () => null }))
const { default: FixBanner } = await import('../../src/components/scan/FixBanner')

const scan = { id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, atsScore: 52, badgeEligible: false, inputMode: 'text' }
const show = props => render(<FixBanner scan={scan} onPay={vi.fn()} onRedeemCredit={vi.fn()} {...props} />)

describe('FixBanner — hardship link', () => {
  it('states the discount measured from the live quote and applies the code on click', async () => {
    const onApply = vi.fn()
    show({ onApplyReferralCode: onApply })
    const btn = screen.getByRole('button', { name: /Take 50% off any fix/ })
    await userEvent.setup().click(btn)
    expect(onApply).toHaveBeenCalledWith('HARDSHIP')
  })

  it('once applied, says so and offers to remove it', async () => {
    const onApply = vi.fn()
    show({ referralCode: 'HARDSHIP', onApplyReferralCode: onApply })
    expect(screen.getByTestId('hardship-applied')).toHaveTextContent('Hardship price applied')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove' }))
    expect(onApply).toHaveBeenCalledWith('')
  })

  it("does not replace a partner's code that is already applied", () => {
    show({ referralCode: 'PARTNER1' })
    expect(screen.queryByTestId('hardship-offer')).not.toBeInTheDocument()
  })

  it('is not offered when the code would not actually lower the price', () => {
    hardshipQuote = q(2900, { referralApplied: true, discountApplied: false })
    show()
    expect(screen.queryByTestId('hardship-offer')).not.toBeInTheDocument()
    hardshipQuote = q(1450)
  })
})
