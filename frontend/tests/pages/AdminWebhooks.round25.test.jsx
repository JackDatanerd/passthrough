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

// Webhooks round 25 (m2): a row with no stored payload said "{}", which reads as an empty body Paystack sent.
const ev = { id: 'e1', provider: 'resend', eventType: 'email.bounced', reference: null, status: 'PROCESSED', attempts: 1,
  receivedAt: '2026-10-05T10:00:00Z', replayable: false, dismissable: false, error: null, note: 'suppressed' }
const renderPage = () => render(
  <MemoryRouter initialEntries={['/admin/webhooks']}><ToastProvider><Routes><Route path="/admin/webhooks" element={<AdminWebhooks />} /></Routes></ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminWebhooks — round 25', () => {
  function mock(payload) {
    api.get.mockImplementation(async url => {
      if (url === '/admin/webhook-events/health') return { data: { success: true, data: { available: false } } }
      if (url === '/admin/webhook-events/e1') return { data: { success: true, data: { id: 'e1', payload } } }
      return { data: { data: [ev], meta: { total: 1 } } }
    })
  }
  it('says no payload is stored instead of showing {}', async () => {
    mock(null); renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Payload' }))
    expect(await screen.findByText(/No payload is stored for this event/)).toBeTruthy()
    expect(screen.queryByText('{}')).toBeNull()
  })
  it('still shows a stored payload as JSON', async () => {
    mock({ event: 'refund.processed', data: { id: 1 } }); renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Payload' }))
    expect(await screen.findByText(/"refund.processed"/)).toBeTruthy()
    expect(screen.queryByText(/No payload is stored/)).toBeNull()
  })
})
