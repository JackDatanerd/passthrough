// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'
import AdminPartners from '../src/pages/admin/AdminPartners'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

// Partners round 39 (frontend): a failed conversions filter says so (it used to read "No entries match"), and the admin sees the code
// requests partners sent.

const base = {
  name: 'Coach K', commissionRate: 0.2, active: true, status: 'ACTIVE', currency: 'USD', hasPayoutDetails: true,
  referralCodes: [{ id: 'c1', code: 'ONE', active: true, tierPrices: {}, clicks: 0, usesSoFar: 0 }, { id: 'c2', code: 'TWO', active: true, tierPrices: {}, clicks: 0, usesSoFar: 0 }],
  conversions: [{ id: 'v1', createdAt: '2026-03-01T00:00:00Z', code: 'ONE', commissionAmountCents: 500, grossAmountCents: 2500, commissionRate: 0.2, paid: false }],
  conversionsTotal: 1, payouts: [], cyclesSummary: [], olderUnpaidCents: 0,
  stats: { totalClicks: 0, totalConversions: 0, pendingCents: 0, paidCents: 0 },
}
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('conversions filter failure', () => {
  it('shows the error instead of "No entries match that filter"', async () => {
    api.get.mockImplementation(async url => {
      if (url.startsWith('/partners/dashboard')) return { data: { success: true, data: base } }
      if (url.includes('codeId=c2')) throw new Error('network')
      return { data: { success: true, total: 0, data: [] } }
    })
    render(<MemoryRouter initialEntries={['/partner/dashboard?token=tok']}><PartnerDashboard /></MemoryRouter>)
    const filters = await screen.findByTestId('conversion-filters')
    fireEvent.change(filters.querySelector('select'), { target: { value: 'c2' } })
    expect(await screen.findByText(/could not apply that filter/i)).toBeInTheDocument()
    expect(screen.queryByText(/no entries match that filter/i)).toBeNull()
  })
})

describe('admin code requests', () => {
  const OPEN = { id: 'r1', partnerId: 'p9', partnerName: 'Ann', partnerEmail: 'ann@x.co', wantedCode: 'ANNNEWS', note: 'for my newsletter', status: 'OPEN', createdAt: '2026-10-20T10:00:00Z' }
  const routes = () => ({
    '/partners': { data: { payoutDetailsHoldHours: 48, termsBlockPayout: false, data: [] } },
    '/partners/code-requests?status=OPEN&limit=50': { data: { data: [OPEN], total: 1 } },
  })
  it('lists the request and marks it done', async () => {
    api.get.mockImplementation(url => Promise.resolve(routes()[url] || { data: { data: [] } }))
    api.post.mockResolvedValue({ data: { success: true } })
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    const box = await screen.findByTestId('code-requests')
    expect(box).toHaveTextContent('Ann')
    expect(box).toHaveTextContent('ANNNEWS')
    expect(box).toHaveTextContent('for my newsletter')
    fireEvent.click(screen.getByRole('button', { name: /mark done/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/code-requests/r1/resolve', { status: 'DONE' }))
  })
  it('renders nothing when there are none', async () => {
    api.get.mockImplementation(() => Promise.resolve({ data: { data: [] } }))
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(screen.queryByTestId('code-requests')).toBeNull()
  })
})
