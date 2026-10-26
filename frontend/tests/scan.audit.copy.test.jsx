// @vitest-environment jsdom
// Copy and state of the result page by what was bought: nothing may promise a credential, a rewrite or a button that is not there.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, createMemoryRouter, RouterProvider, Route, Routes } from 'react-router-dom'
import api from '../src/lib/api'
import ScanResult from '../src/pages/ScanResult'
import CsvInput, { parseCsv } from '../src/components/scan/CsvInput'
import ResumeFieldsForm from '../src/components/scan/ResumeFieldsForm'
import SavedProfileEditor from '../src/components/account/SavedProfileEditor'
import SectionBoundary from '../src/components/ui/SectionBoundary'
import ScanStrip from '../src/components/scan/ScanStrip'
import { StageTracker } from '../src/components/dashboard/ScanRow'
import { passage, scanMessage } from '../src/lib/scanNext'
import { recommendPlan, passageSteps, rewrites, mayEarnCredential, credentialEarned } from '../src/lib/scanTiers'

const auth = { user: { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn(), authLoading: false }
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: 'https://api.example/api' } }, getErrorMessage: (e, f) => f }))
vi.mock('@paystack/inline-js', () => ({ default: class { newTransaction() {} } }))
vi.mock('../src/hooks/usePricing', async orig => ({ ...(await orig()), usePricing: () => ({ pricing: { currency: 'USD', coverLetterLimits: { BADGE: 2, FIX_PLAIN: 3, FIX: 5 } }, byTier: t => ({ FIX: { amount: 2900, originalAmount: 2900 }, FIX_PLAIN: { amount: 1900, originalAmount: 1900 }, BADGE: { amount: 900, originalAmount: 900 } }[t]), pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }) }))
vi.mock('../src/lib/poller', async orig => ({ ...(await orig()), createPoller: fn => ({ start: (o = {}) => { if (o.immediate !== false) fn() }, stop: () => {} }) }))

const resume = { name: 'Ada Lovelace', email: 'ada@x.io', phone: '555', summary: 'Product leader.', experience: [{ company: 'Acme', title: 'PM', startDate: '2020', endDate: 'Present', bullets: ['Led payments'] }], education: [{ school: 'MIT', degree: 'BS', year: '2012' }], skills: ['SQL'], projects: [], certifications: [] }
const W = { keywords: 0.35, format: 0.25, sections: 0.2, content: 0.2 }
const detail = { weights: W, keywords: { missing: [], matched: ['sql'], warnings: [] }, format: { issues: [] }, sections: { missing: [] }, content: { unquantified: { count: 0, total: 5, examples: [] }, actionVerbRate: 0.8 } }
const base = o => ({ id: 's1', userId: 'u1', atsScore: 84, passed: true, badgeEligible: true, inputMode: 'text', jobTitle: 'PM', status: 'COMPLETE_PASS', fixPurchased: false, fixTier: 'FIX', jobDescriptionText: 'We need a PM. '.repeat(10), originalResumeData: resume, rewrittenResumeData: null, atsDetail: { ...detail, formattedScore: 85 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...o })
const badgeDelivered = o => base({ status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'BADGE', fixAtsScore: 84, fixAtsDetail: detail, verificationUrl: 'https://usepassthrough.com/v/abc', verificationStatus: 'ACTIVE', ...o })
let errors
beforeEach(() => { errors = []; vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.map(String).join(' ').slice(0, 300))); api.get.mockReset(); api.post.mockReset(); auth.user = { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 } })
afterEach(() => vi.restoreAllMocks())
const load = scan => api.get.mockImplementation(async url => { if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }; if (url.includes('/status')) return { data: { data: { status: scan.status, atsScore: scan.atsScore } } }; return { data: { data: scan } } })
async function open(scan, path) {
  load(scan)
  const router = createMemoryRouter([{ path: '/scan/:id/:tab', element: <ScanResult /> }, { path: '/scan/:id', element: <ScanResult /> }], { initialEntries: [path] })
  const r = render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { level: 1 })
  await act(async () => { await new Promise(r => setTimeout(r, 25)) })
  return r
}
const crashed = () => errors.some(e => /Too many re-renders/.test(e))


const del = o => base({ status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'FIX', atsScore: 62, passed: false, badgeEligible: false, fixAtsScore: 86, fixRetryCount: 0, rewrittenResumeData: { ...resume, summary: 'New.' }, fixAtsDetail: detail, verificationUrl: 'https://usepassthrough.com/v/abc', verificationStatus: 'ACTIVE', ...o })
const text = () => document.body.textContent.replace(/\s+/g, ' ')

