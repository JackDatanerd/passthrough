// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import PaymentSuccess from '../../src/pages/PaymentSuccess'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

// Payments & Pricing round 2: B6 (an honest "needs support" state instead of a false
// "Payment confirmed!") and B7 (no transient-retry budget burned on 4xx/429).
const renderAt = (url = '/payment/success?reference=ref1') =>
  render(<MemoryRouter initialEntries={[url]}><PaymentSuccess /></MemoryRouter>)
const reject = (status, data = {}) => api.get.mockRejectedValue({ response: { status, data } })

beforeEach(() => { api.get.mockReset() })

describe('PaymentSuccess', () => {
  it('asks the server about the (URL-encoded) reference', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { scanId: 's1' } } })
    renderAt('/payment/success?reference=a%2Fb')
    await screen.findByText('Payment confirmed!')
    expect(api.get).toHaveBeenCalledWith('/payments/verify?reference=a%2Fb')
  })

  it('B6: 409 + needsSupport shows the support state with the server message — never "Payment confirmed!"', async () => {
    reject(409, { success: false, needsSupport: true, message: 'We received your payment but could not attach it.' })
    renderAt()
    expect(await screen.findByText('We need to look at this payment')).toBeInTheDocument()
    expect(screen.getByText(/could not attach it/)).toBeInTheDocument()
    expect(screen.queryByText('Payment confirmed!')).toBeNull()
    expect(api.get).toHaveBeenCalledTimes(1)          // and no retries
  })

  it('B7: a 400 (declined / not this account\'s) goes straight to the failure screen — one request, no retry budget burned', async () => {
    reject(400, { message: 'Payment verification failed.' })
    renderAt()
    expect(await screen.findByText('Verification failed')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('B7: a 404 is not retried either', async () => {
    reject(404)
    renderAt()
    await screen.findByText('Verification failed')
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('B7: a 429 shows its own "checking too fast" state — not "Verification failed" — and offers Check again', async () => {
    reject(429, { message: 'Too many payment checks.' })
    renderAt()
    expect(await screen.findByText('Checking too fast')).toBeInTheDocument()
    expect(screen.queryByText('Verification failed')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('a 401 still shows the sign-in state', async () => {
    reject(401)
    renderAt()
    expect(await screen.findByText('Sign in to confirm your payment')).toBeInTheDocument()
  })

  it('a network error (no response) IS retried before giving up', async () => {
    api.get.mockRejectedValueOnce(new Error('Network Error')).mockResolvedValue({ data: { success: true, data: { scanId: 's1' } } })
    renderAt()
    expect(await screen.findByText('Payment confirmed!', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('no reference in the URL gets its own state (not "Verification failed") without calling the API', async () => {
    renderAt('/payment/success')
    expect(await screen.findByText(/couldn't find a payment to check/)).toBeInTheDocument()
    expect(screen.queryByText('Verification failed')).toBeNull()
    expect(screen.getByRole('link', { name: 'View my payments' })).toHaveAttribute('href', '/dashboard/payments')
    expect(api.get).not.toHaveBeenCalled()
  })

  it('G2: a definite decline says the payment was not completed and links back to the resume', async () => {
    reject(400, { success: false, declined: true, message: 'This payment was not completed, so you have not been charged.', data: { scanId: 's9' } })
    renderAt()
    expect(await screen.findByText('Payment not completed')).toBeInTheDocument()
    expect(screen.getByText(/have not been charged/)).toBeInTheDocument()
    expect(screen.queryByText(/may still have gone through/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to your resume' })).toHaveAttribute('href', '/scan/s9')
    expect(api.get).toHaveBeenCalledTimes(1)          // no retries
  })

  it('a plain 400 without the declined flag still shows the generic failure', async () => {
    reject(400, { message: 'Payment verification failed.' })
    renderAt()
    expect(await screen.findByText('Verification failed')).toBeInTheDocument()
  })
})

describe('PaymentSuccess — long processing (G3)', () => {
  it('keeps checking slowly after the fast polls, and goes to the resume when it clears', async () => {
    vi.useFakeTimers()
    try {
      const pending = { data: { success: false, pending: true, data: { scanId: 's7' } } }
      api.get.mockResolvedValue(pending)
      renderAt()
      // 5 fast attempts (4s apart) …
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(4100)
      expect(api.get).toHaveBeenCalledTimes(5)
      expect(screen.getByText('Still processing')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Back to your resume' })).toHaveAttribute('href', '/scan/s7')
      // … then a quiet 30s poll, which this time succeeds.
      api.get.mockResolvedValue({ data: { success: true, data: { scanId: 's7' } } })
      await vi.advanceTimersByTimeAsync(30100)
      expect(api.get).toHaveBeenCalledTimes(6)
      expect(screen.getByText('Payment confirmed!')).toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })

  it('a manual "Check again" replaces the waiting slow poll instead of running beside it', async () => {
    vi.useFakeTimers()
    try {
      api.get.mockResolvedValue({ data: { success: false, pending: true, data: { scanId: 's7' } } })
      renderAt()
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(4100)
      const before = api.get.mock.calls.length
      screen.getByRole('button', { name: 'Check again' }).click()
      await vi.advanceTimersByTimeAsync(0)
      expect(api.get.mock.calls.length).toBe(before + 1)
      // the old 30s timer is gone: advancing 30s yields exactly the NEW chain's next fast poll(s), not an extra one
      await vi.advanceTimersByTimeAsync(4100)
      expect(api.get.mock.calls.length).toBe(before + 2)
    } finally { vi.useRealTimers() }
  })
})
