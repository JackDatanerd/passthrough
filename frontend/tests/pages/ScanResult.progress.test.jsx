// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'
import { clearAnonScanTokens } from '../../src/lib/anonScans'

// Waiting screens, round 2: the status poller must carry the job stage / fix progress into the visible steps (migration 0088).
const auth = { user: { id: 'u1', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
const downloads = []
vi.mock('../../src/lib/utils', async orig => ({ ...(await orig()), downloadBlob: (blob, name) => { downloads.push(name) } }))
vi.mock('@paystack/inline-js', () => ({ default: class { resumeTransaction() {} } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ScoreGauge', () => ({ default: () => null }))
vi.mock('../../src/components/scan/CategoryScores', () => ({ default: () => null }))
vi.mock('../../src/components/scan/QuantificationPrompts', () => ({ default: () => null }))
vi.mock('../../src/components/scan/SaveProfilePrompt', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ResumeDataEditor', () => ({ default: () => null }))
vi.mock('../../src/components/scan/DeliveredResumeEditor', () => ({ default: () => null }))
vi.mock('../../src/components/scan/CoverLetterPanel', () => ({ default: () => null }))
vi.mock('../../src/components/scan/AtsDetailPanel', () => ({ default: () => null }))

const JD = 'Senior engineer. '.repeat(10)
const now = () => new Date().toISOString()
const current = () => document.querySelector('[aria-current="step"]')?.textContent || ''
function setup(scan, statusReply) {
  api.get.mockImplementation(async url => {
    if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }
    if (url.startsWith('/scan/status/')) return { data: { data: statusReply } }
    return { data: { data: scan } }
  })
  return render(<MemoryRouter initialEntries={['/scan/s1']}><Routes>
    <Route path="/scan/:id" element={<ScanResult />} /><Route path="/scan/:id/:tab" element={<ScanResult />} />
  </Routes></MemoryRouter>)
}
beforeEach(() => {
  for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset()
  auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 }
  localStorage.clear(); sessionStorage.clear(); clearAnonScanTokens()
})

describe('the status poll carries the job telemetry into the waiting screens', () => {
  it('a scan that moves from reading to scoring (same status) advances the steps without a full refetch', async () => {
    setup(
      { id: 's1', status: 'SCANNING', scanStage: 'reading', userId: 'u1', inputMode: 'file', jobDescriptionText: JD, createdAt: now() },
      { status: 'SCANNING', scanStage: 'scoring', fixProgress: null },
    )
    await waitFor(() => expect(current()).toContain('Reading your file'))
    await waitFor(() => expect(current()).toContain('Matching the job'), { timeout: 8000 })
    const fullFetches = api.get.mock.calls.filter(c => c[0] === '/scan/s1').length
    expect(fullFetches).toBe(1)   // the poll used the small status endpoint; the full scan was fetched once
  }, 15000)

  it('a fix shows the real attempt ladder as soon as the status endpoint reports a finished attempt', async () => {
    const fp = (over = {}) => ({ startedAt: now(), round: 0, phase: 'rewriting', attempt: 1, of: 3, scores: [], ...over })
    setup(
      { id: 's1', status: 'FIX_GENERATING', fixPurchased: true, fixTier: 'FIX', fixRetryCount: 0, atsScore: 60, passed: false,
        userId: 'u1', inputMode: 'file', jobDescriptionText: JD, createdAt: now(), updatedAt: now(), fixProgress: fp() },
      { status: 'FIX_GENERATING', scanStage: null, fixProgress: fp({ phase: 'rewriting', attempt: 2, scores: [71] }) },
    )
    await screen.findByText('Generating your fixed resume…')
    expect(screen.queryByTestId('fix-attempts')).toBeNull()
    expect(await screen.findByTestId('fix-attempts', {}, { timeout: 8000 })).toHaveTextContent('Attempt 1: 71')
    expect(screen.getByTestId('fix-attempts')).toHaveTextContent('Attempt 2: rewriting…')
  }, 15000)
})
