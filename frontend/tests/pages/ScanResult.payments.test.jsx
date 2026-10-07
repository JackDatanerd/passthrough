// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'

// Payments & Pricing round 3 — G1 (verified-email gate), G3 (open-checkout notice), B2 (already paid).
const auth = { user: { id: 'u1', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('@paystack/inline-js', () => ({ default: class { resumeTransaction() {} } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ScoreGauge', () => ({ default: () => null }))
vi.mock('../../src/components/scan/CategoryScores', () => ({ default: () => null }))
vi.mock('../../src/components/scan/AtsDetailPanel', () => ({ default: () => null }))
vi.mock('../../src/components/scan/DiffView', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ResumeDataEditor', () => ({ default: () => null }))
vi.mock('../../src/components/scan/QuantificationPrompts', () => ({ default: () => null }))
vi.mock('../../src/components/scan/SaveProfilePrompt', () => ({ default: () => null }))
vi.mock('../../src/components/scan/FixBanner', () => ({
  default: ({ onPay, onRedeemCredit }) => (
    <div>
      <button onClick={() => onPay('FIX')}>pay-fix</button>
      <button onClick={onRedeemCredit}>redeem</button>
    </div>
  ),
}))

const SCAN = { id: 's1', status: 'COMPLETE_PASS', fixPurchased: false, atsScore: 70, inputMode: 'file' }
function setupApi({ pending = null, scan = SCAN } = {}) {
  api.get.mockImplementation(async (url) => {
    if (url.startsWith('/payments/pending')) return { data: { data: { pending } } }
    if (url.startsWith('/payments/verify')) return { data: { success: true } }
    if (url.startsWith('/scan/')) return { data: { data: scan } }
    return { data: { data: {} } }
  })
}
const renderPage = () => render(
  <MemoryRouter initialEntries={['/scan/s1']}><Routes><Route path="/scan/:id" element={<ScanResult />} /></Routes></MemoryRouter>)

beforeEach(() => {
  api.get.mockReset(); api.post.mockReset(); auth.refreshUser.mockReset()
  auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 }
})

describe('ScanResult — verified-email gate (G1)', () => {
  it('an unverified buyer is stopped before any payment call, told why, and can resend the verification email', async () => {
    auth.user = { id: 'u1', emailVerified: false, freeFixCredits: 0 }
    auth.refreshUser.mockResolvedValue({ id: 'u1', emailVerified: false })
    setupApi(); api.post.mockResolvedValue({ data: { success: true } })
    renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    expect(await screen.findByText(/verify your email address before buying/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalledWith('/payments/initialize', expect.anything())
    fireEvent.click(screen.getByText('Resend verification email'))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/resend-verification'))
    expect(await screen.findByText(/Verification email sent/)).toBeInTheDocument()
  })

  it('a stale cached "unverified" flag is re-read from the server and the purchase goes ahead if they have since verified', async () => {
    auth.user = { id: 'u1', emailVerified: false, freeFixCredits: 0 }
    auth.refreshUser.mockResolvedValue({ id: 'u1', emailVerified: true })
    setupApi(); api.post.mockResolvedValue({ data: { data: { access_code: 'AC', reference: 'R' } } })
    renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payments/initialize', expect.objectContaining({ scanId: 's1', fixTier: 'FIX' })))
  })

  it('redeeming a credit is gated the same way', async () => {
    auth.user = { id: 'u1', emailVerified: false, freeFixCredits: 1 }
    auth.refreshUser.mockResolvedValue({ id: 'u1', emailVerified: false })
    setupApi()
    renderPage()
    fireEvent.click(await screen.findByText('redeem'))
    expect(await screen.findByText(/verify your email address before buying/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalledWith('/scan/s1/redeem-credit')
  })

  it('the server\'s own EMAIL_NOT_VERIFIED refusal also offers the resend action', async () => {
    setupApi()
    api.post.mockRejectedValue({ response: { status: 403, data: { code: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email address before buying.' } } })
    renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    expect(await screen.findByText('Resend verification email')).toBeInTheDocument()
  })
})

describe('ScanResult — open checkout notice (G3) and already-paid (B2)', () => {
  const pending = { reference: 'ref-9', fixTier: 'FIX', amountCents: 4900, currency: 'USD', createdAt: new Date().toISOString() }

  it('shows an in-progress notice with check-status and cancel when an open checkout exists', async () => {
    setupApi({ pending })
    renderPage()
    expect(await screen.findByText(/payment in progress for the resume fix/i)).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/payments/pending?scanId=s1')
  })

  it('shows nothing when there is none', async () => {
    setupApi()
    renderPage()
    await screen.findByText('pay-fix')
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/payments/pending?scanId=s1'))
    expect(screen.queryByText(/payment in progress/i)).toBeNull()
  })

  it('"Check payment status" asks the verify endpoint about that reference', async () => {
    setupApi({ pending })
    renderPage()
    fireEvent.click(await screen.findByText('Check payment status'))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/payments/verify?reference=ref-9'))
  })

  it('"Cancel that payment" cancels that reference and clears the notice', async () => {
    setupApi({ pending })
    api.post.mockResolvedValue({ data: { success: true } })
    renderPage()
    fireEvent.click(await screen.findByText('Cancel that payment'))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payments/ref-9/cancel'))
    await waitFor(() => expect(screen.queryByText(/payment in progress/i)).toBeNull())
  })

  it('a cancel the server turns into "already paid" shows its message and waits for delivery instead of an error dead-end', async () => {
    setupApi({ pending })
    api.post.mockRejectedValue({ response: { status: 409, data: { success: false, alreadyPaid: true, message: 'An earlier payment for this resume actually went through — it is being delivered now.' } } })
    renderPage()
    fireEvent.click(await screen.findByText('Cancel that payment'))
    expect(await screen.findByText(/actually went through/)).toBeInTheDocument()
    expect(screen.queryByText(/payment in progress/i)).toBeNull()
  })

  it('a checkout the server reports as already paid is adopted, not shown as a failed initialise', async () => {
    setupApi()
    api.post.mockRejectedValue({ response: { status: 409, data: { success: false, alreadyPaid: true, message: 'An earlier payment for this resume actually went through.', data: { paidReference: 'old', scanId: 's1' } } } })
    renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    expect(await screen.findByText(/actually went through/)).toBeInTheDocument()
    expect(screen.queryByText('Cancel that payment and choose again')).toBeNull()
  })
})

describe('ScanResult — price notice at checkout (round 4, B1/G1)', () => {
  it('tells the buyer when their code stopped applying, with the amount that will be charged', async () => {
    setupApi()
    api.post.mockResolvedValue({ data: { data: { access_code: 'AC', reference: 'R', amount: 4900, currency: 'USD', referralDropped: true } } })
    renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    expect(await screen.findByText(/referral code just reached its usage limit.*\$49/)).toBeInTheDocument()
  })

  it('says nothing extra when the code applied (or there was none)', async () => {
    setupApi()
    api.post.mockResolvedValue({ data: { data: { access_code: 'AC', reference: 'R', amount: 2900, currency: 'USD', referralDropped: false } } })
    renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payments/initialize', expect.anything()))
    expect(screen.queryByText(/usage limit/)).toBeNull()
  })
})
