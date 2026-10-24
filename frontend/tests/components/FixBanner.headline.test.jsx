// Scan/ATS round 9 (B4), now on the score card: the headline follows the shared pass threshold, not a typed-in 75.
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

describe('score summary — follows the shared pass threshold, not a typed-in 75', () => {
  it('between the pass line and the badge line it is not told it is failing, and the gap to Verified is named', () => {
    render(<ScoreSummary score={77} passed={undefined} />)
    expect(screen.getByText('Your resume passed ATS screening')).toBeInTheDocument()
    expect(screen.getByText(/3 points from the 80 that earns a Verified link/)).toBeInTheDocument()
  })
  it('under the pass line it is told it is failing, and how far below the pass mark', () => {
    render(<ScoreSummary score={62} passed={undefined} />)
    expect(screen.getByText('Your resume is failing ATS filters')).toBeInTheDocument()
    expect(screen.getByText(/18 points from the 80 that earns a Verified link, 13 below the usual pass mark/)).toBeInTheDocument()
  })
  it('the server verdict (scan.passed) wins over the local comparison', () => {
    render(<ScoreSummary score={77} passed={false} />)
    expect(screen.getByText('Your resume is failing ATS filters')).toBeInTheDocument()
  })
})
