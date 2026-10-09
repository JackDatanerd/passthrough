// @vitest-environment jsdom
// Section 4 round 6 — admin partner page: the server-enforced hold after a payout-details change, the mixed-currency
// warning, and what the resend toast / clipboard do.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDetail from '../src/pages/admin/PartnerDetail'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const base = {
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commissionRate: 0.2, currency: 'USD',
  payoutMethod: 'BANK', payoutDetails: { bankName: 'Old Bank', accountName: 'K', accountNumber: '11112222' },
  payoutDetailsSubmittedAt: '2026-01-01T10:00:00.000Z', payoutDetailsHoldHours: 48,
  pendingCommissionCents: 1000, heldCents: 0, readyToPayCents: 1000, creditCents: 0, netConversions: 3,
  referralCodes: [], payouts: [], commissionLedger: [], olderUnpaidCents: 0,
  cyclesSummary: [{ key: '2026-09-A', label: 'Sep 1–15', start: '2026-09-01T00:00:00.000Z', end: '2026-09-15T23:59:59.999Z',
    isCurrent: false, ledgerCount: 2, commissionCents: 1000, unpaidCents: 1000, heldCents: 0, paidCents: 0 }],
}
const mount = over => {
  api.get.mockResolvedValue({ data: { data: { ...base, ...over } } })
  return render(<MemoryRouter initialEntries={['/admin/partners/p1']}><Routes><Route path="/admin/partners/:id" element={<PartnerDetail />} /></Routes></MemoryRouter>)
}
const openPayModal = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /cycles & payouts/i }))
  fireEvent.click(await screen.findByRole('button', { name: /^Pay \$10\.00$/ }))
  return screen.findByRole('dialog')
}
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString()
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('RecordPayoutModal — hold after a payout-details change', () => {
  it('inside the hold window it asks for the confirmation and will not call the API without it', async () => {
    mount({ payoutDetailsSubmittedAt: hoursAgo(2) })
    const dialog = await openPayModal()
    expect(within(dialog).getByTestId('details-hold').textContent).toMatch(/within the last 48 hours/)
    fireEvent.click(within(dialog).getByRole('button', { name: /mark paid & notify/i }))
    expect(await within(dialog).findByText(/confirm the change with Coach K and tick the box/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('ticking it sends confirmedWithPartner: true', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: {}, emailed: true } })
    mount({ payoutDetailsSubmittedAt: hoursAgo(2) })
    const dialog = await openPayModal()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I confirmed the change with Coach K/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /mark paid & notify/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][0]).toBe('/partners/p1/payouts')
    expect(api.post.mock.calls[0][1]).toMatchObject({ amountCents: 1000, confirmedWithPartner: true })
  })

  it('outside the window there is no hold box and nothing extra is sent', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: {}, emailed: true } })
    mount()
    const dialog = await openPayModal()
    expect(within(dialog).queryByTestId('details-hold')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: /mark paid & notify/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('confirmedWithPartner')
  })

  it('a hold of 0 hours (turned off on the server) never shows the box, even for a change a minute ago', async () => {
    mount({ payoutDetailsSubmittedAt: hoursAgo(0.01), payoutDetailsHoldHours: 0 })
    const dialog = await openPayModal()
    expect(within(dialog).queryByTestId('details-hold')).toBeNull()
  })
})

describe('mixed currency', () => {
  it('warns when unpaid commission spans more than one currency', async () => {
    mount({ mixedCurrency: true, unpaidCurrencies: ['KES', 'USD'] })
    expect((await screen.findByTestId('mixed-currency')).textContent).toMatch(/KES, USD/)
  })
  it('says nothing otherwise', async () => {
    mount({ mixedCurrency: false, unpaidCurrencies: ['USD'] })
    await screen.findByText('Coach K')
    expect(screen.queryByTestId('mixed-currency')).toBeNull()
  })
})

describe('resend payout-details link', () => {
  const writeText = vi.fn(() => Promise.resolve())
  beforeEach(() => { writeText.mockClear(); Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true }) })

  it('a successful send does NOT touch the clipboard (the server no longer returns the write-token URL)', async () => {
    api.post.mockResolvedValue({ data: { success: true, message: 'Link re-sent.' } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /resend payout-details link/i }))
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast.mock.calls[0][0]).toMatchObject({ type: 'success', message: 'Payout link re-sent to Coach K.' })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('a failed send shows the server\'s reason and copies the link instead', async () => {
    api.post.mockResolvedValue({ data: { success: false, message: 'Email not sent — it hit this partner\'s 4-per-hour limit.', payoutUrl: 'https://x/partner/payout-details?token=T' } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /resend payout-details link/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x/partner/payout-details?token=T'))
    expect(toast.mock.calls[0][0]).toMatchObject({ type: 'warning' })
    expect(toast.mock.calls[0][0].message).toMatch(/4-per-hour limit.*copied to your clipboard/)
  })
})
