// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import AdminPartners from '../src/pages/admin/AdminPartners'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))
vi.mock('../src/lib/utils', async () => ({ ...(await vi.importActual('../src/lib/utils')), downloadCsv: vi.fn() }))

// Partners round 40 (admin): the tax summary has a year picker, and "Ready to pay now" only counts what the payout run can pay.

const OLD = '2026-01-01T10:00:00.000Z'
const mk = (id, name, cents, over = {}) => ({
  id, name, email: `${id}@x.co`, status: 'ACTIVE', commissionRate: 0.2, currency: 'USD', createdAt: OLD, termsCurrent: true,
  readyToPayCents: cents, currentCycleAccruedCents: 0, currentCycleLabel: 'Oct 1–15', payoutMethod: 'BANK',
  payoutDetails: { bankName: 'B', accountName: name, accountNumber: '0012345678' }, payoutDetailsSubmittedAt: OLD, ...over,
})
const routes = list => ({
  '/partners': { data: { payoutDetailsHoldHours: 48, data: list } },
  '/partners/applications?status=PENDING&limit=50&offset=0': { data: { data: [], reapplyCooldownDays: 30 } },
  '/partners/overview': { data: { data: { owedCents: 0, paidOutCents: 0, lifetimeCommissionCents: 0, pendingApplications: 0, activePartners: 1, partners: 1, currency: 'USD' } } },
  '/partners/codes': { data: { data: [], total: 0 } },
})
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('tax summary year picker', () => {
  it('requests the year that was picked', async () => {
    api.get.mockImplementation(url => Promise.resolve(
      routes([mk('a1', 'Ann', 1000)])[url] || (url.startsWith('/partners/tax-summary') ? { data: { data: [] } } : { data: { data: [] } })))
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    const picker = await screen.findByTestId('tax-summary-year')
    const years = [...picker.querySelectorAll('option')].map(o => Number(o.value))
    expect(years.length).toBeGreaterThan(1)
    const older = years[years.length - 1]
    fireEvent.change(picker, { target: { value: String(older) } })
    fireEvent.click(screen.getByTestId('tax-summary'))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/partners/tax-summary?year=${older}`))
  })
})

describe('Ready to pay now', () => {
  it('leaves out partners with no payout details and says so', async () => {
    const list = [mk('a1', 'Ann', 4500), mk('b2', 'Ben', 2500, { payoutMethod: null, payoutDetails: null })]
    api.get.mockImplementation(url => Promise.resolve(routes(list)[url] || { data: { data: [] } }))
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    const note = await screen.findByTestId('ready-not-payable')
    expect(note.textContent).toMatch(/25\.00/)
    expect(screen.getAllByText(/45\.00/).length).toBeGreaterThan(0)
    expect(note.textContent).not.toMatch(/70\.00/)
  })
})
