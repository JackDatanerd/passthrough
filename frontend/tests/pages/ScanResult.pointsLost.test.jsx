// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'
import { clearAnonScanTokens } from '../../src/lib/anonScans'

// Result screen, round 4: where the points went, from the server-supplied category weights.
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
vi.mock('../../src/components/scan/ScoreGauge', () => ({ default: () => null }))
vi.mock('../../src/components/scan/CategoryScores', () => ({ default: () => null }))
vi.mock('../../src/components/scan/QuantificationPrompts', () => ({ default: () => null }))
vi.mock('../../src/components/scan/SaveProfilePrompt', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ResumeDataEditor', () => ({ default: () => null }))
vi.mock('../../src/components/scan/DeliveredResumeEditor', () => ({ default: () => null }))
vi.mock('../../src/components/scan/CoverLetterPanel', () => ({ default: () => null }))
vi.mock('../../src/components/scan/AtsDetailPanel', () => ({ default: () => null }))

const JD = 'Senior engineer. '.repeat(10)
const W = { keywords: 0.35, format: 0.25, sections: 0.2, content: 0.2 }
const failing = (over = {}) => ({
  id: 's1', status: 'COMPLETE_FAIL', passed: false, fixPurchased: false, userId: 'u1', inputMode: 'file', jobDescriptionText: JD,
  atsScore: 52, keywordScore: 30, formatScore: 60, sectionsScore: 70, contentScore: 55, createdAt: new Date().toISOString(),
  atsDetail: { weights: W, keywords: { matched: [], missing: ['kubernetes'], warnings: [] }, sections: { found: [], missing: [] }, format: { issues: [] }, content: {}, aiMissingKeywords: [] },
  ...over,
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

describe('where your points went', () => {
  it('appears on a scored scan, ahead of the detail panel, with the real reason', async () => {
    setup(failing())
    const box = await screen.findByTestId('points-lost')
    expect(box).toHaveTextContent('48 of 100 points are missing')
    expect(box).toHaveTextContent('Missing from your resume: kubernetes')
  })
  it('is absent for a scan from an older API that sent no weights, and the rest of the page still renders', async () => {
    setup(failing({ atsDetail: { keywords: { matched: [], missing: ['kubernetes'], warnings: [] }, sections: { found: [], missing: [] }, format: { issues: [] }, content: {}, aiMissingKeywords: [] } }))
    expect(await screen.findByText('Your resume is failing ATS filters')).toBeTruthy()
    expect(screen.queryByTestId('points-lost')).toBeNull()
  })
})
