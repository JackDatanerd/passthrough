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

  it('no reference in the URL fails immediately without calling the API', async () => {
    renderAt('/payment/success')
    expect(await screen.findByText('Verification failed')).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })
})
