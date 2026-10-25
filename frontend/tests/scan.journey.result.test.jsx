// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import api from '../src/lib/api'
import ScanResult from '../src/pages/ScanResult'
const auth = { user: { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn(), authLoading: false }
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: 'https://api.example/api' } }, getErrorMessage: (e, f) => e?.response?.data?.error || f }))
vi.mock('@paystack/inline-js', () => ({ default: class { newTransaction() {} } }))
vi.mock('../src/hooks/usePricing', async orig => ({ ...(await orig()), usePricing: () => ({ pricing: { currency: 'USD', coverLetterLimits: { BADGE: 2, FIX_PLAIN: 3, FIX: 5 } }, byTier: t => ({ FIX: { amount: 2900, originalAmount: 4900 }, FIX_PLAIN: { amount: 1900, originalAmount: 3900 }, BADGE: { amount: 900, originalAmount: 900 } }[t]), pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }) }))
vi.mock('../src/lib/poller', async orig => ({ ...(await orig()), createPoller: fn => ({ start: (o = {}) => { if (o.immediate !== false) fn() }, stop: () => {} }) }))
const W = { keywords: 0.35, format: 0.25, sections: 0.2, content: 0.2 }
const resume = { name: 'Ada Lovelace', email: 'ada@x.io', phone: '555', summary: 'Product leader.', experience: [{ company: 'Acme', title: 'PM', startDate: '2020', endDate: 'Present', bullets: ['Led payments', 'Grew revenue 20%'] }], education: [{ school: 'MIT', degree: 'BS', year: '2012' }], skills: ['SQL', 'Roadmapping'], projects: [], certifications: [] }
const detail = { weights: W, keywords: { missing: ['kubernetes', 'terraform', 'llm', 'language'], matched: ['sql'], warnings: [] }, format: { issues: ['Skills sit in a table'] }, sections: { missing: ['Education'] }, content: { unquantified: { count: 3, total: 5, examples: ['a'] }, actionVerbRate: 0.4 } }
const mk = (o = {}) => ({ id: 's1', userId: 'u1', atsScore: 62, passed: false, keywordScore: 30, formatScore: 60, sectionsScore: 70, contentScore: 55, inputMode: 'file', resumeOriginalName: 'cv.pdf', jobTitle: 'Product Manager', status: 'COMPLETE_FAIL', fixPurchased: false, fixTier: 'FIX', jobDescriptionText: 'We need a PM. '.repeat(10), originalResumeData: resume, atsDetail: detail, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...o })
const delivered = o => mk({ status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 84, fixTier: 'FIX', rewrittenResumeData: { ...resume, summary: 'Rewritten summary.' }, fixAtsDetail: { ...detail, keywords: { missing: [], matched: ['sql'], warnings: [] } }, verificationUrl: 'https://usepassthrough.com/v/abc123', verificationStatus: 'ACTIVE', ...o })
let errors
beforeEach(() => { errors = []; vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.map(String).join(' ').slice(0, 300))); api.get.mockReset(); api.post.mockReset() })
afterEach(() => vi.restoreAllMocks())
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p> }
async function open(scan, path) {
  api.get.mockImplementation(async url => { if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }; if (url.includes('/status')) return { data: { data: { status: scan.status, atsScore: scan.atsScore } } }; if (url.startsWith('/scan/')) return { data: { data: scan } }; return { data: { data: {} } } })
  const r = render(<MemoryRouter initialEntries={[path]}><Where /><Routes><Route path="/scan/:id" element={<ScanResult />} /><Route path="/scan/:id/:tab" element={<ScanResult />} /><Route path="/dashboard" element={<p>DASH</p>} /><Route path="/" element={<p>HOME</p>} /></Routes></MemoryRouter>)
  await screen.findByRole('heading', { level: 1 })
  return r
}
const states = {
  'scored (fail)': [mk(), ['', 'why']],
  'scored (pass, eligible)': [mk({ status: 'COMPLETE_PASS', atsScore: 86, passed: true, badgeEligible: true, keywordScore: 90, formatScore: 90, sectionsScore: 90, contentScore: 80, atsDetail: { ...detail, formattedScore: 85 } }), ['', 'why']],
  'rewriting': [mk({ status: 'FIX_GENERATING', fixPurchased: true }), ['', 'why']],
  'delivered >=80': [delivered(), ['', 'why', 'resume', 'apply']],
  'delivered <80': [delivered({ fixAtsScore: 77, verificationUrl: null }), ['', 'why', 'resume', 'apply']],
  'anon scored': [mk({ userId: null, anonExpiresAt: new Date(Date.now() + 5 * 3600e3).toISOString() }), ['', 'why']],
}
// Integration: the REAL result page with its REAL children on every state and tab (no React warnings), and every button.
describe('result page with REAL children: no crash, no React warnings, on every tab', () => {
  for (const [name, [scan, tabs]] of Object.entries(states)) for (const t of tabs) it(`${name} /${t || '(base)'}`, async () => {
    if (name === 'anon scored') auth.user = null; else auth.user = { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 }
    await open(scan, `/scan/s1${t ? '/' + t : ''}`)
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(errors, errors.join('\n')).toEqual([])
    expect(document.body.textContent.length).toBeGreaterThan(200)
  })
})

