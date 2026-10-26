// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import api from '../src/lib/api'
import ScanResult from '../src/pages/ScanResult'
const auth = { user: { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn(async () => ({ emailVerified: true })), authLoading: false }
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: 'https://api.example/api' } }, getErrorMessage: (e, f) => e?.response?.data?.error || f }))
vi.mock('@paystack/inline-js', () => ({ default: class { newTransaction() {} } }))
vi.mock('../src/hooks/usePricing', async orig => ({ ...(await orig()), usePricing: () => ({ pricing: { currency: 'USD', coverLetterLimits: { BADGE: 2, FIX_PLAIN: 3, FIX: 5 } }, byTier: t => ({ FIX: { amount: 2900, originalAmount: 4900 }, FIX_PLAIN: { amount: 1900, originalAmount: 3900 }, BADGE: { amount: 900, originalAmount: 900 } }[t]), pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }) }))
vi.mock('../src/lib/poller', async orig => ({ ...(await orig()), createPoller: fn => ({ start: (o = {}) => { if (o.immediate !== false) fn() }, stop: () => {} }) }))

const resume = { name: 'Ada Lovelace', email: 'ada@x.io', phone: '555', location: 'Nairobi', summary: 'Product leader.', experience: [{ company: 'Acme', title: 'PM', dates: '2020-Present', bullets: ['Led payments', 'Grew revenue 20%'] }], education: [{ institution: 'MIT', degree: 'BS', dates: '2012' }], skills: ['SQL', 'Roadmapping'], projects: [], certifications: ['PMP'], languages: ['English'] }
const rewritten = { ...resume, summary: 'Rewritten summary with kubernetes.', skills: ['SQL', 'Kubernetes', 'Roadmapping'] }
const W = { keywords: 0.35, format: 0.25, sections: 0.2, content: 0.2 }
const det = (m = ['kubernetes', 'terraform']) => ({ weights: W, keywords: { missing: m, matched: ['sql'], warnings: [] }, format: { issues: ['Skills sit in a table'] }, sections: { missing: ['Summary'] }, content: { unquantified: { count: 3, total: 5, examples: ['Led payments'] }, actionVerbRate: 0.5 } })
const T = new Date().toISOString()
const base = o => ({ fixRetryCount: 0, id: 's1', userId: 'u1', atsScore: 62, passed: false, badgeEligible: false, keywordScore: 30, formatScore: 60, sectionsScore: 70, contentScore: 55, inputMode: 'file', resumeOriginalName: 'cv.pdf', jobTitle: 'Product Manager', status: 'COMPLETE_FAIL', fixPurchased: false, fixTier: 'FIX', jobDescriptionText: 'We need a PM with kubernetes. '.repeat(8), originalResumeData: resume, atsDetail: det(), createdAt: T, updatedAt: T, ...o })
const del = o => base({ status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'FIX', fixAtsScore: 86, fixRetryCount: 0, rewrittenResumeData: rewritten, fixAtsDetail: det([]), hasPdf: true, verificationUrl: 'https://usepassthrough.com/v/abc', verificationCode: 'abc', verificationStatus: 'ACTIVE', verificationViews: 3, verificationDownloads: 1, coverLetterText: 'Dear hiring manager, I am excited to apply for this role.', coverLetterLimit: 5, coverLetterCount: 1, quantificationPrompts: [{ id: 'q1', bullet: 'Led payments', question: 'How many people?' }], ...o })
const eligible = { status: 'COMPLETE_PASS', atsScore: 84, passed: true, badgeEligible: true }
const STATES = {
  'scored-fail': [base(), ['', 'why']],
  'scored-pass-text': [base({ ...eligible, inputMode: 'text' }), ['']],
  'scored-pass-file-unchecked': [base({ ...eligible }), ['']],
  'scored-pass-file-checked': [base({ ...eligible, atsDetail: { ...det([]), formattedScore: 85 } }), ['']],
  'provisional': [base({ atsDetail: { ...det(), scoredWithoutAi: true } }), ['']],
  'scanning': [base({ status: 'SCANNING', atsScore: null, scanStage: 'parsing' }), ['']],
  'scan-error': [base({ status: 'ERROR', atsScore: null, failure: 'scan' }), ['']],
  'rewriting-FIX': [base({ status: 'FIX_GENERATING', fixPurchased: true }), ['resume']],
  'rewriting-BADGE': [base({ status: 'FIX_GENERATING', fixPurchased: true, fixTier: 'BADGE', ...eligible }), ['resume']],
  'fix-error-paid': [base({ status: 'ERROR', fixPurchased: true, failure: 'fix' }), ['', 'resume']],
  'delivered-FIX-86': [del(), ['score', 'why', 'resume', 'apply']],
  'delivered-FIX-72': [del({ fixAtsScore: 72, verificationUrl: null, verificationCode: null, verificationStatus: null }), ['resume', 'apply']],
  'delivered-FIX-72-retried': [del({ fixAtsScore: 72, fixRetryCount: 2, retryNoGain: true, verificationUrl: null }), ['resume']],
  'delivered-BADGE-84': [del({ ...eligible, status: 'FIX_DELIVERED', fixTier: 'BADGE', fixAtsScore: 84, rewrittenResumeData: null }), ['score', 'resume', 'apply']],
  'delivered-BADGE-74-credit': [del({ fixTier: 'BADGE', fixAtsScore: 74, rewrittenResumeData: null, verificationUrl: null }), ['resume', 'apply']],
  'delivered-PLAIN': [del({ fixTier: 'FIX_PLAIN', fixAtsScore: 88, verificationUrl: null, verificationCode: null, verificationStatus: null }), ['resume', 'apply']],
  'delivered-revoked': [del({ verificationStatus: 'REVOKED', verificationRevokedReason: 'ADMIN' }), ['apply']],
  'rewrite-failed': [del({ rewriteFailed: true, rewrittenResumeData: null, fixAtsScore: null }), ['resume']],
  'revoked-owner': [del({ verificationStatus: 'REVOKED', verificationRevokedReason: 'OWNER' }), ['resume', 'apply']],
  'anon-scored': [base({ userId: null, anonExpiresAt: new Date(Date.now() + 5 * 3600e3).toISOString() }), ['']],
}
const only = null
let errors
beforeEach(() => { errors = []; vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.map(String).join(' ').slice(0, 160))); window.open = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const norm = s => s.replace(/\s+/g, ' ').slice(0, 6000)
async function boot(name, scan, tab) {
  if (name === 'anon-scored') auth.user = null; else auth.user = { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: name.includes('credit') ? 2 : 0 }
  api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); api.put.mockReset(); api.delete.mockReset()
  api.get.mockImplementation(async url => { if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }; if (url.includes('/status')) return { data: { data: { status: scan.status, atsScore: scan.atsScore } } }; if (url.startsWith('/scan/')) return { data: { data: scan } }; return { data: { data: {} } } })
  for (const m of ['post', 'patch', 'put', 'delete']) api[m].mockImplementation(async () => ({ data: { data: {}, success: true } }))
  const router = createMemoryRouter([{ path: '/scan/:id/:tab', element: <ScanResult /> }, { path: '/scan/:id', element: <ScanResult /> }, { path: '*', element: <p>ELSEWHERE</p> }], { initialEntries: [`/scan/s1${tab ? '/' + tab : ''}${name === 'anon-scored' ? '?token=tok' : ''}`] })
  render(<RouterProvider router={router} />)
  await act(async () => { await new Promise(r => setTimeout(r, 40)) })
  return router
}
function controls() {
  const out = []
  document.querySelectorAll('main button, main a[href], main [role=button], main summary, main input[type=checkbox], main input[type=radio]').forEach((el, i) => {
    if (el.closest('[aria-hidden=true]') || el.disabled) return
    const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('href') || el.type || '').replace(/\s+/g, ' ').trim().slice(0, 48)
    out.push({ i, label, tag: el.tagName.toLowerCase() + (el.getAttribute('href') ? '[href=' + el.getAttribute('href').slice(0, 40) + ']' : '') })
  })
  return out
}
// Click-through of the REAL result page: every button and link, in every state a scan can be in, on every tab it has. Nothing may
// throw, log a React error, or do nothing at all.
describe('click everything', () => {
  for (const [name, [scan, tabs]] of Object.entries(STATES)) for (const tab of tabs) {
    if (only && !only.includes(name)) continue
    it(`${name} /${tab}`, async () => {
      const report = []
      await boot(name, scan, tab)
      const list = controls()
      cleanup()
      for (const c of list) {
        errors = []
        const router = await boot(name, scan, tab)
        const el = [...document.querySelectorAll('main button, main a[href], main [role=button], main summary, main input[type=checkbox], main input[type=radio]')].filter(e => !e.closest('[aria-hidden=true]') && !e.disabled)[list.indexOf(c)]
        if (!el) { cleanup(); continue }
        const before = norm(document.body.textContent), url0 = router.state.location.pathname + router.state.location.search
        let threw = null
        const calls0 = api.post.mock.calls.length + api.patch.mock.calls.length + api.put.mock.calls.length + api.delete.mock.calls.length
        try { await userEvent.setup().click(el); await act(async () => { await new Promise(r => setTimeout(r, 30)) }) } catch (e) { threw = e.message.slice(0, 100) }
        const calls = api.post.mock.calls.length + api.patch.mock.calls.length + api.put.mock.calls.length + api.delete.mock.calls.length - calls0
        const url1 = router.state.location.pathname + router.state.location.search
        const changed = norm(document.body.textContent) !== before
        const res = { state: name, tab, label: c.label, tag: c.tag, api: calls, nav: url1 !== url0 ? url1 : '', dom: changed, errs: errors.slice(0, 2), threw }
        report.push(res)
        cleanup()
      }
      const broke = report.filter(r => r.threw || r.errs.length)
      expect(broke, JSON.stringify(broke)).toEqual([])
      // A control that does nothing at all (no request, no navigation, no visible change) is a dead button, except these on purpose:
      // a link to the page you are already on, a disclosure or a checkbox/radio (they change attributes, not text), an external link.
      const allowed = tag => ['a[href=http', 'a[href=/scan/s1', 'summary', 'input'].some(p => tag.startsWith(p))
      const dead = report.filter(r => !r.api && !r.nav && !r.dom && !allowed(r.tag))
      expect(dead, JSON.stringify(dead)).toEqual([])
    }, 120000)
  }
})
