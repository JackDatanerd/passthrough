// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'
import { clearAnonScanTokens } from '../../src/lib/anonScans'

// Scan / ATS round 10 — upgrading a delivered credential-only (Badge) purchase to the full Fix with a free credit.
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
vi.mock('../../src/components/scan/DiffView', () => ({ default: () => null }))
vi.mock('../../src/components/scan/FixBanner', () => ({ default: () => null }))

const JD = 'Senior engineer. '.repeat(10)
function setup(scan, { path = '/scan/s1' } = {}) {
  api.get.mockImplementation(async url => url.startsWith('/payments/pending') ? { data: { data: { pending: null } } } : { data: { data: scan } })
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/scan/:id" element={<ScanResult />} /><Route path="/scan/:id/:tab" element={<ScanResult />} /><Route path="/" element={<div>home</div>} />
  </Routes></MemoryRouter>)
}
beforeEach(() => {
  for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset()
  auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 }
  downloads.length = 0
  localStorage.clear(); sessionStorage.clear(); clearAnonScanTokens()
})

const delivered = (over = {}) => ({
  id: 's1', status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'BADGE', userId: 'u1', inputMode: 'file', jobDescriptionText: JD,
  atsScore: 85, fixAtsScore: 85, rewriteFailed: false, fixRetryCount: 0, verificationUrl: 'https://p.example/verify/AB12CD',
  verificationStatus: 'ACTIVE', resumeAtsPath: 'x.docx', ...over,
})

describe('Badge -> Fix upgrade on the delivered screen', () => {
  it('offers the upgrade to a Badge owner who has a free credit, and posts to the upgrade endpoint', async () => {
    auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 2 }
    api.post.mockResolvedValue({ data: { success: true } })
    setup(delivered())
    const panel = await screen.findByTestId('badge-upgrade')
    expect(panel).toHaveTextContent('Upgrade this resume to the full Fix')
    await userEvent.click(screen.getByRole('button', { name: /Use a free credit \(2 available\)/ }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/scan/s1/upgrade-to-fix'))
    await waitFor(() => expect(auth.refreshUser).toHaveBeenCalled())
  })
  it('shows nothing when there is no credit', async () => {
    setup(delivered())
    await screen.findByText(/Passthrough Verified resume is ready/)
    expect(screen.queryByTestId('badge-upgrade')).toBeNull()
  })
  it('shows nothing for a Fix (only credential-only purchases can be upgraded)', async () => {
    auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 2 }
    setup(delivered({ fixTier: 'FIX', rewrittenResumeData: { name: 'A' } }))
    await screen.findByText(/Passthrough Verified resume is ready/)
    expect(screen.queryByTestId('badge-upgrade')).toBeNull()
  })
  it('surfaces the server\'s refusal and keeps the button usable', async () => {
    auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 1 }
    api.post.mockRejectedValue({ response: { data: { message: 'This purchase was refunded or is under dispute, so it can no longer be changed or regenerated.' } } })
    setup(delivered())
    await userEvent.click(await screen.findByRole('button', { name: /Use a free credit/ }))
    expect(await screen.findByText(/refunded or is under dispute/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Use a free credit/ })).toBeEnabled()
  })
  it('a Badge that missed the bar points at the upgrade, not at scanning the resume again', async () => {
    auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 1 }
    setup(delivered({ atsScore: 85, fixAtsScore: 72 }))
    const note = await screen.findByTestId('badge-below-threshold')
    expect(note).toHaveTextContent(/upgrade this same resume to the full Fix/)
    expect(note).not.toHaveTextContent(/scan it again/)
    expect(screen.getByTestId('badge-upgrade')).toBeInTheDocument()
  })
})

describe('a Try Again that found nothing better says so', () => {
  const below = (over = {}) => delivered({ fixTier: 'FIX', atsScore: 60, fixAtsScore: 70, rewrittenResumeData: { name: 'A' }, fixRetryCount: 1, ...over })
  it('shows the note when the last retry kept the previous result', async () => {
    setup(below({ retryNoGain: true }))
    expect(await screen.findByTestId('retry-no-gain')).toHaveTextContent(/didn't find a better version/)
  })
  it('does not show it otherwise', async () => {
    setup(below({ retryNoGain: false }))
    await screen.findByText(/Your improved resume is ready/)
    expect(screen.queryByTestId('retry-no-gain')).toBeNull()
  })
})

describe('round 18: a first run that kept the person\'s own resume does not call it "improved"', () => {
  const same = { name: 'A', experience: [{ company: 'Acme', bullets: ['Built things'] }] }
  const first = (over = {}) => delivered({ fixTier: 'FIX', atsScore: 60, fixAtsScore: 70, fixRetryCount: 0, originalResumeData: same, rewrittenResumeData: { ...same }, ...over })
  it('says the original was kept, with the score and the credit', async () => {
    setup(first())
    expect(await screen.findByTestId('original-kept')).toHaveTextContent(/None of our rewrites beat your original/)
    expect(screen.queryByText(/Your improved resume is ready/)).toBeNull()
  })
  it('a genuinely rewritten resume still reads "improved"', async () => {
    setup(first({ rewrittenResumeData: { ...same, summary: 'New summary' } }))
    await screen.findByText(/Your improved resume is ready/)
    expect(screen.queryByTestId('original-kept')).toBeNull()
  })
  it('a Try Again round (retry count above zero) keeps its own wording', async () => {
    setup(first({ fixRetryCount: 1 }))
    await screen.findByText(/Your improved resume is ready/)
    expect(screen.queryByTestId('original-kept')).toBeNull()
  })
})
