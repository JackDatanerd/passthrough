// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import api from '../src/lib/api'
import ScanResult from '../src/pages/ScanResult'
const auth = { user: { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 1 }, refreshUser: vi.fn(), authLoading: false }
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: 'https://api.example/api' } }, getErrorMessage: (e, f) => f }))
vi.mock('@paystack/inline-js', () => ({ default: class { resumeTransaction() {} } }))
vi.mock('../src/hooks/usePricing', async orig => ({ ...(await orig()), usePricing: () => ({ pricing: { currency: 'USD' }, byTier: t => ({ FIX: { amount: 2900, originalAmount: 2900 }, FIX_PLAIN: { amount: 1900, originalAmount: 1900 }, BADGE: { amount: 900, originalAmount: 900 } }[t]), pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }) }))
vi.mock('../src/lib/poller', async orig => ({ ...(await orig()), createPoller: fn => ({ start: (o = {}) => { if (o.immediate !== false) fn() }, stop: () => {} }) }))
const T = new Date().toISOString()
const FULL = { id: 's1', userId: 'u1', atsScore: 84, passed: true, badgeEligible: true, keywordScore: 80, formatScore: 90, sectionsScore: 90, contentScore: 80, inputMode: 'file', resumeOriginalName: 'cv.pdf', jobTitle: 'PM', status: 'COMPLETE_PASS', fixPurchased: false, fixTier: 'FIX', fixRetryCount: 0, jobDescriptionText: 'We need a PM. '.repeat(10),
  originalResumeData: { name: 'Ada', email: 'a@x.io', summary: 'S', experience: [{ company: 'Acme', title: 'PM', dates: '2020', bullets: ['Led'] }], education: [{ institution: 'MIT' }], skills: ['SQL'], projects: [], certifications: [] },
  atsDetail: { weights: { keywords: .35, format: .25, sections: .2, content: .2 }, keywords: { missing: ['a'], matched: ['b'] }, format: { issues: [] }, sections: { missing: [] }, content: { unquantified: { count: 1, total: 4, examples: ['Led'] }, actionVerbRate: .6 }, formattedScore: 85 }, createdAt: T, updatedAt: T }
const DEL = { ...FULL, status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 86, rewrittenResumeData: FULL.originalResumeData, fixAtsDetail: FULL.atsDetail, verificationUrl: 'https://v/x', verificationCode: 'x', verificationStatus: 'ACTIVE', hasPdf: true }
// Old rows and partial rows: every one of these can exist (older scans, failed enrichment, URL-fetched postings, a first-time user).
const HOLES = ['jobTitle', 'resumeOriginalName', 'jobDescriptionText', 'originalResumeData', 'rewrittenResumeData', 'atsDetail', 'fixAtsDetail', 'keywordScore', 'formatScore', 'sectionsScore', 'contentScore', 'fixAtsScore', 'verificationUrl', 'verificationStatus', 'createdAt', 'inputMode', 'fixTier', 'fixRetryCount', 'quantificationPrompts', 'coverLetterText', 'passed', 'badgeEligible']
let errors
beforeEach(() => { errors = []; vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(String(a[0]).slice(0, 110) + ' ' + String(a[1] || '').slice(0, 60))) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const results = []
async function run(label, scan, tab) {
  api.get.mockReset(); api.post.mockReset()
  api.get.mockImplementation(async url => { if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }; if (url.includes('/status')) return { data: { data: { status: scan.status, atsScore: scan.atsScore } } }; if (url.startsWith('/scan/')) return { data: { data: scan } }; return { data: { data: {} } } })
  errors = []
  let threw = null
  try { render(<RouterProvider router={createMemoryRouter([{ path: '/scan/:id/:tab', element: <ScanResult /> }, { path: '/scan/:id', element: <ScanResult /> }], { initialEntries: [`/scan/s1/${tab}`] })} />); await act(async () => { await new Promise(r => setTimeout(r, 25)) }) } catch (e) { threw = e.message.slice(0, 90) }
  const crashedTxt = /Something went wrong/.test(document.body.textContent)
  if (threw || errors.length || crashedTxt) results.push(`${label} /${tab} :: ${threw || ''} ${errors[0] || ''} ${crashedTxt ? '[ERROR SCREEN]' : ''}`)
  cleanup()
}
// Older rows and partial rows exist (failed enrichment, URL-fetched postings, rows from before a column): no missing field may break a page.
describe('scans with holes', () => {
  it('each missing field, on every state and tab', async () => {
    for (const hole of HOLES) for (const [sname, base, tabs] of [['scored', FULL, ['score', 'why']], ['delivered', DEL, ['score', 'why', 'resume', 'apply']], ['badge-delivered', { ...DEL, fixTier: 'BADGE', rewrittenResumeData: null }, ['resume', 'apply']], ['rewriting', { ...FULL, status: 'FIX_GENERATING', fixPurchased: true }, ['resume']]]) {
      const scan = { ...base }; delete scan[hole]
      for (const tab of tabs) await run(`hole=${hole} ${sname}`, scan, tab)
      const nul = { ...base, [hole]: null }
      for (const tab of tabs) await run(`null=${hole} ${sname}`, nul, tab)
    }
    expect(results, results.join('\n')).toEqual([])
  }, 280000)
})
