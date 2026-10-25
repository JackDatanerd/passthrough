// @vitest-environment jsdom
// Section 4 round 15: a CSV export that hits the page cap says so instead of looking complete.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'

const csv = vi.hoisted(() => ({ calls: [] }))
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../src/lib/utils', async orig => ({ ...(await orig()), downloadCsv: (...a) => csv.calls.push(a) }))

const cv = i => ({ id: `c${i}`, code: 'K', grossAmountCents: 1000, commissionRate: 0.2, commissionAmountCents: 200, paid: false, isReversal: false, createdAt: '2026-09-10T10:00:00Z' })
const base = {
  name: 'K', active: true, commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, scope: 'dashboard',
  stats: { totalClicks: 1, totalConversions: 1, pendingCents: 0, paidCents: 0 }, referralCodes: [], payouts: [], cyclesSummary: [],
  olderUnpaidCents: 0, carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0, readyToPayCents: 0, creditCents: 0,
  conversions: [cv(1)], conversionsTotal: 99999,
}
beforeEach(() => { cleanup(); api.get.mockReset(); csv.calls.length = 0 })

function mount(pageSize) {
  api.get.mockImplementation(url => {
    if (url.startsWith('/partners/dashboard')) return Promise.resolve({ data: { data: base } })
    if (url.startsWith('/partners/statement')) return Promise.reject(new Error('no statement in this test'))   // round 38: the yearly statement loads on mount
    const offset = Number(/offset=(\d+)/.exec(url)[1])
    return Promise.resolve({ data: { data: Array.from({ length: pageSize(offset) }, (_, i) => cv(offset + i)) } })
  })
  render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
}

describe('CSV export cap', () => {
  it('warns when older entries were not included', async () => {
    mount(() => 200)                                   // every page is full: the 25-page cap is reached
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }))
    expect((await screen.findByTestId('csv-truncated')).textContent).toMatch(/5,000 most recent/)
    expect(csv.calls).toHaveLength(1)
  })
  it('stays quiet when the whole history fit', async () => {
    mount(offset => (offset === 0 ? 120 : 0))
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }))
    await waitFor(() => expect(csv.calls).toHaveLength(1))
    expect(screen.queryByTestId('csv-truncated')).toBeNull()
  })
})
