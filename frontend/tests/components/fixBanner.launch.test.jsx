// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import FixBanner from '../../src/components/scan/FixBanner'

// Launch pass: the offer's recommended card leads on a phone, the risk-reversal sits against the buy buttons, and at a
// passing score the full fix is the featured card with an honest flag (not "Best for most people").
const PRICES = { FIX: { amount: 2900, originalAmount: 4900 }, FIX_PLAIN: { amount: 1900, originalAmount: 3900 }, BADGE: { amount: 900, originalAmount: 3900 } }
vi.mock('../../src/hooks/usePricing', async orig => ({
  ...(await orig()),
  usePricing: () => ({ byTier: t => PRICES[t], pricing: { currency: 'USD' }, pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }),
}))
let lastEntryProps = null
vi.mock('../../src/components/ui/ReferralCodeEntry', () => ({ ReferralCodeEntry: props => { lastEntryProps = props; return null }, PricingFailedNotice: () => null }))

const scan = over => ({ id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, atsScore: 52, badgeEligible: false, inputMode: 'text', ...over })
const show = over => render(<FixBanner scan={scan(over)} onPay={vi.fn()} onRedeemCredit={vi.fn()} />)
const card = title => screen.getByRole('heading', { name: title }).closest('div[class*="rounded-xl"]')

describe('FixBanner — below the credential bar', () => {
  it('the featured card leads when the cards stack (order-first), and keeps its column from sm up', () => {
    show()
    expect(card('Full fix + Verified').className).toMatch(/\border-first\b/)
    expect(card('Full fix + Verified').className).toMatch(/\bsm:order-none\b/)
    expect(card('Fix only').className).not.toMatch(/order-first/)
  })

  it('puts a short risk-reversal against the buy buttons of both rewrite cards', () => {
    show()
    for (const t of ['Fix only', 'Full fix + Verified']) {
      expect(within(card(t)).getByTestId('offer-assurance')).toHaveTextContent(/2 free retries.*free fix credit/)
    }
    // the full guarantee (with "not a refund") is still there as well
    expect(screen.getByTestId('fix-guarantee')).toHaveTextContent(/not a refund/)
  })

  it('hides the code box behind "Have a code?" (the checkout offer opts in to collapsing it)', () => {
    show()
    expect(lastEntryProps.collapsible).toBe(true)
  })
})

describe('FixBanner — credential-eligible', () => {
  const pass = () => show({ status: 'COMPLETE_PASS', atsScore: 87, badgeEligible: true })

  it('features the full fix with a flag that does not overclaim', () => {
    pass()
    expect(card('Full fix + Verified').className).toMatch(/border-blue-700/)
    expect(within(card('Full fix + Verified')).getByText('Most complete')).toBeInTheDocument()
    expect(screen.queryByText('Best for most people')).toBeNull()
  })

  it('no longer features the cheapest credential card, but still sells it and says a rewrite is optional', () => {
    pass()
    expect(card('Verified credential').className).not.toMatch(/border-blue-700/)
    expect(screen.getByRole('button', { name: /Verified Credential only/ })).toBeInTheDocument()
    expect(screen.getByText(/You may not need a rewrite/)).toBeInTheDocument()
  })

  it('the credential-only card has no retry assurance (there is no rewrite to retry); the rewrite cards do', () => {
    pass()
    expect(within(card('Verified credential')).queryByTestId('offer-assurance')).toBeNull()
    expect(within(card('Fix only')).getByTestId('offer-assurance')).toBeInTheDocument()
    expect(within(card('Full fix + Verified')).getByTestId('offer-assurance')).toBeInTheDocument()
  })

  it('the full-fix button is the primary action', () => {
    pass()
    const btn = screen.getByRole('button', { name: /Full AI Fix \+ Credential/ })
    expect(btn.className).not.toMatch(/secondary/)
  })
})
