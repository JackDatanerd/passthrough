// @vitest-environment jsdom
// Section 4 round 6: the dashboard shows what the next payout will actually be, can page through every conversion
// (it used to cap at 50 with no way to see the rest) and can export them.
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

const cv = (i, over = {}) => ({ id: `c${i}`, code: 'COACH20', grossAmountCents: 1000, commissionRate: 0.2, commissionAmountCents: 200, paid: false, isReversal: false, createdAt: `2026-09-${String(10 + (i % 15)).padStart(2, '0')}T10:00:00Z`, ...over })
const base = {
  name: 'Coach K', active: true, commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, payoutMethod: 'BANK', scope: 'dashboard',
  stats: { totalClicks: 5, totalConversions: 3, pendingCents: 600, paidCents: 0 }, referralCodes: [], payouts: [], cyclesSummary: [],
  olderUnpaidCents: 0, carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0, readyToPayCents: 0, creditCents: 0,
  conversions: [cv(1), cv(2), cv(3)], conversionsTotal: 3,
}
function mount(over = {}) {
  api.get.mockImplementation(url => (url.startsWith('/partners/dashboard')
    ? Promise.resolve({ data: { data: { ...base, ...over } } })
    : Promise.reject(new Error(`unexpected GET ${url}`))))
  return render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
}
beforeEach(() => { cleanup(); api.get.mockReset(); api.post.mockReset(); csv.calls.length = 0 })

describe('ready to pay / refund credit', () => {
  it('shows what the next payout run will pay', async () => {
    mount({ readyToPayCents: 4500 })
    expect((await screen.findByTestId('ready-to-pay')).textContent).toMatch(/\$45\.00.*ready to be paid/)
    expect(screen.queryByTestId('refund-credit')).toBeNull()
  })
  it('shows a refund credit that will net against the next payout', async () => {
    mount({ creditCents: 700 })
    expect((await screen.findByTestId('refund-credit')).textContent).toMatch(/\$7\.00/)
    expect(screen.queryByTestId('ready-to-pay')).toBeNull()
  })
  it('shows neither when there is nothing to say', async () => {
    mount()
    await screen.findByRole('heading', { name: 'Conversions' })
    expect(screen.queryByTestId('ready-to-pay')).toBeNull()
    expect(screen.queryByTestId('refund-credit')).toBeNull()
  })
})

describe('conversions paging', () => {
  it('no "Load more" when everything is already shown', async () => {
    mount()
    await screen.findByRole('heading', { name: 'Conversions' })
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('loads the next page from the offset it has reached and appends it, never duplicating a row', async () => {
    mount({ conversionsTotal: 5 })
    const more = await screen.findByRole('button', { name: /load more/i })
    expect(screen.getByText(/showing 3 of 5 entries/i)).toBeTruthy()
    api.get.mockImplementation(url => (url.startsWith('/partners/conversions')
      ? Promise.resolve({ data: { success: true, total: 5, data: [cv(3), cv(4), cv(5)] } })   // c3 repeats (a new sale shifted the window)
      : Promise.reject(new Error('x'))))
    fireEvent.click(more)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/partners/conversions?limit=50&offset=3', { headers: { 'X-Partner-Token': 'TOK' } }))
    await waitFor(() => expect(screen.getAllByText('COACH20')).toHaveLength(5))
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
    // 3 initial + c4, c5 — the repeated c3 was not rendered twice
    expect(screen.getAllByText('COACH20')).toHaveLength(5)
  })

  it('a failed page says so and keeps the button', async () => {
    mount({ conversionsTotal: 5 })
    const more = await screen.findByRole('button', { name: /load more/i })
    api.get.mockRejectedValue(new Error('429'))
    fireEvent.click(more)
    expect(await screen.findByText(/could not load more/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy()
  })
})

describe('CSV export', () => {
  it('walks every page and writes one row per conversion, with reversals labelled', async () => {
    mount({ conversionsTotal: 3 })
    const pages = [Array.from({ length: 200 }, (_, i) => cv(i + 1)), [cv(500, { isReversal: true, commissionAmountCents: -200, grossAmountCents: -1000 })]]
    let n = 0
    api.get.mockImplementation(url => (url.startsWith('/partners/conversions')
      ? Promise.resolve({ data: { success: true, data: pages[n++] || [] } }) : Promise.reject(new Error('x'))))
    fireEvent.click(await screen.findByRole('button', { name: /download csv/i }))
    await waitFor(() => expect(csv.calls).toHaveLength(1))
    const urls = api.get.mock.calls.map(c => c[0]).filter(u => u.startsWith('/partners/conversions'))
    expect(urls).toEqual(['/partners/conversions?limit=200&offset=0', '/partners/conversions?limit=200&offset=200'])
    const [filename, rows] = csv.calls[0]
    expect(filename).toMatch(/^passthrough-conversions-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(rows[0]).toEqual(['Date (UTC)', 'Code', 'Type', 'Sale', 'Commission rate', 'Commission', 'Status', 'Note', 'Currency'])
    expect(rows).toHaveLength(1 + 201)
    expect(rows.at(-1)).toEqual(['2026-09-15', 'COACH20', 'Refund reversal', -10, '20%', -2, 'Reversal', '', 'USD'])
    expect(rows[1].slice(2)).toEqual(['Sale', 10, '20%', 2, 'Pending', '', 'USD'])
  })

  it('a failed export says so and writes nothing', async () => {
    mount()
    api.get.mockRejectedValue(new Error('boom'))
    fireEvent.click(await screen.findByRole('button', { name: /download csv/i }))
    expect(await screen.findByText(/could not build the csv/i)).toBeTruthy()
    expect(csv.calls).toHaveLength(0)
  })

  it('no export button when there is nothing to export', async () => {
    mount({ conversions: [], conversionsTotal: 0 })
    await screen.findByText(/no conversions yet/i)
    expect(screen.queryByRole('button', { name: /download csv/i })).toBeNull()
  })
})
