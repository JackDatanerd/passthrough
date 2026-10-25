// @vitest-environment jsdom
// Regression: the Verified-only journey end to end, and the editor crash that broke "Edit resume" (a list item with a comma inside).
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

describe('CsvInput: a list item with a comma in it never takes the page down', () => {
  for (const [name, value] of [['a skill with a comma in brackets', ['SQL', 'Cloud (AWS, Azure)']], ['a certification with a bare comma', ['PMP, Project Management Institute']], ['numbers and nulls from old data', ['SQL', null, 7]]])
    it(name, () => { render(<CsvInput label="Skills" value={value} onChange={() => {}} />); expect(crashed()).toBe(false); expect(screen.getByLabelText('Skills')).toBeInTheDocument() })

  it('brackets are respected when splitting, so editing never cuts "Cloud (AWS, Azure)" in two', () => {
    expect(parseCsv('Cloud (AWS, Azure), SQL')).toEqual(['Cloud (AWS, Azure)', 'SQL'])
    expect(parseCsv('a, b,, c ,')).toEqual(['a', 'b', 'c'])
    expect(parseCsv('')).toEqual([])
  })
  it('typing keeps what was typed (a trailing comma is not eaten) and reports the parsed list', async () => {
    const got = []
    function Host() { const [v, setV] = useState(['SQL']); return <CsvInput label="Skills" value={v} onChange={a => { got.push(a); setV(a) }} /> }
    render(<Host />)
    const box = screen.getByLabelText('Skills')
    await userEvent.setup().type(box, ', Go, ')
    expect(box).toHaveValue('SQL, Go, ')
    expect(got.at(-1)).toEqual(['SQL', 'Go'])
    expect(crashed()).toBe(false)
  })
  it('a DIFFERENT list handed in from outside (another project in the same slot) replaces the text', () => {
    const { rerender } = render(<CsvInput label="Tech" value={['a', 'b']} onChange={() => {}} />)
    expect(screen.getByLabelText('Tech')).toHaveValue('a, b')
    rerender(<CsvInput label="Tech" value={['x', 'y, z']} onChange={() => {}} />)
    expect(screen.getByLabelText('Tech')).toHaveValue('x, y, z')
  })
})

