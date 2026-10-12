// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import AdminDashboard from '../../src/pages/admin/AdminDashboard'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn() },
  getErrorMessage: (e, fallback) => e?.response?.data?.message || fallback,
}))

// Shared frontend round 8: the dashboard crashed when the Worker had no price table for the active currency
// (promo.standardCents is null), and formatted every figure as dollars whatever the currency.
const payload = (over = {}) => ({ data: { success: true, data: {
  currency: 'KES', otherCurrency: { payments: 0, ledgerRows: 0 },
  revenue: { todayCents: 150000, weekCents: 0, monthCents: 0, monthPartialRefundsCents: 0 },
  totalPendingCommissionCents: 5000, webhookHealth: null,
  promo: { active: false, endsAt: null, standardCents: { FIX: 100000, BADGE: 50000, FIX_PLAIN: 70000 }, promoCents: null, priceTableMissing: false },
  openItems: { erroredScansThisWeek: 0, stuckScans: 0, stalePendingPayments: 0, webhookEventsNeedingAttention: 0, leadsThisWeek: 0, newLeads: 0 },
  recentAlerts: [], ...over } } })
const renderIt = () => render(<MemoryRouter><AdminDashboard /></MemoryRouter>)

beforeEach(() => api.get.mockReset())

describe('AdminDashboard', () => {
  it('formats money in the Worker\'s currency, not dollars', async () => {
    api.get.mockResolvedValue(payload())
    renderIt()
    expect(await screen.findByText('1,500.00 KES')).toBeInTheDocument()
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('shows a clear error instead of crashing when there is no price table', async () => {
    api.get.mockResolvedValue(payload({ promo: { active: false, endsAt: null, standardCents: null, promoCents: null, priceTableMissing: true } }))
    renderIt()
    expect(await screen.findByText(/No price table for KES/)).toBeInTheDocument()
  })

  it('says what was left out when rows are in another currency', async () => {
    api.get.mockResolvedValue(payload({ otherCurrency: { payments: 2, ledgerRows: 1 } }))
    renderIt()
    expect(await screen.findByText(/Totals below count KES only/)).toBeInTheDocument()
  })
})
