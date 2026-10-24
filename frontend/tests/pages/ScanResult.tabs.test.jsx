// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
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

const ticks = vi.hoisted(() => ({ fns: [] }))
vi.mock('../../src/lib/poller', async orig => ({ ...(await orig()), createPoller: fn => { ticks.fns.push(fn); return { start: (o = {}) => { if (o.immediate !== false) fn() }, stop: () => {} } } }))
const base = { id: 's1', userId: 'u1', atsScore: 52, passed: false, inputMode: 'text', status: 'COMPLETE_FAIL', fixPurchased: false, fixTier: 'FIX',
  jobDescriptionText: 'x'.repeat(80), originalResumeData: { name: 'A' }, rewrittenResumeData: { name: 'A' }, updatedAt: new Date().toISOString() }
let current
const setup = (scan, path = '/scan/s1') => {
  current = { ...base, ...scan }
  ticks.fns.length = 0
  api.get.mockReset()
  api.get.mockImplementation(async url => {
    if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }
    if (url.includes('/status')) return { data: { data: { status: current.status, atsScore: current.atsScore } } }
    if (url.startsWith('/scan/')) return { data: { data: current } }
    return { data: { data: {} } }
  })
  function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p> }
  return render(<MemoryRouter initialEntries={[path]}><Where /><Routes><Route path="/scan/:id" element={<ScanResult />} /><Route path="/scan/:id/:tab" element={<ScanResult />} /></Routes></MemoryRouter>)
}
const applyTab = () => within(screen.getByRole('navigation', { name: 'Your scan' })).getByRole('link', { name: /Apply/ })
const where = () => screen.getByTestId('where').textContent
beforeEach(() => { auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 0 } })
const advance = async status => { current = { ...current, status, fixPurchased: true }; await act(async () => { for (const f of ticks.fns) await f() }) }

describe('ScanResult — addresses keep the visitor token', () => {
  it('an unearned step goes back to the score with ?token= intact', async () => {
    setup({}, '/scan/s1/apply?token=abc')
    await screen.findByTestId('score-gauge')
    expect(where()).toBe('/scan/s1?token=abc')
  })
  it('an unknown step does the same', async () => {
    setup({}, '/scan/s1/nonsense?token=abc')
    await screen.findByTestId('score-gauge')
    expect(where()).toBe('/scan/s1?token=abc')
  })
  it('a bare address of a paid scan moves to Your resume, token kept', async () => {
    setup({ status: 'FIX_GENERATING', fixPurchased: true }, '/scan/s1?token=abc')
    await screen.findByTestId('rewriting-focus')
    expect(where()).toBe('/scan/s1/resume?token=abc')
  })
})

describe('ScanResult — the screen follows the scan', () => {
  it('a payment that lands while on the score moves the screen to Your resume', async () => {
    setup({})
    await screen.findByTestId('score-gauge')
    expect(where()).toBe('/scan/s1')
    await advance('FIX_GENERATING')
    await waitFor(() => expect(where()).toBe('/scan/s1/resume'))
    expect(await screen.findByTestId('rewriting-focus')).toBeInTheDocument()
  })

  it('a delivery while on Your resume does not move the person, but marks Apply as new until it is opened', async () => {
    setup({ status: 'FIX_GENERATING', fixPurchased: true }, '/scan/s1/resume')
    await screen.findByTestId('rewriting-focus')
    await advance('FIX_DELIVERED')
    await screen.findByTestId('diff-view')
    expect(where()).toBe('/scan/s1/resume')
    const apply = applyTab()
    expect(apply).toHaveTextContent('new')
    fireEvent.click(apply)
    expect(await screen.findByTestId('cover-letter')).toBeInTheDocument()
    expect(applyTab()).not.toHaveTextContent('new')
  })

  it('opening a scan that is already delivered shows no dot', async () => {
    setup({ status: 'FIX_DELIVERED', fixPurchased: true }, '/scan/s1/resume')
    await screen.findByTestId('diff-view')
    expect(applyTab()).not.toHaveTextContent('new')
  })
})
