// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminWebhooks from '../../src/pages/admin/AdminWebhooks'
import AdminPayments from '../../src/pages/admin/AdminPayments'
import AdminDashboard from '../../src/pages/admin/AdminDashboard'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 13: bulk Replay / Dismiss in the inbox (G4) and the dispute auto-accept deadline (G1).
const ev = (over = {}) => ({ id: 'e1', provider: 'paystack', eventType: 'charge.success', reference: 'ref-1', status: 'FAILED', attempts: 3,
  receivedAt: '2026-10-05T10:00:00Z', replayable: true, dismissable: true, error: 'boom', note: null, ...over })
const mockInbox = events => api.get.mockImplementation(async url =>
  url === '/admin/webhook-events/health' ? { data: { data: { available: false } } } : { data: { data: events, meta: { total: events.length } } })
const renderInbox = () => render(<MemoryRouter initialEntries={['/admin/webhooks']}><ToastProvider><Routes><Route path="/admin/webhooks" element={<AdminWebhooks />} /></Routes></ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminWebhooks — bulk actions (G4)', () => {
  const three = () => [ev(), ev({ id: 'e2', reference: 'ref-2' }), ev({ id: 'e3', reference: 'ref-3', status: 'PROCESSED', replayable: false, dismissable: false, error: null })]

  it('only rows that can be replayed or dismissed get a checkbox; select-all ticks just those', async () => {
    mockInbox(three()); renderInbox()
    await screen.findByText('ref-1')
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)             // header + 2 rows (the PROCESSED row has none)
    await userEvent.click(screen.getByRole('checkbox', { name: /Select every event/ }))
    expect(screen.getByText('2 selected')).toBeTruthy()
  })

  it('replays every selected row, one request each, after a confirmation, and says how it went', async () => {
    mockInbox(three())
    api.post.mockResolvedValue({ data: { data: { status: 'PROCESSED' } } })
    renderInbox()
    await screen.findByText('ref-1')
    await userEvent.click(screen.getByRole('checkbox', { name: /Select every event/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Replay 2' }))
    const dialog = await screen.findByRole('dialog')
    expect(api.post).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: /replay|confirm/i }))
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post.mock.calls.map(c => c[0])).toEqual(['/admin/webhook-events/e1/replay', '/admin/webhook-events/e2/replay'])
    expect(await screen.findByText(/Replayed 2 of 2 \(2 processed\)/)).toBeTruthy()
  })

  it('stops at the first failure and reports how far it got', async () => {
    mockInbox(three())
    api.post.mockResolvedValueOnce({ data: { data: { status: 'PROCESSED' } } }).mockRejectedValueOnce({ response: { data: { message: 'Step-up required' } } })
    renderInbox()
    await screen.findByText('ref-1')
    await userEvent.click(screen.getByRole('checkbox', { name: /Select every event/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Replay 2' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /replay|confirm/i }))
    expect(await screen.findByText(/Replayed 1 of 2.*Stopped: Step-up required/)).toBeTruthy()
    expect(api.post).toHaveBeenCalledTimes(2)
  })

  it('dismisses the selection with one shared note', async () => {
    mockInbox(three())
    api.post.mockResolvedValue({ data: { success: true } })
    renderInbox()
    await screen.findByText('ref-1')
    await userEvent.click(screen.getByRole('checkbox', { name: /Select every event/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss 2' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText(/Note/), 'paid by hand')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }))
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post).toHaveBeenCalledWith('/admin/webhook-events/e2/dismiss', { note: 'paid by hand' })
  })
})

describe('Payments and Dashboard — dispute deadline (G1)', () => {
  const pay = over => ({ id: 'p1', paystackRef: 'ref1', userEmail: 'a@b.co', amountCents: 4900, currency: 'USD', status: 'DISPUTED', fixTier: 'FIX', createdAt: '2026-09-27T10:00:00Z', disputedAt: '2026-10-12T10:00:00Z', ...over })
  const renderPay = () => render(<MemoryRouter><ToastProvider><AdminPayments /></ToastProvider></MemoryRouter>)

  it('a DISPUTED row shows how long is left to respond, and a passed deadline in red', async () => {
    api.get.mockResolvedValue({ data: { data: [
      pay({ disputeDueAt: new Date(Date.now() + 5 * 3600_000 + 60_000).toISOString() }),
      pay({ id: 'p2', paystackRef: 'ref2', disputeDueAt: new Date(Date.now() - 3 * 3600_000).toISOString() }),
    ], meta: { total: 2 } } })
    renderPay()
    await screen.findByText('ref1')
    expect(screen.getByText(/Respond in Paystack within 5h/)).toBeTruthy()
    const late = screen.getByText(/deadline passed 3h/i)
    expect(late.className).toMatch(/red/)
  })

  it('shows nothing extra when there is no stored deadline', async () => {
    api.get.mockResolvedValue({ data: { data: [pay({ disputeDueAt: null })], meta: { total: 1 } } })
    renderPay()
    await screen.findByText('ref1')
    expect(screen.queryByText(/Respond in Paystack/)).toBeNull()
  })

  const dash = openItems => ({
    revenue: { todayCents: 0, weekCents: 0, monthCents: 0, monthPartialRefundsCents: 0 }, totalPendingCommissionCents: 0,
    promo: { active: false, endsAt: null, standardCents: { FIX: 1, BADGE: 1, FIX_PLAIN: 1 }, promoCents: { FIX: 1, BADGE: 1, FIX_PLAIN: 1 } },
    openItems: { erroredScansThisWeek: 0, stuckScans: 0, stalePendingPayments: 0, webhookEventsNeedingAttention: 0, newLeads: 0, leadsThisWeek: 0, ...openItems },
    recentAlerts: [], webhookHealth: null,
  })
  it('the dashboard card counts open disputes and links to them; an older API without the field reads 0', async () => {
    api.get.mockResolvedValue({ data: { data: dash({ openDisputes: 2, nextDisputeDueAt: '2026-10-14T10:00:00Z', overdueDisputes: 1 }) } })
    const { unmount } = render(<MemoryRouter><AdminDashboard /></MemoryRouter>)
    const card = (await screen.findByText('Open disputes')).closest('a')
    expect(card.getAttribute('href')).toBe('/admin/payments?status=DISPUTED')
    expect(within(card).getByText('2')).toBeTruthy()
    expect(within(card).getByText(/1 past deadline/)).toBeTruthy()
    unmount()
    api.get.mockResolvedValue({ data: { data: dash({}) } })
    render(<MemoryRouter><AdminDashboard /></MemoryRouter>)
    expect(within((await screen.findByText('Open disputes')).closest('a')).getByText('0')).toBeTruthy()
  })
})
