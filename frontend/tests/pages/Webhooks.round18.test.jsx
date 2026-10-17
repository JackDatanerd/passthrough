// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminWebhooks from '../../src/pages/admin/AdminWebhooks'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Webhooks round 18 (G2): "Check webhook setup" runs the self-test and lists each check with the URLs to register.
const health = { available: true, paidChecked: 0, paidWithoutEvent: 0, unrecovered: 0, lastEventAt: null, lastChargeSuccessAt: null, lastResendEventAt: null }
const selfTest = {
  ok: false,
  endpoints: { paystack: 'https://api.example.com/api/webhooks/paystack', resend: 'https://api.example.com/api/webhooks/resend' },
  checks: [
    { id: 'paystack-secret', label: 'Paystack secret key', status: 'ok', detail: 'Live-mode key set.' },
    { id: 'resend-secret', label: 'Resend signing secret', status: 'fail', detail: 'RESEND_WEBHOOK_SECRET is not set.' },
    { id: 'paystack-ips', label: 'Paystack IP allow-list', status: 'warn', detail: 'One entry is not an IP.' },
  ],
}
function renderPage(selfTestImpl) {
  api.get.mockImplementation(async url => {
    if (url === '/admin/webhook-events/health') return { data: { data: health } }
    if (url === '/admin/webhook-events/self-test') return selfTestImpl()
    return { data: { data: [], meta: { total: 0 } } }
  })
  return render(<MemoryRouter initialEntries={['/admin/webhooks']}><ToastProvider><Routes><Route path="/admin/webhooks" element={<AdminWebhooks />} /></Routes></ToastProvider></MemoryRouter>)
}
beforeEach(() => { api.get.mockReset() })

describe('AdminWebhooks — setup check (round 18 G2)', () => {
  it('lists every check with OK / CHECK / FIX and the URLs to register', async () => {
    renderPage(async () => ({ data: { data: selfTest } }))
    fireEvent.click(await screen.findByRole('button', { name: /Check webhook setup/ }))
    expect(await screen.findByText('Resend signing secret')).toBeTruthy()
    expect(screen.getByText('OK')).toBeTruthy()
    expect(screen.getByText('FIX')).toBeTruthy()
    expect(screen.getByText('CHECK')).toBeTruthy()
    expect(screen.getByText('RESEND_WEBHOOK_SECRET is not set.')).toBeTruthy()
    expect(screen.getByText('https://api.example.com/api/webhooks/paystack')).toBeTruthy()
    expect(screen.getByText('https://api.example.com/api/webhooks/resend')).toBeTruthy()
  })
  it('shows an error when the check cannot be run', async () => {
    renderPage(async () => { throw { response: { data: { message: 'Step-up required' } } } })
    fireEvent.click(await screen.findByRole('button', { name: /Check webhook setup/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Step-up required/)
  })
})
