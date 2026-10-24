// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'
import { clearAnonScanTokens } from '../../src/lib/anonScans'

// Delivered screens, round 3: the score road and the real attempt ladder sit on top of the existing delivered copy, never in place of it.
const auth = { user: { id: 'u1', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
const downloads = []
vi.mock('../../src/lib/utils', async orig => ({ ...(await orig()), downloadBlob: (blob, name) => { downloads.push(name) } }))
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
const fp = (over = {}) => ({ startedAt: now(), round: 0, phase: 'rendering', attempt: 2, of: 3, scores: [71, 76], ...over })
const delivered = (over = {}) => ({
  id: 's1', status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'FIX', fixRetryCount: 0, atsScore: 52, fixAtsScore: 76,
  passed: false, userId: 'u1', inputMode: 'file', jobDescriptionText: JD, createdAt: now(), updatedAt: now(), fixProgress: fp(), ...over,
})
function setup(scan) {
  api.get.mockImplementation(async url => url.startsWith('/payments/pending') ? { data: { data: { pending: null } } } : { data: { data: scan } })
  return render(<MemoryRouter initialEntries={['/scan/s1']}><Routes><Route path="/scan/:id" element={<ScanResult />} /><Route path="/scan/:id/:tab" element={<ScanResult />} /></Routes></MemoryRouter>)
}
beforeEach(() => {
  for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset()
  auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 }
  localStorage.clear(); sessionStorage.clear(); clearAnonScanTokens()
})

describe('a delivered fix', () => {
  it('just short of the line: the road and the real attempts appear, and the existing copy and retry stay', async () => {
    setup(delivered())
    const summary = await screen.findByTestId('delivered-summary')
    expect(summary).toHaveTextContent('76 out of 100, 4 points from the 80.')
    expect(summary).toHaveTextContent('Up 24 from 52.')
    expect(screen.getByTestId('delivered-attempts')).toHaveTextContent('Attempt 1: 71')
    expect(screen.getByTestId('delivered-attempts')).toHaveTextContent('Attempt 2: 76')
    expect(screen.getByText('Your improved resume is ready')).toBeTruthy()           // the existing amber copy is untouched
    expect(screen.getByRole('button', { name: /Try Again — Free/ })).toBeTruthy()    // so is the free retry
  })

  it('past the line: the road says so, above the existing verified copy', async () => {
    setup(delivered({ fixAtsScore: 84, fixProgress: fp({ scores: [71, 84] }), verificationUrl: 'https://usepassthrough.com/v/abc' }))
    expect(await screen.findByTestId('delivered-summary')).toHaveTextContent('84 out of 100, past the 80 line.')
    expect(screen.getByText(/Your Passthrough Verified resume is ready/)).toBeTruthy()
  })

  it('a failed rewrite shows no before-and-after (the original was delivered) but keeps its own message', async () => {
    setup(delivered({ rewriteFailed: true, fixAtsScore: 52 }))
    expect(await screen.findByText('We hit a snag generating your rewrite')).toBeTruthy()
    expect(screen.queryByTestId('delivered-summary')).toBeNull()
  })

  it('a delivery from before the telemetry existed still gets the road, just no ladder', async () => {
    setup(delivered({ fixProgress: null }))
    expect(await screen.findByTestId('score-road')).toBeTruthy()
    expect(screen.queryByTestId('delivered-attempts')).toBeNull()
  })
})
