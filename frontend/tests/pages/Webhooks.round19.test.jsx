// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminPayments from '../../src/pages/admin/AdminPayments'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 19 (G2): an answered dispute shows its state and stops offering the answers already given.
const pay = (over = {}) => ({
  id: 'p1', paystackRef: 'ref1', userEmail: 'a@b.co', amountCents: 2900, currency: 'USD', status: 'DISPUTED', fixTier: 'FIX',
  referralCode: null, createdAt: '2026-09-27T10:00:00Z', disputedAt: '2026-09-28T10:00:00Z',
  disputeDueAt: new Date(Date.now() + 3 * 3600_000).toISOString(), ...over,
})
const show = async row => {
  api.get.mockResolvedValue({ data: { data: [row], meta: { total: 1, page: 1, pageSize: 25 } } })
  render(<MemoryRouter><ToastProvider><AdminPayments /></ToastProvider></MemoryRouter>)
  await screen.findByText('ref1')
}
beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminPayments — answered disputes (G2)', () => {
  it('unanswered: countdown and all three answers are offered', async () => {
    await show(pay())
    expect(screen.getByRole('button', { name: 'Contest dispute' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Accept dispute' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send evidence' })).toBeTruthy()
  })
  it('contested: says so, hides the countdown and the answers, keeps Clear / Reverse', async () => {
    await show(pay({ disputeAnswer: 'contested', disputeAnsweredAt: '2026-09-28T12:00:00Z' }))
    expect(screen.getByText(/Contested with proof of delivery/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Contest dispute' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept dispute' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send evidence' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Clear dispute' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reverse' })).toBeTruthy()
  })
  it('resolved by Paystack but waiting on a person: explains the next step', async () => {
    await show(pay({ disputeAnswer: 'resolved' }))
    expect(screen.getByText(/needs your decision/)).toBeTruthy()
  })
})
