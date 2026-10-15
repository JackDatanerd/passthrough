// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminPayments from '../../src/pages/admin/AdminPayments'
import AdminUsers from '../../src/pages/admin/AdminUsers'
import AdminWebhooks from '../../src/pages/admin/AdminWebhooks'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks section, round 14: G2 dispute actions, G3 payment history + duration, G1 bounced-account tag.
const pay = (over = {}) => ({
  id: 'p1', paystackRef: 'ref1', userEmail: 'a@b.co', amountCents: 2900, currency: 'USD',
  status: 'DISPUTED', fixTier: 'FIX', referralCode: null, createdAt: '2026-09-27T10:00:00Z', disputedAt: '2026-09-28T10:00:00Z', ...over,
})
const page = rows => ({ data: { data: rows, meta: { total: rows.length, page: 1, pageSize: 25 } } })
const wrap = el => render(<MemoryRouter><ToastProvider>{el}</ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminPayments — answer a dispute (G2)', () => {
  it('offers Send evidence and Accept dispute on a DISPUTED row only', async () => {
    api.get.mockResolvedValue(page([pay(), pay({ id: 'p2', paystackRef: 'ref2', status: 'SUCCESS' })]))
    wrap(<AdminPayments />)
    await screen.findByText('ref1')
    expect(screen.getAllByRole('button', { name: 'Accept dispute' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Send evidence' })).toHaveLength(1)
  })
  it('accepting asks for confirmation, then posts to the dispute endpoint', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(page([pay()]))
    api.post.mockResolvedValue({ data: { success: true, message: 'Dispute accepted with Paystack.' } })
    wrap(<AdminPayments />)
    await user.click(await screen.findByRole('button', { name: 'Accept dispute' }))
    expect(api.post).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /confirm|yes|accept/i }))
    expect(api.post).toHaveBeenCalledWith('/admin/payments/ref1/dispute/accept', {})
  })
  it('evidence needs a phone number locally, then posts it', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(page([pay()]))
    api.post.mockResolvedValue({ data: { success: true, message: 'Evidence sent to Paystack.' } })
    wrap(<AdminPayments />)
    await user.click(await screen.findByRole('button', { name: 'Send evidence' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Send evidence' }))
    expect(api.post).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('alert').textContent).toMatch(/phone/i)
    await user.type(within(dialog).getByLabelText(/phone/i), '+254 700 000000')
    await user.click(within(dialog).getByRole('button', { name: 'Send evidence' }))
    expect(api.post).toHaveBeenCalledWith('/admin/payments/ref1/dispute/evidence', { customerPhone: '+254 700 000000', serviceDetails: undefined })
  })
})

describe('AdminPayments — webhook history (G3)', () => {
  it('shows the payment\'s events with how long each took', async () => {
    const user = userEvent.setup()
    api.get.mockImplementation(async url => url.includes('/webhook-events')
      ? { data: { data: [{ id: 'e1', eventType: 'charge.success', status: 'PROCESSED', attempts: 1, receivedAt: '2026-09-27T10:00:00Z', processingMs: 412, note: 'FULFILLED' }] } }
      : page([pay({ status: 'SUCCESS' })]))
    wrap(<AdminPayments />)
    await user.click(await screen.findByRole('button', { name: 'History' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('charge.success')).toBeTruthy()
    expect(within(dialog).getByText('412 ms')).toBeTruthy()
    expect(api.get).toHaveBeenCalledWith('/admin/payments/ref1/webhook-events')
  })
})

describe('AdminWebhooks — duration (G3)', () => {
  it('shows how long an event took and marks a slow one', async () => {
    api.get.mockImplementation(async url => url.includes('health')
      ? { data: { data: {} } }
      : { data: { data: [
          { id: 'a', provider: 'paystack', eventType: 'charge.success', eventKey: 'k1', reference: 'r1', status: 'PROCESSED', attempts: 1, processingMs: 850, receivedAt: '2026-09-27T10:00:00Z' },
          { id: 'b', provider: 'paystack', eventType: 'refund.processed', eventKey: 'k2', reference: 'r2', status: 'PROCESSED', attempts: 2, processingMs: 24500, receivedAt: '2026-09-27T10:00:00Z' },
        ], meta: { total: 2, page: 1, pageSize: 25 } } })
    wrap(<AdminWebhooks />)
    expect(await screen.findByText('850 ms')).toBeTruthy()
    expect(screen.getByText('24.5 s').className).toMatch(/red/)
  })
})

describe('AdminUsers — undeliverable email (G1)', () => {
  it('tags an account whose address bounces and can filter to them', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(page([
      { id: 'u1', email: 'a@b.co', name: 'A', role: 'SEEKER', status: 'ACTIVE', emailVerified: true, emailBounce: { type: 'complaint', at: '2026-09-27T10:00:00Z' } },
      { id: 'u2', email: 'c@d.co', name: 'C', role: 'SEEKER', status: 'ACTIVE', emailVerified: true, emailBounce: null },
    ]))
    wrap(<AdminUsers />)
    expect(await screen.findByText('spam complaint')).toBeTruthy()
    await user.click(screen.getByLabelText('Email undeliverable'))
    expect(api.get).toHaveBeenLastCalledWith('/admin/users', { params: expect.objectContaining({ bounced: '1' }) })
  })
})
