// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'

// Launch batch: once a fix is paid for the screen is about the rewrite; once it is delivered the page leads with the new
// resume, then the cover letter, and the original scan's panels are collapsed out of the way.
const auth = { user: { id: 'u1', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), defaults: { baseURL: 'https://api.example/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('@paystack/inline-js', () => ({ default: class {} }))
const stub = vi.hoisted(() => (name) => ({ default: () => <div data-testid={name} /> }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ScoreGauge', () => stub('score-gauge'))
vi.mock('../../src/components/scan/CategoryScores', () => ({ default: () => null }))
vi.mock('../../src/components/scan/AtsDetailPanel', () => stub('ats-detail'))
vi.mock('../../src/components/scan/PointsLost', () => stub('points-lost'))
vi.mock('../../src/components/scan/JobDescriptionPanel', () => stub('jd-panel'))
vi.mock('../../src/components/scan/DiffView', () => stub('diff-view'))
vi.mock('../../src/components/scan/DeliveredSummary', () => stub('delivered-summary-stub'))
vi.mock('../../src/components/scan/ResumeDataEditor', () => stub('resume-data-editor'))
vi.mock('../../src/components/scan/DeliveredResumeEditor', () => stub('delivered-editor'))
vi.mock('../../src/components/scan/QuantificationPrompts', () => stub('quant'))
vi.mock('../../src/components/scan/CoverLetterPanel', () => stub('cover-letter'))
vi.mock('../../src/components/scan/SaveProfilePrompt', () => stub('save-profile'))
vi.mock('../../src/components/scan/FixBanner', () => stub('fix-banner'))

const base = { id: 's1', userId: 'u1', atsScore: 52, passed: false, inputMode: 'text', fixPurchased: true, fixTier: 'FIX',
  jobDescriptionText: 'x'.repeat(80), originalResumeData: { name: 'A' }, rewrittenResumeData: { name: 'A' }, updatedAt: new Date().toISOString() }
const setup = scan => {
  api.get.mockReset()
  api.get.mockImplementation(async url => {
    if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }
    if (url.startsWith('/scan/')) return { data: { data: { ...base, ...scan } } }
    return { data: { data: {} } }
  })
  return render(<MemoryRouter initialEntries={['/scan/s1']}><Routes><Route path="/scan/:id" element={<ScanResult />} /></Routes></MemoryRouter>)
}
beforeEach(() => { auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 } })

describe('ScanResult — while the fix is being written', () => {
  it.each(['FIX_PURCHASED', 'FIX_GENERATING'])('%s: shows only the rewrite, with the score, offer and editors out of the way', async status => {
    setup({ status })
    expect(await screen.findByTestId('rewriting-focus')).toHaveTextContent(/rewriting your resume/i)
    expect(screen.getByTestId('rewriting-focus')).toHaveTextContent(/started at 52\/100/)
    expect(screen.getByText(/Generating your fixed resume/)).toBeInTheDocument()
    for (const id of ['score-gauge', 'ats-detail', 'points-lost', 'jd-panel', 'fix-banner', 'resume-data-editor', 'save-profile', 'diff-view', 'cover-letter'])
      expect(screen.queryByTestId(id), id).toBeNull()
    expect(screen.queryByText(/failing ATS filters/)).toBeNull()
  })
})

describe('ScanResult — before purchase nothing moved', () => {
  it('still leads with the score, then the offer, then the explanations', async () => {
    setup({ status: 'COMPLETE_FAIL', fixPurchased: false, inputMode: 'file' })
    const gauge = await screen.findByTestId('score-gauge')
    const order = [gauge, screen.getByTestId('fix-banner'), screen.getByTestId('points-lost'), screen.getByTestId('jd-panel'), screen.getByTestId('resume-data-editor')]
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('rewriting-focus')).toBeNull()
  })
})

describe('ScanResult — once the fix is delivered', () => {
  const delivered = { status: 'FIX_DELIVERED', fixAtsScore: 88, hasPdf: true, fixRetryCount: 0, verificationUrl: 'https://v.example/abc', verificationStatus: 'ACTIVE', quantificationPrompts: [{ id: 1 }] }
  const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('leads with the new resume, then the cover letter, then the rest', async () => {
    setup(delivered)
    const summary = await screen.findByTestId('delivered-summary-stub')
    const diff = screen.getByTestId('diff-view')
    const downloads = screen.getByRole('button', { name: /Download \.docx/ })
    const letter = screen.getByTestId('cover-letter')
    const quant = screen.getByTestId('quant')
    const editor = screen.getByTestId('delivered-editor')
    const sharing = screen.getByTestId('sharing-tools')
    const original = screen.getByTestId('original-scan-details')
    const chain = [summary, downloads, diff, letter, quant, editor, sharing, original]
    for (let i = 1; i < chain.length; i++) expect(follows(chain[i - 1], chain[i]), `item ${i}`).toBe(true)
  })

  it('collapses the original scan: its gauge and panels live inside "Your original scan", never beside the result', async () => {
    setup(delivered)
    const original = await screen.findByTestId('original-scan-details')
    expect(original.tagName).toBe('DETAILS')
    expect(original).not.toHaveAttribute('open')
    for (const id of ['score-gauge', 'points-lost', 'jd-panel']) expect(within(original).getByTestId(id)).toBeInTheDocument()
    expect(screen.queryByTestId('fix-banner')).toBeNull()
    expect(screen.queryByTestId('resume-data-editor')).toBeNull()
  })

  it('keeps the verification link, badge and sharing options, collapsed, after the cover letter', async () => {
    setup(delivered)
    const sharing = await screen.findByTestId('sharing-tools')
    expect(sharing.tagName).toBe('DETAILS')
    expect(sharing).not.toHaveAttribute('open')
    expect(within(sharing).getByLabelText('Allow public .docx download')).toBeInTheDocument()
    expect(within(sharing).getByLabelText('Hide my name on the public page')).toBeInTheDocument()
    expect(within(sharing).getByText('Unpublish verification page')).toBeInTheDocument()
  })

  it('a Fix-only delivery (no verification link) has no sharing section', async () => {
    setup({ ...delivered, fixTier: 'FIX_PLAIN', verificationUrl: null })
    await screen.findByTestId('original-scan-details')
    expect(screen.queryByTestId('sharing-tools')).toBeNull()
  })
})
