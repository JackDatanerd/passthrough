// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminWebhooks from '../../src/pages/admin/AdminWebhooks'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 11: dismiss a stuck event (G2), date-range filter (G4), health banner counts unrecovered sales (G3).
const ev = (over = {}) => ({ id: 'e1', provider: 'paystack', eventType: 'charge.success', reference: 'ref-1', status: 'FAILED', attempts: 3,
  receivedAt: '2026-10-05T10:00:00Z', replayable: true, dismissable: true, error: 'boom', note: null, ...over })

function mockApi(events, health = { available: false }) {
  api.get.mockImplementation(async url => {
    if (url === '/admin/webhook-events/health') return { data: { success: true, data: health } }
    return { data: { data: events, meta: { total: events.length } } }
  })
}
const renderAt = (url = '/admin/webhooks') => render(
  <MemoryRouter initialEntries={[url]}><ToastProvider><Routes><Route path="/admin/webhooks" element={<AdminWebhooks />} /></Routes></ToastProvider></MemoryRouter>)
const listCalls = () => api.get.mock.calls.filter(([u]) => u === '/admin/webhook-events')

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminWebhooks — round 11', () => {
  it('shows Dismiss only on a dismissable row', async () => {
    mockApi([ev(), ev({ id: 'e2', reference: 'ref-2', status: 'PROCESSED', dismissable: false, replayable: false, error: null })])
    renderAt()
    await screen.findByText('ref-1')
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1)
  })

  it('dismisses with the typed note after a confirmation, then reloads the list', async () => {
    mockApi([ev()])
    api.post.mockResolvedValue({ data: { success: true } })
    renderAt()
    await screen.findByText('ref-1')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    const dialog = await screen.findByRole('dialog')
    expect(api.post).not.toHaveBeenCalled()
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'paid by hand')
    const before = listCalls().length
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }))
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/webhook-events/e1/dismiss', { note: 'paid by hand' }))
    await vi.waitFor(() => expect(listCalls().length).toBeGreaterThan(before))
  })

  it('cancelling the dialog sends nothing', async () => {
    mockApi([ev()])
    renderAt()
    await screen.findByText('ref-1')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    expect(api.post).not.toHaveBeenCalled()
  })

  it('reads from / to from the URL and sends them to the API', async () => {
    mockApi([ev()])
    renderAt('/admin/webhooks?from=2026-10-01&to=2026-10-05')
    await screen.findByText('ref-1')
    expect(listCalls().at(-1)[1].params).toMatchObject({ from: '2026-10-01', to: '2026-10-05' })
  })

  it('ignores a malformed date in the URL', async () => {
    mockApi([ev()])
    renderAt('/admin/webhooks?from=nope&to=2026-99-99')
    await screen.findByText('ref-1')
    expect(listCalls().at(-1)[1].params.from).toBeUndefined()
    expect(listCalls().at(-1)[1].params.to).toBeUndefined()
  })

  it('the health banner follows `unrecovered`, not the raw count', async () => {
    mockApi([ev()], { available: true, paidChecked: 5, paidWithoutEvent: 2, unrecovered: 0, missingReferences: ['a', 'b'], unrecoveredReferences: [] })
    renderAt()
    await screen.findByText('ref-1')
    expect(screen.queryByText(/no charge\.success/i)).toBeNull()
  })
})