describe('the score card after a purchase is the ORIGINAL scan, and says so', () => {
  it('a delivered fix: "Your original scan", never "failing", and where it ended up', async () => {
    await open(del(), '/scan/s1/score')
    const card = screen.getByTestId('score-summary')
    expect(card).toHaveTextContent('Your original scan')
    expect(card).toHaveTextContent('Where you started. After the fix: 86.')
    expect(card).not.toHaveTextContent(/failing/)
  })
  it('a Verified-only delivery: nothing was fixed, so it says the file we delivered scored N', async () => {
    await open(del({ fixTier: 'BADGE', atsScore: 84, fixAtsScore: 84, rewrittenResumeData: null }), '/scan/s1/score')
    expect(screen.getByTestId('score-summary')).toHaveTextContent('The file we delivered scored 84.')
  })
  it('while it is being prepared: points at Your resume', async () => {
    await open(base({ status: 'FIX_GENERATING', fixPurchased: true, atsScore: 62, passed: false, badgeEligible: false }), '/scan/s1/score')
    expect(screen.getByTestId('score-summary')).toHaveTextContent('Where you started. Your result is on Your resume.')
  })
  it('before any purchase it is still the honest verdict', async () => {
    await open(base({ status: 'COMPLETE_FAIL', atsScore: 62, passed: false, badgeEligible: false }), '/scan/s1/score')
    expect(screen.getByTestId('score-summary')).toHaveTextContent('Your resume is failing ATS filters')
  })
})

describe('what the cards promise matches what was delivered', () => {
  const cases = [
    ['full fix, credential earned', del(), /Your rewrite and files and Verified link are in the next tabs\./, "You've got the fix", /Your Verified link and cover letter are one tab over/],
    ['full fix, under the bar (no link)', del({ fixAtsScore: 72, verificationUrl: null, verificationStatus: null }), /Your rewrite and files are in the next tabs\./, "You've got the fix", /Your cover letter is one tab over\./],
    ['plain fix (no credential exists)', del({ fixTier: 'FIX_PLAIN', fixAtsScore: 88, verificationUrl: null, verificationStatus: null }), /Your rewrite and files are in the next tabs\./, "You've got the fix", /Your cover letter is one tab over\./],
    ['credential-only, earned', del({ fixTier: 'BADGE', atsScore: 84, fixAtsScore: 84, rewrittenResumeData: null }), /Your files and Verified link are in the next tabs\./, "You're verified", /Your Verified link and cover letter are one tab over/],
    ['credential-only, not earned', del({ fixTier: 'BADGE', atsScore: 84, fixAtsScore: 74, rewrittenResumeData: null, verificationUrl: null, verificationStatus: null }), /Your files are in the next tabs\./, 'Your files are ready', /Your cover letter is one tab over\./],
  ]
  for (const [name, scan, scoreCopy, heading, nextCopy] of cases)
    it(name, async () => {
      const r = await open(scan, '/scan/s1/score')
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
      expect(text()).toMatch(scoreCopy)
      expect(text()).not.toMatch(/Your rewrite, files and Verified link/)
      r.unmount()
      await open(scan, '/scan/s1/resume')
      expect(text()).toMatch(nextCopy)
      if (!/Verified link and cover/.test(String(nextCopy))) expect(text()).not.toMatch(/Verified link and cover letter are one tab over/)
    })

  it('after delivery the Score tab points to Your resume once, not twice', async () => {
    await open(del(), '/scan/s1/score')
    expect(screen.queryByRole('link', { name: 'Open it' })).toBeNull()
    expect(screen.getAllByRole('link', { name: /Go to Your resume/ })).toHaveLength(1)
  })
  it('a plain fix is not told it is "past the 80 line"', async () => {
    await open(del({ fixTier: 'FIX_PLAIN', fixAtsScore: 88, verificationUrl: null, verificationStatus: null }), '/scan/s1/resume')
    const line = screen.getByTestId('delivered-summary').querySelector('p')
    expect(line).toHaveTextContent(/^88 out of 100\. Up 26 from 62\.$/)
    expect(line).not.toHaveTextContent(/80/)
  })
  it('the editor does not promise a link that does not exist', async () => {
    await open(del({ fixAtsScore: 72, verificationUrl: null, verificationStatus: null }), '/scan/s1/resume')
    expect(screen.getByTestId('delivered-editor')).not.toHaveTextContent(/verification link stays the same/)
    expect(screen.getByTestId('delivered-editor')).toHaveTextContent(/Saving rebuilds both files\./)
  })
  it('the upgrade card does not promise a link either', async () => {
    auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 1 }
    await open(del({ fixTier: 'BADGE', atsScore: 84, fixAtsScore: 74, rewrittenResumeData: null, verificationUrl: null, verificationStatus: null }), '/scan/s1/resume')
    expect(screen.getByTestId('badge-upgrade')).toHaveTextContent('If the rewrite clears 80, your Verified link is issued.')
    expect(screen.getByTestId('badge-upgrade')).not.toHaveTextContent(/stays the same/)
  })
})

