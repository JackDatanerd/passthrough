// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminWebhooks from '../../src/pages/admin/AdminWebhooks'
import AdminDashboard from '../../src/pages/admin/AdminDashboard'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 17 (G1): deliveries that reach the app but are refused (bad/rotated signing key, blocked IP) are shown on the
// Webhooks page and the dashboard — only when the newest refusal is newer than the last delivery that got through.
const refused = (over = {}) => ({ available: true, paidChecked: 0, paidWithoutEvent: 0, unrecovered: 0, lastEventAt: null, lastChargeSuccessAt: null, lastResendEventAt: null,
  lastRejected: { paystack: { at: '2026-10-16T09:00:00Z', reason: 'signature' }, resend: null }, rejectedSinceLastEvent: ['paystack'], ...over })

function renderWebhooks(health) {
  api.get.mockImplementation(async url => url === '/admin/webhook-events/health'
    ? { data: { success: true, data: health } }
    : { data: { data: [], meta: { total: 0 } } })
  return render(<MemoryRouter initialEntries={['/admin/webhooks']}><ToastProvider><Routes><Route path="/admin/webhooks" element={<AdminWebhooks />} /></Routes></ToastProvider></MemoryRouter>)
}
const dashPayload = webhookHealth => ({
  revenue: { todayCents: 0, weekCents: 0, monthCents: 0, monthPartialRefundsCents: 0 }, totalPendingCommissionCents: 0,
  promo: { active: false, endsAt: null, standardCents: { FIX: 1, BADGE: 1, FIX_PLAIN: 1 }, promoCents: { FIX: 1, BADGE: 1, FIX_PLAIN: 1 } },
  openItems: { erroredScansThisWeek: 0, stuckScans: 0, stalePendingPayments: 0, webhookEventsNeedingAttention: 0, newLeads: 0, leadsThisWeek: 0 },
  recentAlerts: [], webhookHealth,
})

beforeEach(() => { api.get.mockReset() })

describe('AdminWebhooks — refused deliveries (round 17 G1)', () => {
  it('says Paystack deliveries are being refused and why (signature)', async () => {
    renderWebhooks(refused())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Paystack deliveries are being refused/)
    expect(alert.textContent).toMatch(/signature did not verify/)
  })
  it('names the blocked-IP reason', async () => {
    renderWebhooks(refused({ lastRejected: { paystack: { at: '2026-10-16T09:00:00Z', reason: 'ip' }, resend: null } }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/allow-list/)
  })
  it('can name both providers', async () => {
    renderWebhooks(refused({ lastRejected: { paystack: { at: '2026-10-16T09:00:00Z', reason: 'signature' }, resend: { at: '2026-10-16T09:30:00Z', reason: 'signature' } }, rejectedSinceLastEvent: ['paystack', 'resend'] }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Paystack deliveries/)
    expect(alert.textContent).toMatch(/Resend deliveries/)
  })
  it('shows nothing when no refusal is newer than the last accepted delivery, or the API predates the field', async () => {
    renderWebhooks(refused({ rejectedSinceLastEvent: [] }))
    await screen.findByText(/Last event received/)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('an older API without the field does not break the page', async () => {
    renderWebhooks({ available: true, paidChecked: 0, paidWithoutEvent: 0, unrecovered: 0, lastEventAt: null, lastChargeSuccessAt: null, lastResendEventAt: null })
    await screen.findByText(/Last event received/)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('AdminDashboard — refused deliveries (round 17 G1)', () => {
  const renderDash = async health => {
    api.get.mockResolvedValue({ data: { data: dashPayload(health) } })
    render(<MemoryRouter><AdminDashboard /></MemoryRouter>)
    await screen.findByText('Needs attention')
  }
  it('links to the Webhooks page when deliveries are being refused', async () => {
    await renderDash(refused())
    const link = await screen.findByText(/webhook deliveries are reaching this app but being refused/)
    expect(link.closest('a').getAttribute('href')).toBe('/admin/webhooks')
    expect(link.textContent).toMatch(/Paystack/)
  })
  it('stays hidden otherwise', async () => {
    await renderDash(refused({ rejectedSinceLastEvent: [] }))
    expect(screen.queryByText(/being refused/)).toBeNull()
  })
})
