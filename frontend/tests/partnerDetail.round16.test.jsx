// @vitest-environment jsdom
// Section 4 round 16: "Copy payout-details link" replaces the partner's live link, so it asks first; the conversions table shows each sale's tag.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDetail from '../src/pages/admin/PartnerDetail'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => vi.fn() }))

const partner = {
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commissionRate: 0.2, currency: 'USD',
  payoutMethod: 'BANK', payoutDetails: {}, pendingCommissionCents: 0, heldCents: 0, readyToPayCents: 0, creditCents: 0, netConversions: 0,
  referralCodes: [], payouts: [], commissionLedger: [], cyclesSummary: [], olderUnpaidCents: 0,
}
const mount = () => render(<MemoryRouter initialEntries={['/admin/partners/p1']}><Routes><Route path="/admin/partners/:id" element={<PartnerDetail />} /></Routes></MemoryRouter>)

describe('copying the payout-details link (round 16)', () => {
  beforeEach(() => {
    cleanup(); vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
    api.get.mockImplementation(url => String(url).startsWith('/partners/p1/links')
      ? Promise.resolve({ data: { data: { dashboardUrl: 'https://app.test/d', payoutUrl: 'https://app.test/partner/payout-details?token=NEW' } } })
      : Promise.resolve({ data: { data: partner } }))
  })
  it('does nothing until the admin confirms, then issues and copies the new link', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /copy payout-details link/i }))
    expect(await screen.findByText(/issues a NEW payout-details link/i)).toBeTruthy()
    expect(api.get.mock.calls.some(c => String(c[0]).includes('/links'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /issue and copy/i }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://app.test/partner/payout-details?token=NEW'))
  })
  it('cancelling leaves the partner\'s link alone', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /copy payout-details link/i }))
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))
    expect(api.get.mock.calls.some(c => String(c[0]).includes('/links'))).toBe(false)
  })
  it('the dashboard link copy needs no confirmation', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /copy dashboard link/i }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://app.test/d'))
  })
})
