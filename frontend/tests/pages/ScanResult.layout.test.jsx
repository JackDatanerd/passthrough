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
const setup = (scan, path = '/scan/s1') => {
  api.get.mockReset()
  api.get.mockImplementation(async url => {
    if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }
    if (url.startsWith('/scan/')) return { data: { data: { ...base, ...scan } } }
    return { data: { data: {} } }
  })
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/scan/:id" element={<ScanResult />} /><Route path="/scan/:id/:tab" element={<ScanResult />} /></Routes></MemoryRouter>)
}
beforeEach(() => { auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 } })

const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
const tabNames = () => within(screen.getByRole('navigation', { name: 'Your scan' })).getAllByRole('link').map(a => a.textContent.replace('new', '').trim())

describe('ScanResult — while the fix is being written', () => {
  it.each(['FIX_PURCHASED', 'FIX_GENERATING'])('%s: opens on Your resume and shows only the rewrite, with the score, offer and editors out of the way', async status => {
    setup({ status })
    expect(await screen.findByTestId('rewriting-focus')).toHaveTextContent(/rewriting your resume/i)
    expect(screen.getByTestId('rewriting-focus')).toHaveTextContent(/started at 52\/100/)
    expect(screen.getByText(/Generating your fixed resume/)).toBeInTheDocument()
    expect(tabNames()).toEqual(['Score', 'Why', 'Your resume'])
    expect(screen.getByRole('link', { name: 'Your resume' })).toHaveAttribute('aria-current', 'page')
    for (const id of ['score-gauge', 'ats-detail', 'points-lost', 'jd-panel', 'fix-banner', 'resume-data-editor', 'save-profile', 'diff-view', 'cover-letter'])
      expect(screen.queryByTestId(id), id).toBeNull()
    expect(screen.queryByText(/failing ATS filters/)).toBeNull()
  })
})

describe('ScanResult — before purchase: Score and Why', () => {
  const unpaid = { status: 'COMPLETE_FAIL', fixPurchased: false, inputMode: 'file' }

  it('shows two steps only, and Score leads with the number, the offer and the three biggest reasons', async () => {
    setup(unpaid)
    const gauge = await screen.findByTestId('score-gauge')
    expect(tabNames()).toEqual(['Score', 'Why'])
    expect(screen.getByRole('link', { name: 'Score' })).toHaveAttribute('aria-current', 'page')
    expect(follows(gauge, screen.getByTestId('points-lost'))).toBe(true)
    expect(screen.getByTestId('fix-banner')).toBeInTheDocument()
    // The long explanations are the next step, not part of this one.
    for (const id of ['ats-detail', 'jd-panel', 'resume-data-editor']) expect(screen.queryByTestId(id), id).toBeNull()
    expect(screen.queryByTestId('rewriting-focus')).toBeNull()
  })

  it('Why holds the explanations and the editor, and ends on the way back to the offer', async () => {
    setup(unpaid, '/scan/s1/why')
    expect(await screen.findByTestId('ats-detail')).toBeInTheDocument()
    const order = [screen.getByTestId('ats-detail'), screen.getByTestId('jd-panel'), screen.getByTestId('resume-data-editor')]
    for (let i = 1; i < order.length; i++) expect(follows(order[i - 1], order[i])).toBe(true)
    expect(screen.queryByTestId('fix-banner')).toBeNull()
    expect(screen.getByRole('link', { name: /See the fix/ })).toHaveAttribute('href', '/scan/s1')
  })

  it('an address for a step that has not been earned lands on the score', async () => {
    setup(unpaid, '/scan/s1/apply')
    expect(await screen.findByTestId('score-gauge')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Score' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('tab-apply')).toBeNull()
  })
})

describe('ScanResult — once the fix is delivered: four steps', () => {
  const delivered = { status: 'FIX_DELIVERED', fixAtsScore: 88, hasPdf: true, fixRetryCount: 0, verificationUrl: 'https://v.example/abc', verificationStatus: 'ACTIVE', quantificationPrompts: [{ id: 1 }] }

  it('the scan address opens on Your resume, and every earned step is a tab', async () => {
    setup(delivered)
    await screen.findByTestId('tab-resume')
    expect(tabNames()).toEqual(['Score', 'Why', 'Your resume', 'Apply'])
    expect(screen.getByRole('link', { name: 'Your resume' })).toHaveAttribute('aria-current', 'page')
  })

  it('Your resume leads with the new resume: summary, downloads, the before and after, the prompts, the editor', async () => {
    setup(delivered)
    const summary = await screen.findByTestId('delivered-summary-stub')
    const chain = [summary, screen.getByRole('button', { name: /Download \.docx/ }), screen.getByTestId('diff-view'), screen.getByTestId('quant'), screen.getByTestId('delivered-editor')]
    for (let i = 1; i < chain.length; i++) expect(follows(chain[i - 1], chain[i]), `item ${i}`).toBe(true)
    // What belongs to Apply, and to the scan before the fix, is not here.
    for (const id of ['cover-letter', 'sharing-tools', 'score-gauge', 'fix-banner', 'resume-data-editor']) expect(screen.queryByTestId(id), id).toBeNull()
  })

  it('Score still tells the original story, and points to the result', async () => {
    setup(delivered, '/scan/s1/score')
    expect(await screen.findByTestId('score-gauge')).toBeInTheDocument()
    expect(screen.getByText(/Your fixed resume scores 88/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute('href', '/scan/s1/resume')
    expect(screen.queryByTestId('fix-banner')).toBeNull()
    expect(screen.getByText(/You've got the fix/)).toBeInTheDocument()
  })

  it('Apply holds the cover letter and the verification link, badge and sharing options (open)', async () => {
    setup(delivered, '/scan/s1/apply')
    const sharing = await screen.findByTestId('sharing-tools')
    expect(sharing.tagName).toBe('DETAILS')
    expect(sharing).toHaveAttribute('open')
    expect(within(sharing).getByLabelText('Allow public .docx download')).toBeInTheDocument()
    expect(within(sharing).getByLabelText('Hide my name on the public page')).toBeInTheDocument()
    expect(within(sharing).getByText('Unpublish verification page')).toBeInTheDocument()
    expect(screen.getByTestId('cover-letter')).toBeInTheDocument()
  })

  it('a Fix-only delivery (no verification link) has no sharing section', async () => {
    setup({ ...delivered, fixTier: 'FIX_PLAIN', verificationUrl: null }, '/scan/s1/apply')
    await screen.findByTestId('tab-apply')
    expect(screen.queryByTestId('sharing-tools')).toBeNull()
  })
})
