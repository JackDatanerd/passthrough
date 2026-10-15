// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminPayments from '../../src/pages/admin/AdminPayments'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks section, round 15, G1: contest a dispute from Admin → Payments.
const pay = (over = {}) => ({
  id: 'p1', paystackRef: 'ref1', userEmail: 'a@b.co', amountCents: 2900, currency: 'USD',
  status: 'DISPUTED', fixTier: 'FIX', referralCode: null, createdAt: '2026-09-27T10:00:00Z', disputedAt: '2026-09-28T10:00:00Z', ...over,
})
const page = rows => ({ data: { data: rows, meta: { total: rows.length, page: 1, pageSize: 25 } } })
const wrap = el => render(<MemoryRouter><ToastProvider>{el}</ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminPayments — contest a dispute (round 15 G1)', () => {
  it('offers Contest dispute on a DISPUTED row only', async () => {
    api.get.mockResolvedValue(page([pay(), pay({ id: 'p2', paystackRef: 'ref2', status: 'SUCCESS' })]))
    wrap(<AdminPayments />)
    await screen.findByText('ref1')
    expect(screen.getAllByRole('button', { name: 'Contest dispute' })).toHaveLength(1)
  })
  it('asks for confirmation, then posts to the contest endpoint', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(page([pay()]))
    api.post.mockResolvedValue({ data: { success: true, message: 'Dispute contested with Paystack.' } })
    wrap(<AdminPayments />)
    await user.click(await screen.findByRole('button', { name: 'Contest dispute' }))
    expect(api.post).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/proof of delivery/i)
    await user.click(within(dialog).getByRole('button', { name: /confirm|yes|contest/i }))
    expect(api.post).toHaveBeenCalledWith('/admin/payments/ref1/dispute/contest', {})
  })
  it('shows the server\'s reason when it refuses (nothing delivered)', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(page([pay()]))
    api.post.mockRejectedValue({ response: { data: { message: 'The work for this payment was not delivered — accept instead.' } } })
    wrap(<AdminPayments />)
    await user.click(await screen.findByRole('button', { name: 'Contest dispute' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /confirm|yes|contest/i }))
    expect(await screen.findByText(/not delivered/i)).toBeTruthy()
  })
})
