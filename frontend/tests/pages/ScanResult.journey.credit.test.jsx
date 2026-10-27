// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'
import { clearAnonScanTokens } from '../../src/lib/anonScans'

// Journey audit: a delivery under the 80 line is never presented as Verified (Score banner, Apply tab), and the free credit is
// described only when the server says it is still held for this resume.
const auth = { user: { id: 'u1', emailVerified: true, freeFixCredits: 1 }, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/lib/utils', async orig => ({ ...(await orig()), downloadBlob: () => {} }))
vi.mock('@paystack/inline-js', () => ({ default: class { resumeTransaction() {} } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ScoreSummary', () => ({ default: () => null }))
vi.mock('../../src/components/scan/CategoryScores', () => ({ default: () => null }))
vi.mock('../../src/components/scan/QuantificationPrompts', () => ({ default: () => null }))
vi.mock('../../src/components/scan/SaveProfilePrompt', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ResumeDataEditor', () => ({ default: () => null }))
vi.mock('../../src/components/scan/DeliveredResumeEditor', () => ({ default: () => null }))
vi.mock('../../src/components/scan/CoverLetterPanel', () => ({ default: () => null }))
vi.mock('../../src/components/scan/AtsDetailPanel', () => ({ default: () => null }))

const JD = 'Senior engineer. '.repeat(10)
const now = () => new Date().toISOString()
const delivered = (over = {}) => ({
  id: 's1', status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'FIX', fixRetryCount: 2, atsScore: 52, fixAtsScore: 72,
  passed: false, userId: 'u1', inputMode: 'file', jobDescriptionText: JD, createdAt: now(), updatedAt: now(),
  verificationUrl: 'https://usepassthrough.com/v/abc', verificationCode: 'abc', verificationStatus: 'ACTIVE', ...over,
})
function setup(scan, tab = '') {
  api.get.mockImplementation(async url => url.startsWith('/payments/pending') ? { data: { data: { pending: null } } } : { data: { data: scan } })
  return render(<MemoryRouter initialEntries={[`/scan/s1${tab}`]}><Routes><Route path="/scan/:id" element={<ScanResult />} /><Route path="/scan/:id/:tab" element={<ScanResult />} /></Routes></MemoryRouter>)
}
beforeEach(() => {
  for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset()
  auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 1 }
  localStorage.clear(); sessionStorage.clear(); clearAnonScanTokens()
})

describe('Score tab after a delivery', () => {
  it('under the line: says so, never claims a Verified link, and describes the held credit', async () => {
    setup(delivered({ fixCreditHeld: true }), '/score')
    const status = await screen.findByTestId('under-line-status')
    expect(status).toHaveTextContent('scores 72, 8 points under the 80 a Verified link needs')
    expect(screen.getByTestId('credit-status')).toHaveTextContent('goes away if this resume reaches 80')
    expect(document.body.textContent).not.toMatch(/with your Verified link/)
  })
  it('under the line with retries left: names how many', async () => {
    setup(delivered({ fixRetryCount: 1, fixCreditHeld: false }), '/score')
    expect(await screen.findByTestId('under-line-status')).toHaveTextContent('1 free retry left')
    expect(screen.queryByTestId('credit-status')).toBeNull()      // no credit is described when none is held
  })
  it('over the line: the green banner keeps its Verified link and no under-line card shows', async () => {
    setup(delivered({ fixAtsScore: 86 }), '/score')
    expect(await screen.findByText(/with your Verified link/)).toBeTruthy()
    expect(screen.queryByTestId('under-line-status')).toBeNull()
  })
})

describe('Apply tab after a delivery', () => {
  it('under the line: the locked card, no Verified link, no embed, no QR', async () => {
    setup(delivered({ fixCreditHeld: true }), '/apply')
    expect(await screen.findByTestId('verified-locked')).toBeTruthy()
    expect(screen.queryByTestId('verified-link-card')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Embed your live badge/)
  })
  it('over the line: the Verified link card, no locked card', async () => {
    setup(delivered({ fixAtsScore: 86 }), '/apply')
    expect(await screen.findByTestId('verified-link-card')).toBeTruthy()
    expect(screen.queryByTestId('verified-locked')).toBeNull()
  })
})
