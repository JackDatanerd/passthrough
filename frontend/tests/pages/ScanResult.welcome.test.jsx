// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'
import { setStoredReferralCode } from '../../src/hooks/useReferralCapture'

// The welcome code at checkout: applied for the signed-in buyer, only with the full fix, and never over somebody else's code.
const auth = { user: { id: 'u1', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('@paystack/inline-js', () => ({ default: class { resumeTransaction() {} } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ScoreSummary', () => ({ default: () => null }))
vi.mock('../../src/components/scan/CategoryScores', () => ({ default: () => null }))
vi.mock('../../src/components/scan/AtsDetailPanel', () => ({ default: () => null }))
vi.mock('../../src/components/scan/DiffView', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ResumeDataEditor', () => ({ default: () => null }))
vi.mock('../../src/components/scan/QuantificationPrompts', () => ({ default: () => null }))
vi.mock('../../src/components/scan/SaveProfilePrompt', () => ({ default: () => null }))
vi.mock('../../src/components/scan/FixBanner', () => ({
  default: ({ onPay, welcomeOffer, referralCode }) => (
    <div>
      <button onClick={() => onPay('FIX')}>pay-fix</button>
      <button onClick={() => onPay('BADGE')}>pay-badge</button>
      <button onClick={() => onPay('FIX_PLAIN')}>pay-plain</button>
      <span data-testid="banner-welcome">{welcomeOffer ? welcomeOffer.code : 'none'}</span>
      <span data-testid="banner-code">{referralCode || 'none'}</span>
    </div>
  ),
}))

const SCAN = { id: 's1', status: 'COMPLETE_PASS', fixPurchased: false, atsScore: 70, inputMode: 'file' }
const OFFER = { code: 'FN-7K2QH', percentOff: 30, amountCents: 2030, listAmountCents: 2900, currency: 'USD', tier: 'FIX', expiresAt: new Date(Date.now() + 5 * 864e5).toISOString() }
function setupApi({ offer = OFFER, offerFails = false } = {}) {
  api.get.mockImplementation(async url => {
    if (url === '/pricing/welcome-offer') { if (offerFails) throw new Error('down'); return { data: { data: { offer } } } }
    if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }
    if (url.startsWith('/scan/')) return { data: { data: SCAN } }
    return { data: { data: {} } }
  })
  api.post.mockResolvedValue({ data: { data: { access_code: 'AC', reference: 'R' } } })
}
const renderPage = () => render(<MemoryRouter initialEntries={['/scan/s1']}><Routes><Route path="/scan/:id" element={<ScanResult />} /><Route path="/scan/:id/:tab" element={<ScanResult />} /></Routes></MemoryRouter>)
const initBody = () => api.post.mock.calls.find(([url]) => url === '/payments/initialize')?.[1]

beforeEach(() => {
  api.get.mockReset(); api.post.mockReset(); auth.refreshUser.mockReset()
  auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 }
  localStorage.clear(); setStoredReferralCode('')
})
afterEach(() => { localStorage.clear() })

describe('ScanResult — welcome code', () => {
  it('hands the offer to the banner and sends the code with the full fix, with no partner attribution fields', async () => {
    setupApi(); renderPage()
    await waitFor(() => expect(screen.getByTestId('banner-welcome')).toHaveTextContent('FN-7K2QH'))
    fireEvent.click(screen.getByText('pay-fix'))
    await waitFor(() => expect(initBody()).toBeTruthy())
    expect(initBody()).toMatchObject({ scanId: 's1', fixTier: 'FIX', referralCode: 'FN-7K2QH' })
    expect(initBody().referralSource).toBeUndefined()
    expect(initBody().referralSub).toBeUndefined()
  })

  // One render per tier: after a click the page (rightly) ignores a second one while its checkout is open.
  it.each([['pay-badge', 'BADGE'], ['pay-plain', 'FIX_PLAIN']])(
    'does NOT send it with %s: a single-use code must not be spent on a purchase it does not discount', async (label, tier) => {
      setupApi(); renderPage()
      await waitFor(() => expect(screen.getByTestId('banner-welcome')).toHaveTextContent('FN-7K2QH'))
      fireEvent.click(screen.getByText(label))
      await waitFor(() => expect(initBody()).toBeTruthy())
      expect(initBody()).toMatchObject({ scanId: 's1', fixTier: tier })
      expect(initBody().referralCode).toBeUndefined()
    })

  it("never replaces somebody else's code: a partner's or a typed code wins and the banner is not offered the welcome code", async () => {
    setStoredReferralCode('PARTNER10')
    setupApi(); renderPage()
    await waitFor(() => expect(screen.getByTestId('banner-code')).toHaveTextContent('PARTNER10'))
    expect(screen.getByTestId('banner-welcome')).toHaveTextContent('none')
    fireEvent.click(screen.getByText('pay-fix'))
    await waitFor(() => expect(initBody()).toBeTruthy())
    expect(initBody().referralCode).toBe('PARTNER10')
  })

  it('does not store the welcome code as a referral code (it would be re-sent after it was spent)', async () => {
    setupApi(); renderPage()
    await waitFor(() => expect(screen.getByTestId('banner-welcome')).toHaveTextContent('FN-7K2QH'))
    expect(localStorage.getItem('passthrough_referral_code')).toBeNull()
    expect(screen.getByTestId('banner-code')).toHaveTextContent('none')
  })

  it('with no offer (none issued, spent, expired) everything is as before', async () => {
    setupApi({ offer: null }); renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    await waitFor(() => expect(initBody()).toBeTruthy())
    expect(initBody().referralCode).toBeUndefined()
    expect(screen.getByTestId('banner-welcome')).toHaveTextContent('none')
  })

  it('a failed offer request shows nothing and breaks nothing', async () => {
    setupApi({ offerFails: true }); renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    await waitFor(() => expect(initBody()).toBeTruthy())
    expect(initBody().referralCode).toBeUndefined()
  })

  it('an offer that has already lapsed is ignored', async () => {
    setupApi({ offer: { ...OFFER, expiresAt: new Date(Date.now() - 1000).toISOString() } }); renderPage()
    fireEvent.click(await screen.findByText('pay-fix'))
    await waitFor(() => expect(initBody()).toBeTruthy())
    expect(initBody().referralCode).toBeUndefined()
  })
})
