// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminWebhooks from '../../src/pages/admin/AdminWebhooks'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 5: delivery-health banner, payment cross-link, search boxes that follow the URL.
const ev = (over = {}) => ({ id: 'e1', eventType: 'charge.success', reference: 'ref-1', status: 'PROCESSED', attempts: 1,
  receivedAt: '2026-10-05T10:00:00Z', replayable: false, error: null, note: null, ...over })
const health = (over = {}) => ({ available: true, lastEventAt: '2026-10-06T10:00:00Z', lastChargeSuccessAt: '2026-10-06T09:00:00Z',
  paidChecked: 4, paidWithoutEvent: 0, missingReferences: [], ...over })

function mockApi({ h = health(), events = [ev()] } = {}) {
  api.get.mockImplementation(async url => {
    if (url === '/admin/webhook-events/health') return { data: { success: true, data: h } }
    return { data: { data: events, meta: { total: events.length } } }
  })
}
const renderAt = (url = '/admin/webhooks') => render(
  <MemoryRouter initialEntries={[url]}><ToastProvider><Routes><Route path="/admin/webhooks" element={<AdminWebhooks />} /></Routes></ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminWebhooks — round 5', () => {
  it('links each reference to that payment on the Payments page', async () => {
    mockApi(); renderAt()
    const link = await screen.findByRole('link', { name: 'ref-1' })
    expect(link.getAttribute('href')).toBe('/admin/payments?reference=ref-1')
  })

  it('warns when paid sales have no charge.success on record, naming a few of them', async () => {
    mockApi({ h: health({ paidWithoutEvent: 2, paidChecked: 5, missingReferences: ['ref-a', 'ref-b'] }) }); renderAt()
    expect(await screen.findByText(/2 paid sales in the last 7 days have no charge\.success event on record/)).toBeTruthy()
    expect(screen.getByText('ref-a, ref-b')).toBeTruthy()
  })

  it('says nothing alarming when every paid sale has its event, but still shows when the last event arrived', async () => {
    mockApi(); renderAt()
    expect(await screen.findByText(/Last event received/)).toBeTruthy()
    expect(screen.queryByText(/no charge\.success event on record/)).toBeNull()
  })

  it('shows nothing about health when it cannot be read', async () => {
    api.get.mockImplementation(async url => {
      if (url === '/admin/webhook-events/health') throw new Error('nope')
      return { data: { data: [ev()], meta: { total: 1 } } }
    })
    renderAt()
    await screen.findByText('charge.success')
    expect(screen.queryByText(/Last event received/)).toBeNull()
  })

  it('the search boxes follow the URL (browser back/forward) instead of keeping stale text', async () => {
    mockApi()
    function Nav() { const nav = useNavigate(); return <button onClick={() => nav(-1)}>back</button> }
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/admin/webhooks', '/admin/webhooks?reference=abc&type=refund.processed']} initialIndex={1}>
      <ToastProvider><Nav /><Routes><Route path="/admin/webhooks" element={<AdminWebhooks />} /></Routes></ToastProvider></MemoryRouter>)
    expect((await screen.findByLabelText('Payment reference')).value).toBe('abc')
    await user.click(screen.getByText('back'))
    await vi.waitFor(() => expect(screen.getByLabelText('Payment reference').value).toBe(''))
    expect(screen.getByLabelText('Event type').value).toBe('')
  })
})
