// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'
import { clearAnonScanTokens } from '../../src/lib/anonScans'

// Scan / ATS round 4 — what the results page says when a scan fails, and what a delivered file is called.
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
vi.mock('../../src/components/scan/DiffView', () => ({ default: () => null }))
vi.mock('../../src/components/scan/FixBanner', () => ({ default: () => null }))

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
  downloads.length = 0
  localStorage.clear(); sessionStorage.clear(); clearAnonScanTokens()
})

const failed = (over = {}) => ({ id: 's1', status: 'ERROR', fixPurchased: false, userId: 'u1', inputMode: 'file', jobDescriptionText: JD, ...over })

describe('a failed scan says why', () => {
  it.each([
    ['NO_TEXT', 'This PDF has no selectable text — it looks like a scan.'],
    ['ENCRYPTED_PDF', 'This PDF is password-protected, so we cannot read it.'],
    ['TOO_MANY_PAGES', 'This PDF is longer than 12 pages.'],
  ])('%s: shows its own message, no retry button, and points at a new upload', async (code, message) => {
    setup(failed({ failure: { code, message, retryable: false } }))
    expect(await screen.findByTestId('scan-failure-message')).toHaveTextContent(message)
    expect(screen.queryByRole('button', { name: 'Retry this scan' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Upload a different file' })).toHaveAttribute('href', '/')
  })
  it('a typed background that needs more detail says so and links back to the box', async () => {
    setup(failed({ inputMode: 'brain_dump', failure: { code: 'NEEDS_MORE_DETAIL', message: 'Tell us a little more about your roles.', retryable: false } }))
    expect(await screen.findByTestId('scan-failure-message')).toHaveTextContent('Tell us a little more about your roles.')
    expect(screen.queryByRole('button', { name: 'Retry this scan' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Add more detail and try again' })).toHaveAttribute('href', '/?mode=brainDump')
  })
  it('a problem on our side keeps the retry button and the existing reassurance', async () => {
    setup(failed({ failure: { code: 'SYSTEM', message: 'Something went wrong on our side while scoring this resume.', retryable: true } }))
    expect(await screen.findByRole('button', { name: 'Retry this scan' })).toBeInTheDocument()
    expect(screen.getByTestId('scan-failure-message')).toHaveTextContent(/temporary problem on our side/)
    expect(screen.getByRole('link', { name: 'Start over with different input' })).toBeInTheDocument()
  })
  it('a retryable structuring failure uses the server\'s message and offers the retry', async () => {
    setup(failed({ inputMode: 'brain_dump', failure: { code: 'STRUCTURE_FAILED', message: 'We could not turn your background into a resume this time.', retryable: true } }))
    expect(await screen.findByTestId('scan-failure-message')).toHaveTextContent('We could not turn your background into a resume this time.')
    expect(screen.getByRole('button', { name: 'Retry this scan' })).toBeInTheDocument()
  })
  it('a scan stored before failure codes existed behaves exactly as it did', async () => {
    setup(failed({ failure: null }))
    expect(await screen.findByRole('button', { name: 'Retry this scan' })).toBeInTheDocument()
    expect(screen.getByTestId('scan-failure-message')).toHaveTextContent(/couldn't read your resume/)
  })
  it('a paid fix that failed still gets the payment reassurance, never a scan-failure message', async () => {
    setup(failed({ fixPurchased: true, failure: { code: 'SYSTEM', message: 'x', retryable: true } }))
    expect(await screen.findByText(/Your payment went through and isn't lost/)).toBeInTheDocument()
    expect(screen.queryByTestId('scan-failure-message')).toBeNull()
  })
})

describe('delivered files are named for the candidate', () => {
  const delivered = (over = {}) => ({ id: 's1', status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'FIX', userId: 'u1', inputMode: 'file', jobDescriptionText: JD, atsScore: 70, fixAtsScore: 86, hasPdf: true, resumeAtsPath: 'k', downloadStem: 'Jane-Doe-Resume', ...over })
  it('the .docx and the .pdf both use the name the server gave', async () => {
    const user = userEvent.setup()
    setup(delivered())
    api.get.mockImplementation(async url => url.startsWith('/payments/pending') ? { data: { data: { pending: null } } } : url.includes('/download') ? { data: new Blob(['x']) } : { data: { data: delivered() } })
    await user.click(await screen.findByRole('button', { name: /Download \.docx/ }))
    await waitFor(() => expect(downloads).toContain('Jane-Doe-Resume.docx'))
    await user.click(screen.getByRole('button', { name: /Download .*PDF/ }))
    await waitFor(() => expect(downloads).toContain('Jane-Doe-Resume.pdf'))
  })
  it('falls back to "Resume" when the server sent no name (an older response)', async () => {
    const user = userEvent.setup()
    setup(delivered({ downloadStem: undefined }))
    api.get.mockImplementation(async url => url.startsWith('/payments/pending') ? { data: { data: { pending: null } } } : url.includes('/download') ? { data: new Blob(['x']) } : { data: { data: delivered({ downloadStem: undefined }) } })
    await user.click(await screen.findByRole('button', { name: /Download \.docx/ }))
    await waitFor(() => expect(downloads).toEqual(['Resume.docx']))
  })
})
