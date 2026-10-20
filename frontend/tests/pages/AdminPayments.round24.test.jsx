// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminPayments from '../../src/pages/admin/AdminPayments'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 24 (G1): Paystack reported a refund of this payment as FAILED - the buyer's money is still held.
const row = (over = {}) => ({
  id: 'p1', paystackRef: 'ref1', userEmail: 'a@b.co', amountCents: 4900, currency: 'USD',
  status: 'SUCCESS', fixTier: 'FIX', referralCode: null, createdAt: '2026-09-27T10:00:00Z', ...over,
})
const listOf = rows => ({ data: { data: rows, meta: { total: rows.length } } })
const renderPage = () => render(<MemoryRouter><ToastProvider><AdminPayments /></ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminPayments — failed refund (round 24 G1)', () => {
  it('flags a SUCCESS payment whose refund failed, and only that one', async () => {
    api.get.mockResolvedValue(listOf([
      row({ refundFailedAt: '2026-10-19T09:00:00Z' }),
      row({ id: 'p2', paystackRef: 'ref2', refundFailedAt: null }),
    ]))
    renderPage()
    expect(await screen.findByText(/Refund failed/)).toBeTruthy()
    expect(screen.getAllByText(/Refund failed/)).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toMatch(/not been paid back/)
  })
  it('flags a DISPUTED payment too', async () => {
    api.get.mockResolvedValue(listOf([row({ status: 'DISPUTED', refundFailedAt: '2026-10-19T09:00:00Z', disputedAt: '2026-10-18T09:00:00Z' })]))
    renderPage()
    expect(await screen.findByText(/Refund failed/)).toBeTruthy()
  })
  it('does not flag a REFUNDED payment even if the field is present', async () => {
    api.get.mockResolvedValue(listOf([row({ status: 'REFUNDED', refundFailedAt: '2026-10-19T09:00:00Z' })]))
    renderPage()
    await screen.findByText('ref1')
    expect(screen.queryByText(/Refund failed/)).toBeNull()
  })
})