describe('the editors open on real-world data (they used to replace the whole page with the error screen)', () => {
  const comma = { ...resume, skills: ['SQL', 'Cloud (AWS, Azure)'], certifications: ['PMP, Project Management Institute'], languages: ['English, native'] }
  it('Edit resume on a Verified-only delivery', async () => {
    await open(badgeDelivered({ originalResumeData: comma }), '/scan/s1/resume')
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Edit resume' }))
    expect(crashed()).toBe(false)
    expect(screen.getByDisplayValue(/Cloud \(AWS, Azure\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save & rebuild files/ })).toBeInTheDocument()
  })
  it('"Review & edit" on the Why tab of a scored scan', async () => {
    await open(base({ status: 'COMPLETE_FAIL', atsScore: 62, passed: false, badgeEligible: false, inputMode: 'file', resumeOriginalName: 'cv.pdf', originalResumeData: comma }), '/scan/s1/why')
    await userEvent.setup().click(await screen.findByRole('button', { name: /Review & edit/ }))
    expect(crashed()).toBe(false)
    expect(screen.getByDisplayValue(/Cloud \(AWS, Azure\)/)).toBeInTheDocument()
  })
  it('the Settings saved-profile editor', async () => {
    api.get.mockResolvedValue({ data: { data: { resumeData: comma, version: 'v1' } } })
    render(<MemoryRouter><SavedProfileEditor onSaved={() => {}} onClose={() => {}} /></MemoryRouter>)
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    expect(crashed()).toBe(false)
    expect(screen.getByDisplayValue(/Cloud \(AWS, Azure\)/)).toBeInTheDocument()
  })
  it('sections of the wrong shape open empty instead of throwing (bullets as a string, null entries, awards as a string)', () => {
    const odd = { name: 'A', experience: [null, { company: 'Acme', bullets: 'Led payments' }], awards: 'Employee of the year', publications: 'A paper', education: null, projects: 'none' }
    render(<ResumeFieldsForm draft={odd} setDraft={() => {}} />)
    expect(crashed()).toBe(false)
    expect(screen.getByDisplayValue('Led payments')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Employee of the year')).toBeInTheDocument()
  })
  it('a part of the page that fails costs only that part: the page, its navigation and the message stay', () => {
    function Boom() { throw new Error('boom') }
    render(<><nav>PAGE NAV</nav><SectionBoundary name="t" message="The resume editor could not load."><Boom /></SectionBoundary></>)
    expect(screen.getByText('PAGE NAV')).toBeInTheDocument()
    expect(screen.getByTestId('section-error')).toHaveTextContent('The resume editor could not load. Your resume is safe.')
  })
})

describe('the plan an offer leads with, by tier and score band', () => {
  it('lib: credential first only when the score clears the bar AND the file we would deliver does', () => {
    expect(recommendPlan({ eligible: true, badgeSafe: true }).primary).toBe('BADGE')
    expect(recommendPlan({ eligible: true, badgeSafe: false }).primary).toBe('FIX')
    expect(recommendPlan({ eligible: false, badgeSafe: false }).primary).toBe('FIX')
    expect(recommendPlan({ eligible: true, badgeSafe: true, provisional: true }).primary).toBe('FIX')
  })
  it('lib: what each tier does', () => {
    expect([rewrites('BADGE'), rewrites('FIX'), rewrites('FIX_PLAIN')]).toEqual([false, true, true])
    expect([mayEarnCredential('BADGE'), mayEarnCredential('FIX'), mayEarnCredential('FIX_PLAIN')]).toEqual([true, true, false])
    expect(passageSteps('BADGE')).toEqual(['scanned', 'verified']); expect(passageSteps('FIX_PLAIN')).toEqual(['scanned', 'rewritten']); expect(passageSteps('FIX')).toEqual(['scanned', 'rewritten', 'verified'])
    expect(credentialEarned({ fixAtsScore: 80 })).toBe(true); expect(credentialEarned({ fixAtsScore: 79 })).toBe(false); expect(credentialEarned({})).toBe(false)
  })
  for (const [score, passed, eligible, lead] of [[52, false, false, 'FIX'], [76, true, false, 'FIX'], [79, true, false, 'FIX'], [80, true, true, 'BADGE'], [84, true, true, 'BADGE'], [97, true, true, 'BADGE']])
    it(`a typed scan at ${score}: the page leads with ${lead}`, async () => {
      await open(base({ atsScore: score, passed, badgeEligible: eligible, status: passed ? 'COMPLETE_PASS' : 'COMPLETE_FAIL' }), '/scan/s1')
      expect(screen.getByTestId('offer-card')).toHaveAttribute('data-primary', lead)
    })
})

describe('a Verified-only purchase is never described as a rewrite', () => {
  it('while it is being prepared: heading, body, strip and progress card all say verifying', async () => {
    await open(base({ status: 'FIX_GENERATING', fixPurchased: true, fixTier: 'BADGE' }), '/scan/s1/resume')
    const focus = screen.getByTestId('rewriting-focus')
    expect(focus.querySelector('h2')).toHaveTextContent("We're verifying your resume")
    expect(focus).toHaveTextContent('nothing is rewritten')
    expect(focus).not.toHaveTextContent(/reworking|rewriting/i)
    const strip = screen.getByTestId('scan-strip')
    expect(strip).toHaveTextContent('Being verified now')
    expect(within(strip).queryByText('Rewritten')).toBeNull()
    expect(within(strip).getByText('Verified').closest('li')).toHaveAttribute('aria-current', 'step')
  })
  it('after it is delivered and earned: two steps, both done, no "after the fix", a banner that says Verified', async () => {
    await open(badgeDelivered(), '/scan/s1/score')
    const strip = screen.getByTestId('scan-strip')
    expect(within(strip).queryByText('Rewritten')).toBeNull()
    expect(within(strip).getByText('Scanned').closest('li')).toHaveClass('border-green-700')
    expect(within(strip).getAllByRole('listitem').map(li => li.textContent.trim())).toEqual(['Scanned', 'Verified'])
    expect(within(strip).getAllByRole('listitem').every(li => li.className.includes('border-green-700'))).toBe(true)
    expect(strip).toHaveTextContent('Credential earned')
    expect(strip).not.toHaveTextContent(/after the fix|before/)
    expect(document.body.textContent).toMatch(/Your Verified resume is ready/)
    expect(document.body.textContent).not.toMatch(/Your fixed resume scores/)
  })
  it('delivered but the file scored under the bar: says so plainly, Verified pill waits at 80', async () => {
    await open(badgeDelivered({ fixAtsScore: 77, verificationUrl: null }), '/scan/s1/score')
    expect(screen.getByTestId('scan-strip')).toHaveTextContent(/Under the 80 the credential needs/)
    expect(within(screen.getByTestId('scan-strip')).getAllByRole('listitem')[1]).toHaveTextContent('at 80')
    expect(document.body.textContent).toMatch(/Your files are ready/)
  })
  it('the Why tab calls the delivered resume "Verified", not "fixed"', async () => {
    await open(badgeDelivered(), '/scan/s1/why')
    expect(screen.getByText(/Your Verified resume is on/)).toBeInTheDocument()
  })
  it('a plain fix has no credential to earn, so it has no Verified step to wait on', async () => {
    await open(base({ status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'FIX_PLAIN', fixAtsScore: 88, atsScore: 62, passed: false, badgeEligible: false, rewrittenResumeData: { ...resume, summary: 'New.' }, fixAtsDetail: detail, verificationUrl: null }), '/scan/s1')
    const strip = screen.getByTestId('scan-strip')
    expect(within(strip).queryByText('Verified')).toBeNull()
    expect(strip).toHaveTextContent('88 out of 100, after the fix')
  })
  it('the full fix keeps all three steps', () => {
    render(<ScanStrip stage="delivered" scan={{ atsScore: 62, passed: false, fixTier: 'FIX', fixAtsScore: 86, verificationUrl: 'https://v/x' }} />)
    expect(screen.getAllByRole('listitem').map(li => li.textContent.replace(/\s+/g, ''))).toEqual(['Scanned', 'Rewritten', 'Verified'])
  })
})

describe('after success there is no pitch for the thing you already have', () => {
  it('a verified credential-only delivery does not offer "Upgrade this resume to the full Fix", even with credits', async () => {
    auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 3 }
    await open(badgeDelivered(), '/scan/s1/resume')
    expect(screen.queryByTestId('badge-upgrade')).toBeNull()
    expect(screen.queryByText(/free credit/i)).toBeNull()
  })
  it('...but a credential-only delivery that did NOT clear the bar still gets it, because that is when the credit helps', async () => {
    auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 1 }
    await open(badgeDelivered({ fixAtsScore: 74, verificationUrl: null }), '/scan/s1/resume')
    expect(screen.getByTestId('badge-upgrade')).toBeInTheDocument()
  })
  it('the offer itself is gone once anything has been bought', async () => {
    auth.user = { id: 'u1', emailVerified: true, freeFixCredits: 2 }
    await open(badgeDelivered(), '/scan/s1')
    expect(screen.queryByTestId('offer-card')).toBeNull()
  })
})

