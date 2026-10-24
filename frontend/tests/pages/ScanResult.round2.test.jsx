// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanResult from '../../src/pages/ScanResult'

// Tabs: how the steps move.
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
vi.mock('../../src/components/scan/ScoreSummary', () => stub('score-summary'))
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
vi.mock('../../src/components/scan/FixBanner', () => ({ default: ({ scan, onPay, children }) => <div><button type="button" data-testid="fix-banner" onClick={() => onPay('FIX')}>offer-for-{scan.id}</button>{children}</div> }))

const ticks = vi.hoisted(() => ({ fns: [] }))
vi.mock('../../src/lib/poller', async orig => ({ ...(await orig()), createPoller: fn => { ticks.fns.push(fn); return { start: (o = {}) => { if (o.immediate !== false) fn() }, stop: () => {} } } }))
const mk = (o = {}) => ({ id: 's1', userId: 'u1', atsScore: 52, passed: false, inputMode: 'text', status: 'COMPLETE_FAIL', fixPurchased: false, fixTier: 'FIX',
  jobDescriptionText: 'x'.repeat(80), originalResumeData: { name: 'A' }, rewrittenResumeData: { name: 'A' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...o })
let db
function Keyed() { const { id } = useParams(); return <ScanResult key={id} /> }
function Where() { const l = useLocation(); const n = useNavigate(); return <><p data-testid="where">{l.pathname}{l.search}</p><button type="button" onClick={() => n('/scan/s2')}>go-s2</button></> }
const setup = (scans, path) => {
  db = scans; ticks.fns.length = 0; api.get.mockReset(); api.post.mockReset()
  api.get.mockImplementation(async url => {
    if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }
    const id = url.split('/')[2].split('?')[0]
    if (url.includes('/status')) return { data: { data: { status: db[id].status, atsScore: db[id].atsScore } } }
    return { data: { data: db[id] } }
  })
  return render(<MemoryRouter initialEntries={[path]}><Where /><Routes><Route path="/scan/:id" element={<Keyed />} /><Route path="/scan/:id/:tab" element={<Keyed />} /></Routes></MemoryRouter>)
}
beforeEach(() => { auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 } })
const where = () => screen.getByTestId('where').textContent
const nav = () => screen.getByRole('navigation', { name: 'Your scan' })

describe('ScanResult — one result per address', () => {
  it('moving from one result to another never shows the first one under the second address', async () => {
    let release
    setup({ s1: mk({ id: 's1' }), s2: mk({ id: 's2' }) }, '/scan/s1')
    await screen.findByText('offer-for-s1')
    const real = api.get.getMockImplementation()
    api.get.mockImplementation(async url => { if (url.startsWith('/scan/s2') && !url.includes('/status')) await new Promise(r => { release = r }); return real(url) })
    await act(async () => { fireEvent.click(screen.getByText('go-s2')) })
    expect(screen.queryByText('offer-for-s1')).toBeNull()
    await act(async () => { release?.() })
    expect(await screen.findByText('offer-for-s2')).toBeInTheDocument()
  })
})

describe('ScanResult — heading, strip, Apply kept', () => {
  it('names the page after the job, with the file and date under it, and pins the score on every step', async () => {
    setup({ s1: mk({ jobTitle: 'Product Manager, Payments', resumeOriginalName: 'cv.pdf', inputMode: 'file', status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 84, verificationUrl: 'https://v/x' }) }, '/scan/s1/resume')
    expect(await screen.findByRole('heading', { level: 1, name: 'Product Manager, Payments' })).toBeInTheDocument()
    const strip = screen.getByTestId('scan-strip')
    expect(strip).toHaveTextContent('84 out of 100, after the fix')
    expect(strip).toHaveTextContent('Scored 52 before')
    expect(within(strip).getByText('Verified').closest('li')).toHaveClass('border-green-700')
  })
  it('a retry in progress keeps the Apply step, and the Verified link stays on it', async () => {
    setup({ s1: mk({ status: 'FIX_GENERATING', fixPurchased: true, fixRetryCount: 1, fixAtsScore: 77, verificationUrl: 'https://v/x' }) }, '/scan/s1/apply')
    await screen.findByTestId('tab-apply')
    expect(within(nav()).getByRole('link', { name: /Apply/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('being rewritten again')
  })
  it('a delivery under 80 says why there is no Verified link, and how far away it is', async () => {
    setup({ s1: mk({ status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 77, verificationUrl: null }) }, '/scan/s1/apply')
    const card = await screen.findByTestId('verified-locked')
    expect(card).toHaveTextContent('earned at 80')
    expect(card).toHaveTextContent('3 points away')
    expect(within(screen.getByTestId('scan-strip')).getByText('Verified').closest('li')).toHaveTextContent('at 80')
  })
})

describe('ScanResult — a signed-out visitor who wants to buy', () => {
  it('is told an account comes first and sent back here after it, not sent away', async () => {
    auth.user = null
    setup({ s1: mk({ userId: null, anonExpiresAt: new Date(Date.now() + 5 * 3600000).toISOString() }) }, '/scan/s1?token=abc')
    expect(await screen.findAllByTestId('anon-banner')).toHaveLength(1)
    expect(screen.queryByText('Save your results')).toBeNull()
    expect(screen.queryByTestId('buy-gate')).toBeNull()
    await act(async () => { fireEvent.click(await screen.findByTestId('fix-banner')) })
    const gate = screen.getByTestId('buy-gate')
    expect(where()).toBe('/scan/s1?token=abc')
    expect(within(gate).getByRole('link', { name: /Create account and continue/ })).toHaveAttribute('href', `/register?next=${encodeURIComponent('/scan/s1?token=abc')}`)
    expect(within(gate).getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', `/login?next=${encodeURIComponent('/scan/s1?token=abc')}`)
    expect(api.post).not.toHaveBeenCalled()
  })
})