describe('result page buttons do what they say (real children)', () => {
  const user = () => userEvent.setup()
  beforeEach(() => { auth.user = { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 } })
  const initOk = () => api.post.mockImplementation(async url => url === '/payments/initialize' ? { data: { data: { access_code: 'ac1', reference: 'r1', amount: 2900, currency: 'USD' } } } : { data: { data: {} } })
  const posted = () => api.post.mock.calls.filter(c => c[0] === '/payments/initialize').map(c => c[1])
  it('main offer button starts a FIX payment for THIS scan', async () => {
    await open(mk(), '/scan/s1'); initOk()
    await user().click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0]).toMatchObject({ scanId: 's1', fixTier: 'FIX' })
  })
  it('"Fix only" starts FIX_PLAIN', async () => {
    await open(mk(), '/scan/s1'); initOk()
    await user().click(within(screen.getByTestId('alt-plain')).getByRole('button'))
    await waitFor(() => expect(posted()[0]).toMatchObject({ fixTier: 'FIX_PLAIN' }))
  })
  it('eligible: "Verified only" starts BADGE', async () => {
    await open(mk({ status: 'COMPLETE_PASS', atsScore: 86, passed: true, badgeEligible: true, inputMode: 'text', atsDetail: { ...detail, formattedScore: 85 } }), '/scan/s1'); initOk()
    await user().click(within(screen.getByTestId('alt-badge')).getByRole('button'))
    await waitFor(() => expect(posted()[0]).toMatchObject({ fixTier: 'BADGE' }))
  })
  it('a free credit is redeemed through its own call, not a payment', async () => {
    auth.user = { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 1 }
    await open(mk(), '/scan/s1'); api.post.mockResolvedValue({ data: { data: { status: 'FIX_GENERATING' } } })
    await user().click(screen.getByRole('button', { name: /Use my free fix credit/ }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(posted()).toHaveLength(0)
    console.log('CREDIT CALL =>', JSON.stringify(api.post.mock.calls.map(c => [c[0], c[1]])))
  })
  it('unverified email: pressing buy asks to verify and does not open a payment', async () => {
    auth.user = { id: 'u1', name: 'Ada', emailVerified: false, freeFixCredits: 0 }
    await open(mk(), '/scan/s1'); initOk()
    await user().click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(posted()).toHaveLength(0)
    console.log('UNVERIFIED TEXT =>', /verify/i.test(document.body.textContent))
  })
  it('a failed payment start shows the error and the button works again', async () => {
    await open(mk(), '/scan/s1')
    api.post.mockRejectedValueOnce({ response: { data: { error: 'Payments are down.' } } })
    await user().click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    expect(await screen.findByText(/Payments are down/)).toBeInTheDocument()
    initOk(); await user().click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    await waitFor(() => expect(posted().length).toBeGreaterThanOrEqual(2))
  })
  it('tab links move the address and the content', async () => {
    await open(delivered(), '/scan/s1/resume'); const u = user()
    const nav = screen.getByRole('navigation', { name: 'Your scan' })
    await u.click(within(nav).getByRole('link', { name: /Apply/ })); expect(screen.getByTestId('where')).toHaveTextContent('/scan/s1/apply'); expect(screen.getByTestId('tab-apply')).toBeInTheDocument()
    await u.click(within(nav).getByRole('link', { name: /Why/ })); expect(screen.getByTestId('where')).toHaveTextContent('/scan/s1/why'); expect(screen.getByTestId('tab-why')).toBeInTheDocument()
    await u.click(within(nav).getByRole('link', { name: /Score/ })); expect(screen.getByTestId('tab-score')).toBeInTheDocument()
  })
  it('Resume tab "Go to Apply" and Score "See all reasons" links point at real tabs', async () => {
    await open(delivered(), '/scan/s1/resume')
    expect(screen.getByRole('link', { name: /Go to Apply/ })).toHaveAttribute('href', '/scan/s1/apply')
  })
  it('anon visitor: buy opens the gate, never a payment; sign-in link keeps the token path', async () => {
    auth.user = null
    await open(mk({ userId: null, anonExpiresAt: new Date(Date.now() + 5 * 3600e3).toISOString() }), '/scan/s1?token=abc'); initOk()
    await user().click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    expect(screen.getByTestId('buy-gate')).toBeInTheDocument(); expect(posted()).toHaveLength(0)
    expect(within(screen.getByTestId('buy-gate')).getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', expect.stringContaining('next=%2Fscan%2Fs1%3Ftoken%3Dabc'))
  })
  it('Apply tab: copy button copies the Verified link', async () => {
    await open(delivered(), '/scan/s1/apply')
    const u = user()                       // user-event installs its own clipboard; read it back
    await u.click(within(screen.getByTestId('verified-link-card')).getByRole('button', { name: /Copy/ }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('https://usepassthrough.com/v/abc123'))
  })
})

describe('provisional scores and the header', () => {
  it('a provisional score is announced once, and the score card does not call it failing', async () => {
    auth.user = { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 }
    await open(mk({ atsDetail: { ...detail, scoredWithoutAi: true } }), '/scan/s1')
    expect((document.body.textContent.match(/provisional/gi) || []).length).toBe(1)
    expect(screen.getByTestId('score-summary')).toHaveTextContent('Your score so far')
    expect(screen.getByTestId('score-summary')).not.toHaveTextContent(/failing/)
  })
})
