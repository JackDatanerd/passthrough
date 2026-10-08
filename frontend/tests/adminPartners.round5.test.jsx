// @vitest-environment jsdom
// Section 4 round 5 — admin partner list: honest delivery warning on create, and the new
// cross-partner lookup (codes + payout history).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import AdminPartners from '../src/pages/admin/AdminPartners'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const routes = {
  '/partners': { data: { data: [] } },
  '/partners/applications?status=PENDING': { data: { data: [], reapplyCooldownDays: 45 } },
  '/partners/overview': { data: { data: { owedCents: 1234, paidOutCents: 500, lifetimeCommissionCents: 2000, pendingApplications: 2, activePartners: 1, partners: 3, currency: 'USD' } } },
  '/partners/codes': { data: { data: [{ id: 'rc1', partnerId: 'p1', code: 'COACH20', active: true, clicks: 7, usesSoFar: 2, usageLimit: 10, partnerName: 'Coach K', partnerEmail: 'k@x.co' }], total: 1 } },
}
const mount = () => render(<MemoryRouter><AdminPartners /></MemoryRouter>)
beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  api.get.mockImplementation(url => Promise.resolve(routes[url] || { data: { data: [] } }))
})

describe('AdminPartners', () => {
  it('warns — and copies the link — when the payout-details email did not send', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    api.post.mockResolvedValue({ data: { success: true, emailed: false, payoutUrl: 'https://x/payout?token=T' } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /add partner/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/name/i), { target: { value: 'Ann' } })
    fireEvent.change(within(dialog).getByLabelText(/email/i), { target: { value: 'ann@x.co' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /add & send link/i }))
    await waitFor(() => expect(toast).toHaveBeenCalled())
    const arg = toast.mock.calls[0][0]
    expect(arg.type).toBe('warning')
    expect(arg.message).toMatch(/did NOT send/)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x/payout?token=T'))
  })

  it('shows platform totals', async () => {
    mount()
    const strip = await screen.findByTestId('partners-overview')
    expect(within(strip).getByText('$12.34')).toBeTruthy()
    expect(within(strip).getByText('2')).toBeTruthy()
  })

  it('looks a code up across partners and links to its owner', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /find a code/i }))
    expect(await screen.findByText('COACH20')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Coach K' }).getAttribute('href')).toBe('/admin/partners/p1')
    fireEvent.change(screen.getByLabelText(/find a referral code/i), { target: { value: 'coa' } })
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/partners/codes', { params: expect.objectContaining({ q: 'coa' }) }))
  })

  it('fetches PENDING applications once on mount (it used to fetch twice)', async () => {
    mount()
    await screen.findByRole('button', { name: /add partner/i })
    await new Promise(r => setTimeout(r, 30))
    expect(api.get.mock.calls.filter(c => c[0] === '/partners/applications?status=PENDING')).toHaveLength(1)
  })
})
