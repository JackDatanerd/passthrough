// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import api from '../src/lib/api'
import ScanComposer from '../src/components/scan/ScanComposer'
const auth = { user: null }
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }, getErrorMessage: (e, f) => e?.response?.data?.error || f }))
vi.mock('../src/hooks/usePricing', () => ({ usePricing: () => ({ pricing: null, byTier: () => ({ amount: 2900, originalAmount: 2900 }) }) }))
const JD = 'We are hiring a product manager to lead payments. '.repeat(4)
const SOURCE = 's-old'
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p> }
const mount = (path = '/scan') => render(<MemoryRouter initialEntries={[path]}><Where /><Routes><Route path="/scan" element={<ScanComposer />} /><Route path="/scan/:id" element={<p>RESULT</p>} /></Routes></MemoryRouter>)
const goBtn = () => screen.getByRole('button', { name: /Free/ })
const file = () => new File([new Uint8Array(2048)], 'cv.pdf', { type: 'application/pdf' })
const jd = () => screen.getByLabelText('Job description')
let lastForm
function wire({ signedIn = false } = {}) {
  auth.user = signedIn ? { id: 'u1', name: 'Ada', email: 'ada@x.io', emailVerified: true } : null
  api.get.mockReset(); api.post.mockReset(); lastForm = null
  api.get.mockImplementation(async url => {
    if (url === '/profile') return { data: { data: { hasSavedProfile: true, extraProfiles: [{ id: 'p2', label: 'Design' }], quota: { limit: 3, used: 1, remaining: 2, resetsAt: new Date(Date.now() + 3600e3).toISOString() } } } }
    if (url === '/scan/history') return { data: { data: { scans: [{ id: SOURCE, status: 'COMPLETE_FAIL', atsScore: 61, resumeOriginalName: 'old.pdf', inputMode: 'file', createdAt: '2026-10-01T10:00:00Z', jobTitle: 'Designer' }] } } }
    if (url.startsWith('/scan/')) return { data: { data: { id: SOURCE, status: 'COMPLETE_FAIL', resumeOriginalName: 'old.pdf', inputMode: 'file' } } }
    return { data: { data: {} } }
  })
  api.post.mockImplementation(async (url, fd) => { lastForm = Object.fromEntries(fd.entries()); return { data: { data: { scanId: 'new1', anonToken: signedIn ? undefined : 'tok' } } } })
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

// Integration: the REAL composer and the REAL useScanForm, only the network mocked. Every source, every button, every deep link.
describe('composer: every mode submits what it says', () => {
  it('upload (anon) with an email, a pasted job and Letter paper', async () => {
    wire(); const u = userEvent.setup(); mount()
    await u.upload(document.querySelector('input[type=file]'), file())
    expect(screen.getByTestId('file-chip')).toHaveTextContent('cv.pdf')
    await u.type(screen.getByLabelText(/Email me the result link/), 'me@x.io')
    fireEvent.change(jd(), { target: { value: JD } })
    await u.click(screen.getByText('Options'))
    await u.selectOptions(screen.getByRole('combobox'), 'letter')
    await u.click(goBtn())
    await waitFor(() => expect(screen.getByText('RESULT')).toBeInTheDocument())
    expect(lastForm.resume.name).toBe('cv.pdf'); expect(lastForm.contactEmail).toBe('me@x.io'); expect(lastForm.paperSize).toBe('letter'); expect(lastForm.jobDescriptionText).toContain('product manager')
    expect(JSON.parse(localStorage.getItem('anonScanTokens') || sessionStorage.getItem('anonScanTokens') || '{}')).toBeTruthy()
  })
  it('write-from-scratch (anon) needs and sends name + email', async () => {
    wire(); const u = userEvent.setup(); mount()
    await u.click(screen.getByRole('radio', { name: /Start from scratch/ }))
    fireEvent.change(screen.getByLabelText(/Your background/), { target: { value: 'I led payments at Acme for six years. '.repeat(4) } })
    fireEvent.change(jd(), { target: { value: JD } })
    await u.click(goBtn()); expect(screen.getByTestId('where')).toHaveTextContent('/scan')   // blocked: no contact yet
    await u.type(screen.getByLabelText('Your full name'), 'Ada L'); await u.type(screen.getByLabelText('Your email'), 'ada@x.io')
    await u.click(goBtn()); await waitFor(() => screen.getByText('RESULT'))
    expect(lastForm.brainDumpText).toContain('payments'); expect(lastForm.contactName).toBe('Ada L'); expect(lastForm.contactEmail).toBe('ada@x.io')
  })
  it('fill-it-in-myself (signed in) sends resumeDataJson with the account name prefilled', async () => {
    wire({ signedIn: true }); const u = userEvent.setup(); mount()
    await u.click(await screen.findByRole('radio', { name: /Fill it in myself/ }))
    expect(screen.getByDisplayValue('Ada')).toBeInTheDocument()
    await u.type(screen.getByLabelText(/Summary/i), 'Product leader with a payments background.')
    fireEvent.change(jd(), { target: { value: JD } })
    await u.click(goBtn()); await waitFor(() => screen.getByText('RESULT'))
    expect(JSON.parse(lastForm.resumeDataJson).name).toBe('Ada')
  })
  it('saved profile with a chosen extra profile', async () => {
    wire({ signedIn: true }); const u = userEvent.setup(); mount()
    await u.click(await screen.findByRole('radio', { name: /Use my saved profile/ }))
    await u.selectOptions(screen.getByLabelText('Profile to use'), 'p2')
    fireEvent.change(jd(), { target: { value: JD } })
    await u.click(goBtn()); await waitFor(() => screen.getByText('RESULT'))
    expect(lastForm.useSavedProfile).toBe('true'); expect(lastForm.savedProfileId).toBe('p2')
  })
  it('reuse a recent one: radio list, then source id sent', async () => {
    wire({ signedIn: true }); const u = userEvent.setup(); mount()
    await u.click(await screen.findByRole('radio', { name: /Reuse a recent one/ }))
    expect(screen.getByRole('radio', { name: /old\.pdf/ })).toBeChecked()
    fireEvent.change(jd(), { target: { value: JD } })
    await u.click(goBtn()); await waitFor(() => screen.getByText('RESULT'))
    expect(lastForm.sourceScanId).toBe(SOURCE)
  })
  it('job from a link: schemeless link gets https://', async () => {
    wire(); const u = userEvent.setup(); mount()
    await u.upload(document.querySelector('input[type=file]'), file())
    await u.click(screen.getByRole('button', { name: 'From a link' }))
    await u.type(screen.getByLabelText('Job posting link'), 'jobs.acme.com/pm-1')
    await u.click(goBtn()); await waitFor(() => screen.getByText('RESULT'))
    expect(lastForm.jobDescriptionUrl).toBe('https://jobs.acme.com/pm-1'); expect(lastForm.jobDescriptionText).toBeUndefined()
  })
  it('a server refusal is shown, the form keeps everything, the button comes back', async () => {
    wire(); const u = userEvent.setup(); mount()
    api.post.mockRejectedValueOnce({ response: { status: 429, data: { error: 'Too many scans. Try later.' } } })
    await u.upload(document.querySelector('input[type=file]'), file()); fireEvent.change(jd(), { target: { value: JD } })
    await u.click(goBtn())
    expect(await screen.findByText('Too many scans. Try later.')).toBeInTheDocument()
    expect(screen.getByTestId('file-chip')).toBeInTheDocument(); expect(jd()).toHaveValue(JD)
    expect(goBtn()).not.toHaveAttribute('aria-busy')
  })
  it('Replace and Remove file work', async () => {
    wire(); const u = userEvent.setup(); mount()
    await u.upload(document.querySelector('input[type=file]'), file())
    await u.click(screen.getByRole('button', { name: 'Remove file' }))
    expect(screen.queryByTestId('file-chip')).toBeNull(); expect(screen.getByRole('button', { name: /Drop your resume here/ })).toBeInTheDocument()
  })
  it('switching tiles and back keeps the file and the job text', async () => {
    wire(); const u = userEvent.setup(); mount()
    await u.upload(document.querySelector('input[type=file]'), file()); fireEvent.change(jd(), { target: { value: JD } })
    await u.click(screen.getByRole('radio', { name: /Start from scratch/ })); await u.click(screen.getByRole('radio', { name: /Upload a file/ }))
    expect(screen.getByTestId('file-chip')).toBeInTheDocument(); expect(jd()).toHaveValue(JD)
  })
  it('exhausted quota blocks the send and says why', async () => {
    wire({ signedIn: true }); api.get.mockImplementation(async url => url === '/profile' ? { data: { data: { quota: { limit: 3, used: 3, remaining: 0, resetsAt: new Date(Date.now() + 3600e3).toISOString() } } } } : { data: { data: { scans: [] } } })
    const u = userEvent.setup(); mount()
    expect(await screen.findByTestId('spent')).toBeInTheDocument()
    await u.click(goBtn()); expect(api.post).not.toHaveBeenCalled()
  })
})

describe('composer: deep links and recovery', () => {
  it('?from=<credential-only delivery> offers the delivered version too (its file IS the original, and the server accepts it)', async () => {
    wire({ signedIn: true })
    const real = api.get.getMockImplementation()
    api.get.mockImplementation(async (url, ...a) => url === '/scan/' + SOURCE ? { data: { data: { id: SOURCE, status: 'FIX_DELIVERED', fixPurchased: true, fixTier: 'BADGE', rewrittenResumeData: null, userEditedResumeData: null, resumeOriginalName: 'old.pdf', inputMode: 'file' } } } : real(url, ...a))
    const u = userEvent.setup(); mount('/scan?from=' + SOURCE)
    const box = await screen.findByTestId('rescan-use-improved')
    await u.click(box)
    fireEvent.change(jd(), { target: { value: JD } })
    await u.click(goBtn()); await waitFor(() => screen.getByText('RESULT'))
    expect(lastForm.rescanVersion).toBe('delivered')
  })
  it('?from=<scan> opens reuse with that resume chosen and sends sourceScanId', async () => {
    wire({ signedIn: true }); const u = userEvent.setup(); mount('/scan?from=' + SOURCE)
    await waitFor(() => expect(screen.getByRole('radio', { name: /old\.pdf/ })).toBeChecked())
    fireEvent.change(jd(), { target: { value: JD } })
    await u.click(goBtn()); await waitFor(() => screen.getByText('RESULT'))
    expect(lastForm.sourceScanId).toBe(SOURCE)
  })
  it('?mode=brainDump and ?mode=manual open those panels; ?mode=savedProfile&profile= preselects the profile', async () => {
    wire({ signedIn: true }); let r = mount('/scan?mode=brainDump')
    expect(await screen.findByLabelText(/Your background/)).toBeInTheDocument(); r.unmount()
    wire({ signedIn: true }); r = mount('/scan?mode=manual'); expect(await screen.findByDisplayValue('Ada')).toBeInTheDocument(); r.unmount()
    wire({ signedIn: true }); mount('/scan?mode=savedProfile&profile=p2')
    await waitFor(() => expect(screen.getByLabelText('Profile to use')).toHaveValue('p2'))
  })
  it('the job text typed before leaving comes back, with its notice', async () => {
    wire(); let r = mount(); fireEvent.change(jd(), { target: { value: JD } }); r.unmount()
    mount(); expect(jd()).toHaveValue(JD); expect(screen.getByText(/We kept the job you were adding/)).toBeInTheDocument()
  })
  it('a link the server cannot read flips to paste and keeps the other half', async () => {
    wire(); const u = userEvent.setup(); mount()
    api.post.mockRejectedValueOnce({ response: { status: 400, data: { code: 'JD_URL_FAILED', error: 'Could not read that page.' } } })
    await u.upload(document.querySelector('input[type=file]'), file())
    await u.click(screen.getByRole('button', { name: 'From a link' })); await u.type(screen.getByLabelText('Job posting link'), 'https://jobs.acme.com/x')
    await u.click(goBtn())
    expect(await screen.findByText('Could not read that page.')).toBeInTheDocument()
    expect(jd()).toBeInTheDocument(); expect(screen.getByTestId('file-chip')).toBeInTheDocument()
  })
  it('keyboard: Tab reaches the source cards, the drop area, the optional email, the job switch, the job box, then Options', async () => {
    wire(); const u = userEvent.setup(); mount()
    const order = []; for (let i = 0; i < 8; i++) { await u.tab(); order.push(document.activeElement.getAttribute('data-tile') || document.activeElement.getAttribute('aria-label') || document.activeElement.textContent) }
    expect(order[1]).toBe('upload')                                    // the chosen card is the one stop in its group
    expect(order[2]).toMatch(/Drop your resume here/)
    expect(order.join('|')).toMatch(/Paste text\|From a link\|Job description\|Options/)
  })
})
