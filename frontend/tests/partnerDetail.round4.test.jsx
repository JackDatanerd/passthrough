// @vitest-environment jsdom
// Section 4 round 4 — admin partner page: (B4) a payout-details conflict must leave the modal
// open with its error after the silent reload, (G5) the dashboard/payout link buttons.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDetail from '../src/pages/admin/PartnerDetail'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')   // useApi needs the real one
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const partner = {
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commissionRate: 0.2, currency: 'USD',
  payoutMethod: 'BANK', payoutDetails: { bankName: 'Old Bank', accountName: 'K', accountNumber: '11112222' },
  payoutDetailsSubmittedAt: '2026-09-01T10:00:00.000Z', pendingCommissionCents: 1000, heldCents: 0, readyToPayCents: 1000,
  creditCents: 0, netConversions: 3, referralCodes: [], payouts: [], commissionLedger: [],
  cyclesSummary: [{ key: '2026-09-A', label: 'Sep 1–15', start: '2026-09-01T00:00:00.000Z', end: '2026-09-15T23:59:59.999Z',
    isCurrent: false, ledgerCount: 2, commissionCents: 1000, unpaidCents: 1000, heldCents: 0, paidCents: 0 }],
  olderUnpaidCents: 0, website: 'https://k.test', audience: 'Career newsletter',
}
const mount = () => render(
  <MemoryRouter initialEntries={['/admin/partners/p1']}>
    <Routes><Route path="/admin/partners/:id" element={<PartnerDetail />} /></Routes>
  </MemoryRouter>)

describe('PartnerDetail', () => {
  beforeEach(() => { cleanup(); vi.clearAllMocks(); api.get.mockImplementation(url =>
    url === '/partners/p1/links'
      ? Promise.resolve({ data: { data: { dashboardUrl: 'https://app.test/partner/dashboard?token=DASH', payoutUrl: 'https://app.test/partner/payout-details?token=WRITE' } } })
      : Promise.resolve({ data: { data: partner } })) })

  it('shows what the applicant told us (website / audience)', async () => {
    mount()
    expect(await screen.findByText(/Career newsletter/)).toBeTruthy()
    expect(screen.getByText(/https:\/\/k\.test/)).toBeTruthy()
  })

  it('"Copy dashboard link" fetches the links on demand and copies the READ-ONLY one', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /copy dashboard link/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://app.test/partner/dashboard?token=DASH'))
    expect(api.get).toHaveBeenCalledWith('/partners/p1/links')
  })

  it('B4: a PAYOUT_DETAILS_CHANGED conflict reloads silently — the modal stays open and shows why nothing was recorded', async () => {
    api.post.mockRejectedValue({ response: { data: { success: false, code: 'PAYOUT_DETAILS_CHANGED', message: 'The partner changed their payout details — review them and try again.' } } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /cycles & payouts/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^Pay \$10\.00$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /mark paid & notify/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    // the partner was re-fetched (the reload happened) …
    await waitFor(() => expect(api.get.mock.calls.filter(c => c[0] === '/partners/p1').length).toBeGreaterThanOrEqual(2))
    // … yet the modal is still there with the reason, not swapped for a spinner
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(await screen.findByText(/changed their payout details/i)).toBeTruthy()
  })
})