describe('an unpublished verification page is explained on BOTH tabs that talk about the link', () => {
  const owner = () => del({ verificationStatus: 'REVOKED', verificationRevokedReason: 'OWNER' })
  it('owner unpublished: Apply says so and can republish, and does not pretend the link is live', async () => {
    await open(owner(), '/scan/s1/apply')
    const note = screen.getByTestId('unpublished-note')
    expect(note).toHaveTextContent('Your verification page is currently unpublished.')
    expect(screen.queryByTestId('verified-link-card')).toBeNull()
    api.post.mockResolvedValue({ data: { data: { verificationStatus: 'ACTIVE' } } }); api.patch.mockResolvedValue({ data: { data: { verificationStatus: 'ACTIVE' } } })
    await userEvent.setup().click(within(note).getByRole('button', { name: 'Republish' }))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(api.patch).toHaveBeenCalledWith('/scan/s1/verify-visibility', { published: true })
  })
  it('taken down by Passthrough: Apply says so, with no Republish button', async () => {
    await open(del({ verificationStatus: 'REVOKED', verificationRevokedReason: 'ADMIN' }), '/scan/s1/apply')
    const note = screen.getByTestId('unpublished-note')
    expect(note).toHaveTextContent(/taken down by Passthrough/)
    expect(within(note).queryByRole('button')).toBeNull()
  })
  it('the Resume tab uses the same note', async () => {
    await open(owner(), '/scan/s1/resume')
    expect(screen.getByTestId('unpublished-note')).toBeInTheDocument()
  })
  it('a live link shows no such note', async () => {
    await open(del(), '/scan/s1/apply')
    expect(screen.queryByTestId('unpublished-note')).toBeNull()
  })
})

describe('a result that cannot be opened explains itself', () => {
  async function missing(signedIn) {
    auth.user = signedIn ? { id: 'u1', emailVerified: true } : null
    api.get.mockImplementation(async url => { if (url.startsWith('/payments/pending')) return { data: { data: { pending: null } } }; const e = new Error('nf'); e.response = { status: 404, data: { error: 'Scan not found' } }; throw e })
    const router = createMemoryRouter([{ path: '/scan/:id', element: <ScanResult /> }], { initialEntries: ['/scan/gone?token=abc'] })
    render(<RouterProvider router={router} />)
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
  }
  it('signed out: says results expire after 24 hours and offers sign-in that returns here', async () => {
    await missing(false)
    const box = screen.getByTestId('scan-unavailable')
    expect(within(box).getByRole('heading', { level: 1 })).toHaveTextContent("This result isn't available")
    expect(box).toHaveTextContent(/kept for 24 hours/)
    expect(within(box).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/login?next=${encodeURIComponent('/scan/gone?token=abc')}`)
    expect(within(box).getByRole('link', { name: 'Start a new scan' })).toHaveAttribute('href', '/scan')
  })
  it('signed in: points to the scans list instead of sign-in', async () => {
    await missing(true)
    const box = screen.getByTestId('scan-unavailable')
    expect(within(box).queryByRole('link', { name: 'Sign in' })).toBeNull()
    expect(within(box).getByRole('link', { name: 'Go to my scans' })).toHaveAttribute('href', '/dashboard')
  })
})

describe('the page outline never skips a level', () => {
  for (const [state, tab] of [['delivered', 'score'], ['delivered', 'why'], ['delivered', 'resume'], ['delivered', 'apply'], ['scored', 'score']])
    it(`${state} /${tab}`, async () => {
      await open(state === 'delivered' ? del() : base({ status: 'COMPLETE_FAIL', atsScore: 62, passed: false, badgeEligible: false }), `/scan/s1/${tab}`)
      const levels = [...document.querySelectorAll('main h1, main h2, main h3, main h4')].map(h => +h.tagName[1])
      for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], levels.join(',')).toBeLessThanOrEqual(1)
    })
})

describe('the dashboard row says what a credential-only purchase did', () => {
  const row = o => ({ id: 'r1', status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'BADGE', atsScore: 84, fixAtsScore: 84, verificationCode: 'abc', verificationStatus: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...o })
  it('earned: "Verified", the score, no arrow from a score to itself', () => {
    const m = scanMessage(row())
    expect(m.label).toMatch(/Verified/); expect(m.text).toBe('Score 84. Employers can open your link.')
  })
  it('not earned: says the credential was not issued and that a credit is on the account, not "No retries left"', () => {
    const m = scanMessage(row({ fixAtsScore: 74, verificationCode: null, verificationStatus: null }))
    expect(m.label).toBe('Credential not issued')
    expect(m.text).toBe('The formatted file scored 74, under 80. A free fix credit is on your account.')
    expect(m.text).not.toMatch(/retries|Fix delivered/)
  })
  it('paid, just started: "Starting your verification"', () => {
    expect(scanMessage(row({ status: 'FIX_PURCHASED', fixAtsScore: null, verificationCode: null })).text).toBe('Starting your verification.')
    expect(scanMessage(row({ status: 'FIX_PURCHASED', fixTier: 'FIX', fixAtsScore: null, verificationCode: null })).text).toBe('Starting your fix.')
  })
  it('a paid fix that errored still counts the scan as done', () => {
    expect(passage(row({ status: 'ERROR', fixTier: 'FIX', fixAtsScore: null, verificationCode: null }))[0].state).toBe('done')
    expect(passage({ id: 'x', status: 'ERROR', fixPurchased: false, atsScore: null })[0].state).toBe('todo')
  })
})
