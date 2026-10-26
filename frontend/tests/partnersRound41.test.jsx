// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'
import PartnerApply from '../src/pages/PartnerApply'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../src/components/lead/TurnstileWidget', () => ({ default: () => null, TURNSTILE_ENABLED: false }))

// Partners round 41 (frontend): the apply form always names the terms version it showed, and the dashboard never says "ready to be paid"
// when the next payout run cannot pay it.

const base = {
  name: 'Coach K', commissionRate: 0.2, active: true, status: 'ACTIVE', currency: 'USD', hasPayoutDetails: true,
  referralCodes: [], conversions: [], conversionsTotal: 0, payouts: [], cyclesSummary: [], olderUnpaidCents: 0,
  stats: { totalClicks: 0, totalConversions: 0, pendingCents: 0, paidCents: 0 }, readyToPayCents: 2500,
}
function showDashboard(extra) {
  api.get.mockImplementation(async url => {
    if (url.startsWith('/partners/dashboard')) return { data: { success: true, data: { ...base, ...extra } } }
    return { data: { success: true, data: {}, total: 0 } }
  })
  render(<MemoryRouter initialEntries={['/partner/dashboard?token=tok']}><PartnerDashboard /></MemoryRouter>)
}
beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('the "ready to be paid" notice', () => {
  it('is shown when there are payout details and no hold', async () => {
    showDashboard({})
    expect(await screen.findByTestId('ready-to-pay')).toHaveTextContent('$25.00')
  })
  it('is not shown beside "we can\u2019t pay you" when there are no payout details', async () => {
    showDashboard({ hasPayoutDetails: false, stats: { ...base.stats, pendingCents: 2500 } })
    await screen.findByText(/we can't pay you/i)
    expect(screen.queryByTestId('ready-to-pay')).toBeNull()
  })
  it('is not shown while the payout is on hold after a details change', async () => {
    showDashboard({ payoutHoldUntil: new Date(Date.now() + 3600000).toISOString() })
    await screen.findByTestId('payout-hold')
    expect(screen.queryByTestId('ready-to-pay')).toBeNull()
  })
})

describe('the apply form and the terms version', () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ann' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ann@x.co' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /submit application/i }))
  }
  it('stops with a clear message when the current version cannot be loaded, and posts nothing', async () => {
    api.get.mockRejectedValue(new Error('offline'))
    render(<MemoryRouter><PartnerApply /></MemoryRouter>)
    fill()
    expect(await screen.findByText(/couldn.t load the current partner terms/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('re-fetches the version at submit if the page load missed it, then sends it', async () => {
    let n = 0
    api.get.mockImplementation(async () => { if (++n === 1) throw new Error('blip'); return { data: { data: { termsVersion: '2026-10b' } } } })
    api.post.mockResolvedValue({ data: { success: true } })
    render(<MemoryRouter><PartnerApply /></MemoryRouter>)
    fill()
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toMatchObject({ termsVersion: '2026-10b', acceptTerms: true })
  })
})
