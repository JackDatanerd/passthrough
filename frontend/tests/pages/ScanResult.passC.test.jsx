// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'

// Scan / ATS pass — what the results page shows for the cases the audit found wrong.
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
vi.mock('../../src/components/scan/AtsDetailPanel', () => ({ default: () => null }))
vi.mock('../../src/components/scan/DiffView', () => ({ default: () => null }))
vi.mock('../../src/components/scan/QuantificationPrompts', () => ({ default: () => null }))
vi.mock('../../src/components/scan/SaveProfilePrompt', () => ({ default: () => null }))
vi.mock('../../src/components/scan/FixBanner', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ResumeDataEditor', () => ({ default: () => <div data-testid="resume-editor" /> }))
vi.mock('../../src/components/scan/DeliveredResumeEditor', () => ({ default: () => <div data-testid="delivered-editor" /> }))
vi.mock('../../src/components/scan/CoverLetterPanel', () => ({ default: () => <div data-testid="cover-letter" /> }))

const JD = 'Senior engineer. '.repeat(10)
const delivered = (over = {}) => ({ id: 's1', status: 'FIX_DELIVERED', fixPurchased: true, userId: 'u1', atsScore: 85, fixAtsScore: 90, fixTier: 'FIX', fixRetryCount: 0, jobDescriptionText: JD, inputMode: 'file', rewrittenResumeData: { name: 'J' }, ...over })
function setup(scan, { path = '/scan/s1' } = {}) {
  api.get.mockImplementation(async url => url.startsWith('/payments/pending') ? { data: { data: { pending: null } } } : { data: { data: scan } })
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/scan/:id" element={<ScanResult />} /><Route path="/" element={<div>home</div>} />
  </Routes></MemoryRouter>)
}
beforeEach(() => { for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset(); auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 } })

describe('ScanResult — editor gate', () => {
  it('an uploaded file gets the editor (its preview card) before purchase, even with no structure yet', async () => {
    setup({ id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, atsScore: 60, inputMode: 'file', originalResumeData: null, userId: 'u1' })
    expect(await screen.findByTestId('resume-editor')).toBeInTheDocument()
  })
  it('a typed background with no structure yet does not', async () => {
    setup({ id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, atsScore: 60, inputMode: 'brain_dump', originalResumeData: null, userId: 'u1' })
    await screen.findByText(/Scan results|ATS/i).catch(() => {})
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(screen.queryByTestId('resume-editor')).not.toBeInTheDocument()
  })
})

describe('ScanResult — delivered resume', () => {
  it('the signed-in owner gets the editor and the cover letter panel', async () => {
    setup(delivered())
    expect(await screen.findByTestId('delivered-editor')).toBeInTheDocument()
    expect(screen.getByTestId('cover-letter')).toBeInTheDocument()
  })
  it('no cover letter panel without a stored job description; neither tool for a non-owner or a Passthrough takedown', async () => {
    setup(delivered({ jobDescriptionText: '' }))
    expect(await screen.findByTestId('delivered-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('cover-letter')).not.toBeInTheDocument()
  })
  it('hidden from someone who is not the owner', async () => {
    auth.user = { id: 'someone-else', emailVerified: true }
    setup(delivered())
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 30))
    expect(screen.queryByTestId('delivered-editor')).not.toBeInTheDocument()
  })
  it('a Badge whose file missed the bar is told why, told about the credit, and is NOT offered a retry that cannot work', async () => {
    setup(delivered({ fixTier: 'BADGE', rewrittenResumeData: null, atsScore: 82, fixAtsScore: 76 }))
    expect(await screen.findByTestId('badge-below-threshold')).toHaveTextContent(/free fix credit/)
    expect(screen.queryByRole('button', { name: /Try Again/ })).not.toBeInTheDocument()
  })
  it('a Fix below the bar still offers the free retry', async () => {
    setup(delivered({ fixAtsScore: 70, fixRetryCount: 0 }))
    expect(await screen.findByRole('button', { name: /Try Again/ })).toBeInTheDocument()
  })
  it('a total rewrite failure is disclosed even when the original already clears the bar', async () => {
    setup(delivered({ rewriteFailed: true, fixAtsScore: 90 }))
    expect(await screen.findByTestId('rewrite-failed-note')).toHaveTextContent(/free fix credit/)
  })
})

describe('ScanResult — anonymous result deletion', () => {
  const anon = { id: 's1', status: 'COMPLETE_PASS', fixPurchased: false, atsScore: 70, inputMode: 'brain_dump', userId: null, originalResumeData: { name: 'J' } }
  it('the holder of the link can delete the result now, then lands on the home page', async () => {
    auth.user = null
    api.delete.mockResolvedValue({ data: { success: true } })
    setup(anon, { path: '/scan/s1?token=tok' })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete this result now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/scan/s1?token=tok'))
    expect(await screen.findByText('home')).toBeInTheDocument()
  })
  it('declining the confirmation deletes nothing; signed-in owners do not get this control', async () => {
    auth.user = null
    setup(anon, { path: '/scan/s1?token=tok' })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete this result now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(api.delete).not.toHaveBeenCalled()
  })
})
