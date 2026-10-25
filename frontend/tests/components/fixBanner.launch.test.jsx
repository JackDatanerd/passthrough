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

  it('leads with the credential: nothing needs rewriting, so the cheapest plan that does the job comes first', () => {
    const onPay = vi.fn()
    pass({}, { onPay })
    expect(screen.getByTestId('offer-card')).toHaveAttribute('data-primary', 'BADGE')
    expect(screen.getByText('Best for your score')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Get your Verified credential' })).toBeInTheDocument()
    expect(screen.getByTestId('offer-price')).toHaveTextContent('$9')
    expect(screen.getByText(/No rewrite is needed to earn the credential/)).toBeInTheDocument()
    expect(screen.getByText('Nothing is rewritten. Your 87 stays your 87.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Get my Verified credential/ }))
    expect(onPay).toHaveBeenCalledWith('BADGE')
    expect(screen.queryByRole('button', { name: /Fix & verify my resume/ })).toBeNull()
  })

  it('the rewrite is the quiet step up, and the plain fix stays available; the guarantee is the credential\'s own', () => {
    const onPay = vi.fn()
    pass({}, { onPay })
    fireEvent.click(within(screen.getByTestId('alt-fix')).getByRole('button'))
    expect(onPay).toHaveBeenCalledWith('FIX')
    expect(screen.getByTestId('alt-fix')).toHaveTextContent('Want it rewritten too?')
    fireEvent.click(within(screen.getByTestId('alt-plain')).getByRole('button'))
    expect(onPay).toHaveBeenCalledWith('FIX_PLAIN')
    expect(screen.getByTestId('fix-guarantee')).toHaveTextContent(/only issued if the file we deliver scores 80 or more/)
    expect(screen.getByTestId('fix-guarantee')).toHaveTextContent(/not a refund/)
  })

  it('does NOT lead with the credential when the file we would deliver scores under the bar: the full fix leads', () => {
    pass({ inputMode: 'file', atsDetail: { formattedScore: 70 } })
    expect(screen.getByTestId('offer-card')).toHaveAttribute('data-primary', 'FIX')
    expect(screen.getByRole('button', { name: /Fix & verify my resume/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Get my Verified credential/ })).toBeNull()
    expect(screen.getByTestId('formatted-low')).toBeInTheDocument()
  })

  it('asks for the formatted-file check first when it is not known yet (the full fix leads until the credential is confirmed)', () => {
    const onCheckFormatted = vi.fn()
    pass({ inputMode: 'file' }, { onCheckFormatted })
    expect(screen.getByTestId('offer-card')).toHaveAttribute('data-primary', 'FIX')
    fireEvent.click(screen.getByRole('button', { name: /Check the formatted file/ }))
    expect(onCheckFormatted).toHaveBeenCalled()
  })
})
