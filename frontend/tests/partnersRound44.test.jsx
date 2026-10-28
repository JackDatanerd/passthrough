// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))

const DAY = 86400000
const base = {
  name: 'Coach K', commissionRate: 0.2, active: true, status: 'ACTIVE', currency: 'USD', hasPayoutDetails: true,
  conversions: [], conversionsTotal: 0, payouts: [], cyclesSummary: [], olderUnpaidCents: 0,
  stats: { totalClicks: 0, totalConversions: 0, pendingCents: 0, paidCents: 0 },
}
const code = over => ({ id: 'c1', code: 'COACH20', tierPrices: { FIX: 1900 }, active: true, usageLimit: null, usesSoFar: 0, clicks: 0, expiresAt: null, ...over })
const show = referralCodes => {
  api.get.mockResolvedValue({ data: { success: true, data: { ...base, referralCodes } } })
  return render(<MemoryRouter initialEntries={['/partner/dashboard?token=tok']}><PartnerDashboard /></MemoryRouter>)
}
beforeEach(() => api.get.mockReset())

describe('round 44: a code shows when it stops working', () => {
  it('shows a far expiry date quietly', async () => {
    show([code({ expiresAt: new Date(Date.now() + 60 * DAY).toISOString() })])
    const note = await screen.findByTestId('code-expiry')
    expect(note).toHaveTextContent(/Expires/)
    expect(note).not.toHaveTextContent(/days left/)
  })
  it('warns inside the last week', async () => {
    show([code({ expiresAt: new Date(Date.now() + 3 * DAY).toISOString() })])
    const note = await screen.findByTestId('code-expiry')
    expect(note).toHaveTextContent(/days? left|less than a day/)
    expect(note).toHaveTextContent(/extended or replaced/)
  })
  it('warns when few redemptions remain', async () => {
    show([code({ usageLimit: 50, usesSoFar: 47 })])
    expect(await screen.findByTestId('code-expiry')).toHaveTextContent(/Only 3 redemptions left/)
  })
  it('shows nothing for a code with no expiry and plenty of room', async () => {
    show([code({ usageLimit: 50, usesSoFar: 2 })])
    await screen.findAllByText('COACH20')
    expect(screen.queryByTestId('code-expiry')).toBeNull()
  })
  it('does not show a countdown on a code that is already not live', async () => {
    show([code({ active: false, expiresAt: new Date(Date.now() + 3 * DAY).toISOString() })])
    await screen.findAllByText('COACH20')
    expect(screen.queryByTestId('code-expiry')).toBeNull()
  })
})
