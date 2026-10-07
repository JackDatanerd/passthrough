// @vitest-environment jsdom
// Section 4 round 4 (G1): the dashboard link is READ-ONLY. Holders of it ask for the real
// payout-details link to be EMAILED; only a holder of the legacy write-capable link gets the
// direct link.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))

const base = {
  name: 'Coach K', active: true, commissionRate: 0.2, currency: 'USD', hasPayoutDetails: false, payoutMethod: null,
  stats: { totalEarnedCents: 1200, pendingCents: 1200, paidCents: 0, clicks: 0, conversions: 0, currentCycleCents: 0 },
  referralCodes: [], conversions: [], conversionsTotal: 0, payouts: [], cyclesSummary: [], olderUnpaidCents: 0,
  carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0,
}
function mount(scope) {
  api.get.mockResolvedValue({ data: { data: { ...base, scope } } })
  return render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
}

describe('PartnerDashboard payout-details access', () => {
  beforeEach(() => { cleanup(); api.get.mockReset(); api.post.mockReset() })

  it('read-only link: offers "email me a link", and sending it hits the request endpoint with the token', async () => {
    api.post.mockResolvedValue({ data: { success: true } })
    mount('dashboard')
    const btn = await screen.findByRole('button', { name: /email me a link to add them/i })
    fireEvent.click(btn)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/request-payout-link?token=TOK'))
    expect(await screen.findByText(/check the inbox/i)).toBeTruthy()
  })

  it('read-only link: there is NO direct link to the payout-details form', async () => {
    mount('dashboard')
    await screen.findByRole('button', { name: /email me a link to add them/i })
    expect(document.querySelector('a[href*="/partner/payout-details"]')).toBeNull()
  })

  it('legacy write-capable link: still gets the direct link', async () => {
    mount('payout')
    await screen.findByText(/add them now/i)
    expect(document.querySelector('a[href="/partner/payout-details?token=TOK"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /email me/i })).toBeNull()
  })

  it('a failed send says so and offers a retry instead of pretending it worked', async () => {
    api.post.mockRejectedValue(new Error('429'))
    mount('dashboard')
    fireEvent.click(await screen.findByRole('button', { name: /email me a link to add them/i }))
    expect(await screen.findByText(/couldn't send/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /email me a link to add them/i })).toBeTruthy()
  })
})
