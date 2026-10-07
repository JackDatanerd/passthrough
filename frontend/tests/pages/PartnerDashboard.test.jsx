// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import PartnerDashboard from '../../src/pages/PartnerDashboard'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

const base = {
  name: 'Coach K', commissionRate: 0.2, active: true, currency: 'USD', hasPayoutDetails: true,
  referralCodes: [], conversions: [], conversionsTotal: 0, payouts: [], cyclesSummary: [], olderUnpaidCents: 0,
  stats: { totalClicks: 0, totalConversions: 0, pendingCents: 0, paidCents: 0 },
}
const show = data => {
  api.get.mockResolvedValue({ data: { success: true, data: { ...base, ...data } } })
  return render(<MemoryRouter initialEntries={['/partner/dashboard?token=tok']}><PartnerDashboard /></MemoryRouter>)
}
beforeEach(() => api.get.mockReset())

describe('PartnerDashboard — payout details prompt', () => {
  it('asks for payout details when money is owed and none are on file', async () => {
    show({ hasPayoutDetails: false, stats: { ...base.stats, pendingCents: 580 } })
    expect(await screen.findByText(/don't have your payout details/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /add them now/i }).getAttribute('href')).toContain('/partner/payout-details?token=tok')
  })
  it('does not nag a brand-new partner with nothing earned yet', async () => {
    show({ hasPayoutDetails: false })
    await screen.findByText(/Coach K's Passthrough dashboard/)
    expect(screen.queryByText(/don't have your payout details/i)).toBeNull()
  })
  it('does not show the prompt once details are on file', async () => {
    show({ hasPayoutDetails: true, stats: { ...base.stats, pendingCents: 580 } })
    await screen.findByText(/Coach K's Passthrough dashboard/)
    expect(screen.queryByText(/don't have your payout details/i)).toBeNull()
  })
  it('explains a below-minimum balance carrying forward', async () => {
    show({ belowMinimum: true, minPayoutCents: 2000, carriedForwardCents: 580 })
    expect(await screen.findByText(/carries/i)).toBeInTheDocument()
    expect(screen.getByText(/Payouts start at \$20\.00/)).toBeInTheDocument()
  })
})

describe('PartnerDashboard — how crediting works (G6)', () => {
  it('shows the same terms an applicant saw, in an expandable note', async () => {
    show({})
    const note = await screen.findByTestId('attribution-terms')
    expect(note).toHaveTextContent('How crediting works')
    expect(note).toHaveTextContent(/30 days after their most recent click/)
    expect(note).toHaveTextContent(/not just the first/)
    expect(note).toHaveTextContent(/refunded, its commission is reversed/)
  })
})
