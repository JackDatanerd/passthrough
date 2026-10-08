// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminPayments from '../../src/pages/admin/AdminPayments'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Payments & Pricing round 2 (G2): POST /payments/:reference/refund was built and
// routed but had no button anywhere.
const row = (over = {}) => ({
  id: 'p1', paystackRef: 'ref1', userEmail: 'a@b.co', amountCents: 4900, currency: 'USD',
  status: 'SUCCESS', fixTier: 'FIX', referralCode: null, createdAt: '2026-09-27T10:00:00Z', ...over,
})
const listOf = rows => ({ data: { data: rows, meta: { total: rows.length } } })
const renderPage = () => render(<MemoryRouter><ToastProvider><AdminPayments /></ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminPayments — refund', () => {
  it('offers Refund on a paid SUCCESS row only', async () => {
    api.get.mockResolvedValue(listOf([
      row(),
      row({ id: 'p2', paystackRef: 'ref2', status: 'PENDING' }),
      row({ id: 'p3', paystackRef: 'credit:s1:1', amountCents: 0 }),
      row({ id: 'p4', paystackRef: 'ref4', status: 'REFUNDED' }),
    ]))
    renderPage()
    await screen.findByText('ref1')
    expect(screen.getAllByRole('button', { name: 'Refund' })).toHaveLength(1)
  })

  it('a blank amount queues a FULL refund (no amountCents sent)', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(listOf([row()]))
    api.post.mockResolvedValue({ data: { success: true, message: 'Refund queued with Paystack.' } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Refund' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Queue refund' }))
    expect(api.post).toHaveBeenCalledWith('/payments/ref1/refund', { amountCents: undefined, note: undefined })
  })

  it('converts a typed dollar amount to cents and sends the note', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(listOf([row()]))
    api.post.mockResolvedValue({ data: { success: true, message: 'Partial refund queued.' } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Refund' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Amount/), '12.34')
    await user.type(within(dialog).getByLabelText(/Note/), 'goodwill')
    await user.click(within(dialog).getByRole('button', { name: 'Queue refund' }))
    expect(api.post).toHaveBeenCalledWith('/payments/ref1/refund', { amountCents: 1234, note: 'goodwill' })
  })

  it('refuses an amount above what was paid, locally, without calling the API', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(listOf([row()]))
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Refund' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Amount/), '99')
    await user.click(within(dialog).getByRole('button', { name: 'Queue refund' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/more than the/)
    expect(api.post).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the server\'s reason when Paystack/the guard refuses', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(listOf([row()]))
    api.post.mockRejectedValue({ response: { data: { message: 'A refund for this payment is already in progress on Paystack.' } } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Refund' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Queue refund' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already in progress/)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

// Webhooks round 5: partial refunds are visible, and the list can be searched by reference.
describe('AdminPayments — round 5', () => {
  it('shows how much of a still-SUCCESS payment has been refunded so far', async () => {
    api.get.mockResolvedValue(listOf([row({ refundedCents: 1200 }), row({ id: 'p2', paystackRef: 'ref2', refundedCents: 0 })]))
    renderPage()
    expect(await screen.findByText(/Partially refunded \$12\.00 of \$49\.00/)).toBeTruthy()
    expect(screen.getAllByText(/Partially refunded/)).toHaveLength(1)
  })

  it('searches by reference and links a payment to its webhook events', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(listOf([row()]))
    renderPage()
    const link = await screen.findByRole('link', { name: 'Webhook events' })
    expect(link.getAttribute('href')).toBe('/admin/webhooks?reference=ref1')
    await user.type(screen.getByLabelText('Payment reference'), ' ref1 ')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await vi.waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin/payments', { params: { page: 1, pageSize: 25, status: undefined, reference: 'ref1' } }))
  })

  it('does not offer a webhook-events link for a free-credit redemption', async () => {
    api.get.mockResolvedValue(listOf([row({ paystackRef: 'credit:s1:1', amountCents: 0 })]))
    renderPage()
    await screen.findByText(/credit:s1:1/)
    expect(screen.queryByRole('link', { name: 'Webhook events' })).toBeNull()
  })
})
