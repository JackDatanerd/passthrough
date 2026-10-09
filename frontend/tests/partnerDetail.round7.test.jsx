// @vitest-environment jsdom
// Section 4 round 7 (feature gap) — remove a partner's personal data from the admin page.
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
  payoutMethod: null, payoutDetails: null, payoutDetailsSubmittedAt: null, payoutDetailsHoldHours: 48,
  pendingCommissionCents: 0, heldCents: 0, readyToPayCents: 0, creditCents: 0, netConversions: 0,
  referralCodes: [], payouts: [], commissionLedger: [], olderUnpaidCents: 0, cyclesSummary: [],
}
const mount = over => {
  api.get.mockResolvedValue({ data: { data: { ...base, ...over } } })
  return render(<MemoryRouter initialEntries={['/admin/partners/p1']}><Routes><Route path="/admin/partners/:id" element={<PartnerDetail />} /></Routes></MemoryRouter>)
}
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('Remove personal data', () => {
  it('needs a reason and the partner name typed before it can be sent, then posts to /anonymize', async () => {
    api.post.mockResolvedValue({ data: { success: true, message: 'Partner data removed.' } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /remove personal data/i }))
    const dialog = await screen.findByRole('dialog')
    const submit = within(dialog).getByRole('button', { name: 'Remove data' })
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'erasure request by email' } })
    fireEvent.change(within(dialog).getByLabelText(/type "Coach K" to confirm/i), { target: { value: 'Coach' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/type "Coach K" to confirm/i), { target: { value: 'Coach K' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/p1/anonymize', { reason: 'erasure request by email' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })))
  })

  it('shows the server refusal (commission still owed) and keeps the dialog open', async () => {
    api.post.mockRejectedValue({ response: { status: 409, data: { message: 'This partner is still owed 500 cents of commission.' } } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /remove personal data/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'erasure request' } })
    fireEvent.change(within(dialog).getByLabelText(/type "Coach K" to confirm/i), { target: { value: 'Coach K' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove data' }))
    expect(await within(dialog).findByText(/still owed 500 cents/i)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('is not offered for a partner whose data is already removed', async () => {
    mount({ name: 'Removed partner', email: 'partner-p1@removed.invalid' })
    await screen.findByRole('button', { name: /resend payout-details link/i })
    expect(screen.queryByRole('button', { name: /remove personal data/i })).toBeNull()
  })
})