describe('the dashboard row follows the same passage', () => {
  const row = o => ({ id: 'r1', status: 'FIX_DELIVERED', fixPurchased: true, atsScore: 84, fixAtsScore: 84, fixTier: 'BADGE', verificationCode: 'abc', verificationStatus: 'ACTIVE', ...o })
  it('credential-only: Scanned, Verified', () => { expect(passage(row()).map(s => s.name)).toEqual(['Scanned', 'Verified']) })
  it('plain fix: Scanned, Fixed', () => { expect(passage(row({ fixTier: 'FIX_PLAIN', verificationCode: null })).map(s => s.name)).toEqual(['Scanned', 'Fixed']) })
  it('full fix, and a scan nobody has bought yet: all three', () => {
    expect(passage(row({ fixTier: 'FIX' })).map(s => s.name)).toEqual(['Scanned', 'Fixed', 'Verified'])
    expect(passage({ id: 'r', status: 'COMPLETE_PASS', fixPurchased: false, fixTier: 'BADGE', atsScore: 84 }).map(s => s.name)).toEqual(['Scanned', 'Fixed', 'Verified'])
  })
  it('credential-only in progress: the Verified step is the current one, and the message says verifying', () => {
    const r = row({ status: 'FIX_GENERATING', fixAtsScore: null, verificationCode: null })
    expect(passage(r).find(s => s.name === 'Verified').state).toBe('now')
    expect(scanMessage(r).label).toBe('Verifying')
    render(<StageTracker scan={r} now={Date.now()} />)
    expect(screen.queryByText('Fixed')).toBeNull()
  })
})
