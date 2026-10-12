// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import AdminDashboard from '../../src/pages/admin/AdminDashboard'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 12 (W3): the dashboard banner counts `unrecovered` sales, not the raw `paidWithoutEvent` figure.
const payload = webhookHealth => ({
  revenue: { todayCents: 0, weekCents: 0, monthCents: 0, monthPartialRefundsCents: 0 },
  totalPendingCommissionCents: 0,
  promo: { active: false, endsAt: null, standardCents: { FIX: 1, BADGE: 1, FIX_PLAIN: 1 }, promoCents: { FIX: 1, BADGE: 1, FIX_PLAIN: 1 } },
  openItems: { erroredScansThisWeek: 0, stuckScans: 0, stalePendingPayments: 0, webhookEventsNeedingAttention: 0, newLeads: 0, leadsThisWeek: 0 },
  recentAlerts: [],
  webhookHealth,
})
const renderIt = async health => {
  api.get.mockResolvedValue({ data: { data: payload(health) } })
  render(<MemoryRouter><AdminDashboard /></MemoryRouter>)
  await screen.findByText('Needs attention')
}

beforeEach(() => api.get.mockReset())

describe('AdminDashboard — webhook banner (round 12)', () => {
  it('stays hidden when nothing is unrecovered, even if paidWithoutEvent is positive', async () => {
    await renderIt({ available: true, paidWithoutEvent: 4, unrecovered: 0 })
    expect(screen.queryByText(/no Paystack webhook on record/)).toBeNull()
  })
  it('shows the unrecovered count', async () => {
    await renderIt({ available: true, paidWithoutEvent: 4, unrecovered: 1 })
    expect(screen.getByText(/1 paid sale has no Paystack webhook on record/)).toBeTruthy()
  })
  it('falls back to paidWithoutEvent when the API predates `unrecovered`', async () => {
    await renderIt({ available: true, paidWithoutEvent: 3 })
    expect(screen.getByText(/3 paid sales have no Paystack webhook on record/)).toBeTruthy()
  })
})
