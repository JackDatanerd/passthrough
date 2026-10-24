// Offer card: at or over the credential bar.
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import FixBanner from '../../src/components/scan/FixBanner'
import ScoreSummary from '../../src/components/scan/ScoreSummary'

// The offer after a scan: ONE card. The full fix + Verified is the main button; the plain fix (and, over the line, the credential
// alone) are quiet lines beneath it; the guarantee, the writer comparison and the countdown stay, in the card.
const PRICES = { FIX: { amount: 2900, originalAmount: 4900 }, FIX_PLAIN: { amount: 1900, originalAmount: 3900 }, BADGE: { amount: 900, originalAmount: 3900 } }
let promo = {}
let currency = 'USD'
let lastEntryProps = null
vi.mock('../../src/hooks/usePricing', async orig => ({
  ...(await orig()),
  usePricing: () => ({ byTier: t => PRICES[t], pricing: { currency, ...promo }, pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }),
}))
vi.mock('../../src/components/ui/ReferralCodeEntry', () => ({ ReferralCodeEntry: props => { lastEntryProps = props; return null }, PricingFailedNotice: () => null }))

const scan = over => ({ id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, atsScore: 52, badgeEligible: false, inputMode: 'text', ...over })
const show = (over, props) => render(<FixBanner scan={scan(over)} onPay={vi.fn()} onRedeemCredit={vi.fn()} {...props} />)

describe('offer card — credential-eligible', () => {
  const pass = (over, props) => show({ status: 'COMPLETE_PASS', atsScore: 87, badgeEligible: true, ...over }, props)

  it('features the full fix with a flag that does not overclaim, and says a rewrite is optional', () => {
    pass()
    expect(screen.getByText('Most complete')).toBeInTheDocument()
    expect(screen.queryByText('Best for most people')).toBeNull()
    expect(screen.getByText(/You may not need a rewrite/)).toBeInTheDocument()
  })

  it('still sells the credential on its own, and the plain fix, as quiet lines', () => {
    const onPay = vi.fn()
    pass({}, { onPay })
    fireEvent.click(within(screen.getByTestId('alt-badge')).getByRole('button'))
    expect(onPay).toHaveBeenCalledWith('BADGE')
    expect(within(screen.getByTestId('alt-badge')).getByRole('button')).toHaveTextContent('$9')
    expect(screen.getByTestId('alt-plain')).toBeInTheDocument()
  })

  it('does not sell the credential alone when the file we would deliver scores under the bar', () => {
    pass({ inputMode: 'file', atsDetail: { formattedScore: 70 } })
    expect(screen.queryByTestId('alt-badge')).toBeNull()
    expect(screen.getByTestId('formatted-low')).toBeInTheDocument()
  })

  it('asks for the formatted-file check first when it is not known yet', () => {
    const onCheckFormatted = vi.fn()
    pass({ inputMode: 'file' }, { onCheckFormatted })
    fireEvent.click(screen.getByRole('button', { name: /Check the formatted file/ }))
    expect(onCheckFormatted).toHaveBeenCalled()
  })
})

