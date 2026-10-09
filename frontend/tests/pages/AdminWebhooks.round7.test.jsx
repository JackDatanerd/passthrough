// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminWebhooks from '../../src/pages/admin/AdminWebhooks'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 7: Resend events share the inbox (G1) — a provider filter and label.
const ev = (over = {}) => ({ id: 'e1', provider: 'paystack', eventType: 'charge.success', reference: 'ref-1', status: 'PROCESSED', attempts: 1,
  receivedAt: '2026-10-05T10:00:00Z', replayable: false, error: null, note: null, ...over })

function mockApi(events) {
  api.get.mockImplementation(async url => {
    if (url === '/admin/webhook-events/health') return { data: { success: true, data: { available: false } } }
    return { data: { data: events, meta: { total: events.length } } }
  })
}
const renderAt = (url = '/admin/webhooks') => render(
  <MemoryRouter initialEntries={[url]}><ToastProvider><Routes><Route path="/admin/webhooks" element={<AdminWebhooks />} /></Routes></ToastProvider></MemoryRouter>)
const listCalls = () => api.get.mock.calls.filter(([u]) => u === '/admin/webhook-events')

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminWebhooks — round 7', () => {
  it('labels a Resend row with its source and offers Replay on a failed one', async () => {
    mockApi([ev({ id: 'r1', provider: 'resend', eventType: 'email.bounced', reference: null, status: 'FAILED', error: 'email suppression write failed', replayable: true })])
    renderAt()
    expect(await screen.findByText('email.bounced')).toBeTruthy()
    expect(screen.getByText('resend')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Replay' })).toBeTruthy()
  })

  it('does not label a Paystack row', async () => {
    mockApi([ev()])
    renderAt()
    await screen.findByText('charge.success')
    expect(screen.queryByText('paystack')).toBeNull()
  })

  it('reads the provider filter from the URL and sends it to the API', async () => {
    mockApi([ev()])
    renderAt('/admin/webhooks?provider=resend')
    await screen.findByText('charge.success')
    expect(listCalls().at(-1)[1].params.provider).toBe('resend')
  })

  it('ignores an unknown provider in the URL', async () => {
    mockApi([ev()])
    renderAt('/admin/webhooks?provider=evil')
    await screen.findByText('charge.success')
    expect(listCalls().at(-1)[1].params.provider).toBeUndefined()
  })

  it('choosing a source re-queries with it', async () => {
    mockApi([ev()])
    renderAt()
    await screen.findByText('charge.success')
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'resend')
    await vi.waitFor(() => expect(listCalls().at(-1)[1].params.provider).toBe('resend'))
  })
})
