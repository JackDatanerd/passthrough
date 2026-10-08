// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'
import { clearAnonScanTokens } from '../../src/lib/anonScans'

// Scan / ATS round 3 — how the results page wires G1 (retry), G2 (formatted check), G3, G5, G7.
const auth = { user: { id: 'u1', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
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
// Stubs that expose the props the page passes down.
vi.mock('../../src/components/scan/AtsDetailPanel', () => ({ default: p => <div data-testid="ats-detail" data-title={p.title || ''} data-has-detail={String(!!p.detail)} /> }))
vi.mock('../../src/components/scan/DiffView', () => ({ default: p => <div data-testid="diff" data-edited={String(!!p.editedByUser)} /> }))
vi.mock('../../src/components/scan/FixBanner', () => ({
  default: p => <div data-testid="fixbanner"><button onClick={p.onCheckFormatted}>stub-check</button><span data-testid="fb-err">{p.checkFormattedError}</span></div>,
}))

const JD = 'Senior engineer. '.repeat(10)
function setup(scan, { path = '/scan/s1' } = {}) {
  api.get.mockImplementation(async url => url.startsWith('/payments/pending') ? { data: { data: { pending: null } } } : { data: { data: scan } })
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/scan/:id" element={<ScanResult />} /><Route path="/" element={<div>home</div>} />
  </Routes></MemoryRouter>)
}
beforeEach(() => {
  for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset()
  auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 }
  // an earlier anonymous test stores the scan's token; it must not leak into the next page render
  // (anonScans also keeps a module-level in-memory copy, which storage.clear() does not touch)
  localStorage.clear(); sessionStorage.clear(); clearAnonScanTokens()
})

describe('ScanResult — retry a failed scan in place (G1)', () => {
  const failed = (over = {}) => ({ id: 's1', status: 'ERROR', fixPurchased: false, userId: 'u1', inputMode: 'file', jobDescriptionText: JD, ...over })
  it('the owner of a failed scan can retry it: POSTs retry-scan and reloads', async () => {
    const user = userEvent.setup()
    setup(failed())
    api.post.mockResolvedValue({ data: { data: { id: 's1', status: 'PENDING' } } })
    await user.click(await screen.findByRole('button', { name: 'Retry this scan' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/scan/s1/retry-scan'))
    await waitFor(() => expect(api.get.mock.calls.filter(c => c[0] === '/scan/s1').length).toBeGreaterThanOrEqual(2))
  })
  it('a refusal is shown, and the page stays on the failed scan', async () => {
    const user = userEvent.setup()
    setup(failed())
    api.post.mockRejectedValue({ response: { data: { message: 'Daily scan limit reached' } } })
    await user.click(await screen.findByRole('button', { name: 'Retry this scan' }))
    expect(await screen.findByText(/Daily scan limit reached/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry this scan' })).toBeInTheDocument()
  })
  it('an anonymous visitor with the scan\'s token can retry, and the token travels with the request', async () => {
    const user = userEvent.setup()
    auth.user = null
    setup(failed({ userId: null, inputMode: 'brain_dump' }), { path: '/scan/s1?token=tok' })
    api.post.mockResolvedValue({ data: { data: {} } })
    await user.click(await screen.findByRole('button', { name: 'Retry this scan' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/scan/s1/retry-scan?token=tok'))
  })
  it('no retry button for someone who does not own it, or for a paid scan', async () => {
    auth.user = { id: 'someone-else', emailVerified: true }
    setup(failed())
    await screen.findByText(/Scan failed/)
    expect(screen.queryByRole('button', { name: 'Retry this scan' })).not.toBeInTheDocument()
  })
  it('"start over" for a saved-profile scan goes back into saved-profile mode', async () => {
    setup(failed({ inputMode: 'saved_profile' }))
    expect(await screen.findByRole('link', { name: 'Start over with different input' })).toHaveAttribute('href', '/?mode=savedProfile')
  })
})

describe('ScanResult — formatted-file check before a Badge (G2)', () => {
  const complete = (over = {}) => ({ id: 's1', status: 'COMPLETE_PASS', fixPurchased: false, userId: 'u1', inputMode: 'file', atsScore: 86, badgeEligible: true, jobDescriptionText: JD, atsDetail: { keywords: { matched: [], missing: [] } }, ...over })
  it('builds the formatted file, merges its score into the scan and tells the banner nothing is wrong', async () => {
    const user = userEvent.setup()
    setup(complete())
    api.post.mockResolvedValue({ data: { data: { originalResumeData: { name: 'J' }, formattedScore: 82, atsDetail: { formattedScore: 82, keywords: { matched: [], missing: [] } } } } })
    await user.click(await screen.findByRole('button', { name: 'stub-check' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/scan/s1/structure'))
    expect(screen.getByTestId('fb-err')).toHaveTextContent('')
  })
  it('a failed check is reported to the banner', async () => {
    const user = userEvent.setup()
    setup(complete())
    api.post.mockRejectedValue({ response: { data: { message: 'try again in a minute' } } })
    await user.click(await screen.findByRole('button', { name: 'stub-check' }))
    await waitFor(() => expect(screen.getByTestId('fb-err')).toHaveTextContent('try again in a minute'))
  })
})

describe('ScanResult — the job description and the delivered score\'s breakdown', () => {
  it('shows the job description that was scored (G5)', async () => {
    setup({ id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, userId: 'u1', inputMode: 'brain_dump', atsScore: 60, jobDescriptionText: JD })
    expect(await screen.findByTestId('jd-panel')).toBeInTheDocument()
  })
  const delivered = (over = {}) => ({ id: 's1', status: 'FIX_DELIVERED', fixPurchased: true, userId: 'u1', atsScore: 60, fixAtsScore: 70, fixTier: 'FIX', fixRetryCount: 0, jobDescriptionText: JD, inputMode: 'file', rewrittenResumeData: { name: 'J' }, originalResumeData: { name: 'J' }, fixAtsDetail: { keywords: { matched: [], missing: ['docker'] } }, ...over })
  it('a delivered file under the bar explains itself with its OWN breakdown (G3)', async () => {
    setup(delivered())
    const panels = await screen.findAllByTestId('ats-detail')
    expect(panels.some(p => p.dataset.title === 'Why the new score' && p.dataset.hasDetail === 'true')).toBe(true)
  })
  it('no breakdown panel once the file clears the bar, or when the rewrite failed', async () => {
    setup(delivered({ fixAtsScore: 91 }))
    await screen.findByTestId('diff')
    expect(screen.queryAllByTestId('ats-detail').some(p => p.dataset.title === 'Why the new score')).toBe(false)
  })
  it('DiffView is told when the delivered content is the owner\'s own edit (G7)', async () => {
    const edited = { name: 'J', skills: ['Redis'] }
    setup(delivered({ rewrittenResumeData: edited, userEditedResumeData: edited }))
    expect((await screen.findByTestId('diff')).dataset.edited).toBe('true')
  })
  it('...and not when it is the AI\'s rewrite', async () => {
    setup(delivered({ userEditedResumeData: null }))
    expect((await screen.findByTestId('diff')).dataset.edited).toBe('false')
  })
})
