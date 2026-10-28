// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})

// Partners round 43: after a platform currency change the partner's pages never add amounts of different currencies together - the
// dashboard says so and lists each currency, and the yearly statement is one block per currency.

const year = new Date().getUTCFullYear()
const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, sales: 0, grossCents: 0, commissionCents: 0, reversalCents: 0, adjustmentCents: 0, netCents: 0 }))
const withMonth = netCents => months.map(m => (m.month === 3 ? { ...m, sales: 1, commissionCents: netCents, netCents } : m))
const dash = extra => ({
  name: 'Ann', commissionRate: 0.2, active: true, status: 'ACTIVE', currency: 'USD', referralCodes: [], notifyConversions: true,
  payoutAccount: null, payoutHoldUntil: null, termsAcceptanceRequired: false, currentTermsVersion: 'v', acceptedTermsVersion: 'v',
  hasPayoutDetails: true, heldCents: 0, minPayoutCents: 0, belowMinimum: false, carriedForwardCents: 0,
  stats: { totalClicks: 0, totalConversions: 0, pendingCents: 0, paidCents: 0 }, conversions: [], conversionsTotal: 0, payouts: [], cycles: [], ...extra,
})
const show = async (dashboard, statement) => {
  api.get.mockImplementation(async url => {
    if (url.startsWith('/partners/statement')) return { data: { success: true, data: statement } }
    return { data: { success: true, data: dashboard } }
  })
  render(<MemoryRouter initialEntries={['/partner?token=t']}><PartnerDashboard /></MemoryRouter>)
}
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('mixed-currency notice', () => {
  it('lists each currency when the unpaid ledger spans more than one', async () => {
    await show(dash({ mixedCurrency: true, unpaidByCurrency: { USD: 1300, KES: 700000 } }), { year, currency: 'USD', months, earnedCents: 0, paidCents: 0, payoutCount: 0 })
    const note = await screen.findByTestId('mixed-currency')
    expect(note.textContent).toMatch(/more than one currency/i)
    expect(note.textContent).toMatch(/13\.00/)
    expect(note.textContent).toMatch(/7,000\.00/)
  })
  it('says nothing for a single-currency partner', async () => {
    await show(dash({ mixedCurrency: false, unpaidByCurrency: { USD: 1300 } }), { year, currency: 'USD', months, earnedCents: 0, paidCents: 0, payoutCount: 0 })
    await screen.findByTestId('annual-statement')
    expect(screen.queryByTestId('mixed-currency')).toBeNull()
  })
})

describe('yearly statement per currency', () => {
  const statement = {
    year, currency: 'USD', months: withMonth(1300), earnedCents: 1300, paidCents: 400, payoutCount: 1,
    currencies: [
      { currency: 'USD', months: withMonth(1300), earnedCents: 1300, paidCents: 400, payoutCount: 1 },
      { currency: 'KES', months: withMonth(700000), earnedCents: 700000, paidCents: 650000, payoutCount: 1 },
    ],
  }
  it('shows one block per currency, never a combined figure', async () => {
    await show(dash({}), statement)
    const box = await screen.findByTestId('annual-statement')
    const usd = await within(box).findByTestId('statement-USD')
    const kes = within(box).getByTestId('statement-KES')
    expect(usd.textContent).toMatch(/13\.00/)
    expect(kes.textContent).toMatch(/7,000\.00/)
    expect(box.textContent).not.toMatch(/7,013\.00/)
    expect(box.textContent).toMatch(/never added together/i)
  })
  it('an older single-currency response still renders as one block', async () => {
    const { currencies, ...legacy } = statement
    await show(dash({}), legacy)
    const box = await screen.findByTestId('annual-statement')
    expect(await within(box).findByTestId('statement-USD')).toBeTruthy()
    expect(within(box).queryByTestId('statement-KES')).toBeNull()
  })
})
