// Offer card: below the credential bar. (The card is one card; see also fixBanner.launch.test.jsx for the eligible case.)
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

describe('offer card — below the credential bar', () => {
  it('is one card: the price, the main button, and "Fix only" as a quiet line', () => {
    promo = {}
    const onPay = vi.fn()
    show({}, { onPay })
    expect(screen.getAllByTestId('offer-card')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Fix & verify my resume' })).toBeInTheDocument()
    expect(screen.getByTestId('offer-price')).toHaveTextContent('$29')
    expect(screen.getByTestId('offer-price')).toHaveTextContent('$49')
    fireEvent.click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    expect(onPay).toHaveBeenCalledWith('FIX')
    const alt = screen.getByTestId('alt-plain')
    expect(alt).toHaveTextContent(/Just the rewrite, no Verified\?/)
    fireEvent.click(within(alt).getByRole('button'))
    expect(onPay).toHaveBeenCalledWith('FIX_PLAIN')
    expect(within(alt).getByRole('button')).toHaveTextContent('$19')
    expect(screen.queryByTestId('alt-badge')).toBeNull()                       // no credential-only option under the bar
  })

  it('names the score gap and keeps the "best for most people" flag when no promo is running', () => {
    show()
    expect(screen.getByText(/28 points short of the 80/)).toBeInTheDocument()
    expect(screen.getByText('Best for most people')).toBeInTheDocument()
  })

  it('states the guarantee the product has: free retries, then a credit, not a refund (also as a bullet)', () => {
    show()
    const g = screen.getByTestId('fix-guarantee')
    expect(g).toHaveTextContent(/2 free retries/)
    expect(g).toHaveTextContent(/free fix credit/)
    expect(g).toHaveTextContent(/not a refund/)
    expect(screen.getByText(/2 free retries\. Still short\? You get a free fix credit\./)).toBeInTheDocument()
  })

  it('does not repeat the provisional notice (the page already shows its own, with the re-check button) and drops the gap claim', () => {
    show({}, { provisional: true })
    expect(screen.queryByTestId('provisional-note')).toBeNull()
    expect(screen.queryByText(/provisional/i)).toBeNull()
    expect(screen.queryByText(/points short of the 80/)).toBeNull()      // a provisional number may read low, so no gap is claimed
  })
  it('names what each quieter option includes, cover letters first', () => {
    promo = { coverLetterLimits: { BADGE: 2, FIX_PLAIN: 3, FIX: 5 } }
    show()
    expect(screen.getByTestId('alt-plain-letters')).toHaveTextContent('Cover letter writing: 3 tailored letters')
    promo = {}
  })

  it('shows the countdown in place of the flag for a live promo with a deadline', () => {
    promo = { promoActive: true, promoEndsAt: new Date(Date.now() + 3 * 3600_000).toISOString() }
    show()
    expect(screen.getByRole('timer')).toBeInTheDocument()
    expect(screen.queryByText('Best for most people')).toBeNull()
    promo = {}
  })

  it('hides the code box behind "Have a code?" (the offer opts in to collapsing it)', () => {
    show()
    expect(lastEntryProps.collapsible).toBe(true)
  })

  it('offers a free credit as its own button above the main one', () => {
    const onRedeemCredit = vi.fn()
    show({}, { freeFixCredits: 2, onRedeemCredit })
    fireEvent.click(screen.getByRole('button', { name: /Use my free fix credit/ }))
    expect(onRedeemCredit).toHaveBeenCalled()
  })

  it('sets the fix against a resume writer and doing nothing, in dollars only', () => {
    currency = 'USD'
    const { unmount } = show()
    const c = screen.getByTestId('writer-compare')
    expect(c).toHaveTextContent(/\$150\+ resume writer/)
    expect(c).toHaveTextContent(/\$0 change nothing/)
    unmount()
    currency = 'EUR'
    show()
    expect(screen.queryByTestId('writer-compare')).toBeNull()
    currency = 'USD'
  })

  it('tells the buyer which tabs open after paying, and renders the gate it is given', () => {
    const { rerender } = render(<FixBanner scan={scan()} onPay={vi.fn()} onRedeemCredit={vi.fn()}><p>gate here</p></FixBanner>)
    expect(screen.getByText(/Your resume/, { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByText('gate here')).toBeInTheDocument()
    rerender(<FixBanner scan={scan({ fixPurchased: true })} onPay={vi.fn()} onRedeemCredit={vi.fn()} />)
    expect(screen.queryByTestId('offer-card')).toBeNull()
  })

  it('names the cover letter with the allowance the server sends, with a NEW tag', () => {
    promo = { coverLetterLimits: { BADGE: 2, FIX_PLAIN: 3, FIX: 5 } }
    show()
    expect(screen.getByText('Cover letter writing: 5 tailored letters')).toBeInTheDocument()
    expect(screen.getAllByTestId('new-tag')).toHaveLength(1)
    promo = {}
  })
})

