// @vitest-environment jsdom
// The last audit round: the return trip, the verify-email return, the stale quota, the Human rewrite decisions, the shared job-input
// pieces on the homepage card, and a guard so low-contrast informative text does not come back.
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import { scanTarget } from '../src/lib/anonScans'
import { rememberVerifyReturn, peekVerifyReturn, clearVerifyReturn } from '../src/lib/verifyReturn'
import VerifyEmail from '../src/pages/VerifyEmail'
import ScanComposer from '../src/components/scan/ScanComposer'
import ScanForm from '../src/components/scan/ScanForm'
import FixBanner from '../src/components/scan/FixBanner'
import JdMeter, { jdMeter } from '../src/components/scan/JdMeter'
import { resetHumanDemandCache } from '../src/lib/humanDemand'
import { AuthContext } from '../src/context/AuthContext'

const auth = { user: null, refreshUser: vi.fn(async () => null) }
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, getErrorMessage: (e, f) => e?.response?.data?.message || f }))
vi.mock('../src/hooks/usePricing', async orig => ({ ...(await orig()), usePricing: () => ({ pricing: { currency: 'USD' }, byTier: t => ({ FIX: { amount: 2900, originalAmount: 2900 }, FIX_PLAIN: { amount: 1900, originalAmount: 1900 }, BADGE: { amount: 900, originalAmount: 900 } }[t]), pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }) }))
beforeEach(() => { localStorage.clear(); api.get.mockReset(); api.post.mockReset(); auth.user = null })
afterEach(cleanup)
const ID = '7c4741b6-3dd4-4369-ab0a-e43679346748'
const JD = 'We are hiring a product manager to lead payments. '.repeat(4)

describe('the return trip lands on the scan the person was on', () => {
  it('next is a scan page: go back to it, tab kept, the throwaway token dropped, even if another scan was claimed last', () => {
    expect(scanTarget(`/scan/${ID}?token=abc`, 'someone-else-0000')).toBe(`/scan/${ID}`)
    expect(scanTarget(`/scan/${ID}/resume`, 'x-claimed-1234')).toBe(`/scan/${ID}/resume`)
    expect(scanTarget(`/scan/${ID}?x=1&token=abc`, null)).toBe(`/scan/${ID}?x=1`)
  })
  it('next is anything else: the claimed scan wins, then next, then the dashboard', () => {
    expect(scanTarget('/pricing', 'claimed-0000-1')).toBe('/scan/claimed-0000-1')
    expect(scanTarget('/pricing', null)).toBe('/pricing')
    expect(scanTarget(null, null)).toBe('/dashboard')
    expect(scanTarget('/scan/../../admin', 'claimed-0000-1')).toBe('/scan/claimed-0000-1')        // not a scan path: not trusted as one
  })
})

describe('email verification brings a stopped buyer back', () => {
  async function verifyPage(user) {
    auth.user = user
    api.post.mockResolvedValue({ data: {} })
    render(<MemoryRouter initialEntries={['/verify-email?token=t1']}><Routes><Route path="/verify-email" element={<VerifyEmail />} /><Route path="*" element={<p>ELSEWHERE</p>} /></Routes></MemoryRouter>)
    await screen.findByText('Email verified')
  }
  it('only real scan pages are remembered, and only for as long as the link works', () => {
    rememberVerifyReturn('/dashboard'); expect(peekVerifyReturn()).toBeNull()
    rememberVerifyReturn(`/scan/${ID}/apply`); expect(peekVerifyReturn()).toBe(`/scan/${ID}/apply`)
    localStorage.setItem('passthrough_verify_return', JSON.stringify({ path: `/scan/${ID}`, at: Date.now() - 49 * 3600e3 }))
    expect(peekVerifyReturn()).toBeNull()
    clearVerifyReturn(); expect(localStorage.getItem('passthrough_verify_return')).toBeNull()
  })
  it('signed in: a primary "Back to your scan" button, the dashboard as the quiet option', async () => {
    rememberVerifyReturn(`/scan/${ID}/resume`)
    await verifyPage({ id: 'u1' })
    expect(screen.getByTestId('verify-back')).toHaveAttribute('href', `/scan/${ID}/resume`)
    expect(screen.getByRole('link', { name: /Go to dashboard/ })).toBeInTheDocument()
  })
  it('opened in a browser that is not signed in: back goes through sign-in and returns to the scan', async () => {
    rememberVerifyReturn(`/scan/${ID}`)
    await verifyPage(null)
    expect(screen.getByTestId('verify-back')).toHaveAttribute('href', `/login?next=${encodeURIComponent(`/scan/${ID}`)}`)
  })
  it('nobody was buying anything: unchanged, just the dashboard', async () => {
    await verifyPage({ id: 'u1' })
    expect(screen.queryByTestId('verify-back')).toBeNull()
    expect(screen.getByRole('link', { name: /Go to dashboard/ })).toBeInTheDocument()
  })
})

describe('the page believes the server about the daily limit', () => {
  it('after a 429 the quota is re-read and the used-up card replaces the ready button', async () => {
    auth.user = { id: 'u1', name: 'Ada', emailVerified: true }
    let spent = false
    api.get.mockImplementation(async url => url === '/profile'
      ? { data: { data: { hasSavedProfile: false, quota: { limit: 3, used: spent ? 3 : 1, remaining: spent ? 0 : 2, resetsAt: new Date(Date.now() + 36e5).toISOString() } } } }
      : { data: { data: { scans: [] } } })
    api.post.mockImplementation(async () => { spent = true; const e = new Error('x'); e.response = { status: 429, data: { message: 'Daily scan limit reached (3 free scans a day).' } }; throw e })
    const u = userEvent.setup()
    render(<MemoryRouter><ScanComposer /></MemoryRouter>)
    await screen.findByText(/2 of 3 free scans left/)
    await u.upload(document.querySelector('input[type=file]'), new File([new Uint8Array(2048)], 'cv.pdf', { type: 'application/pdf' }))
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: JD } })
    await u.click(screen.getByRole('button', { name: /Free/ }))
    expect(await screen.findByTestId('spent')).toBeInTheDocument()
    expect(screen.getByTestId('quota')).toHaveTextContent('0 of 3 free scans left')
  })
})

describe('the Human rewrite option (flag on)', () => {
  const cfg = { variant: 'a', currency: 'USD', tiers: [], prices: { polish: 4900, seven_day: 9900, forty_eight_hour: 14900, twenty_four_hour: 19900, cover_letter: 1500 } }
  beforeEach(() => { resetHumanDemandCache(); api.get.mockResolvedValue({ data: { data: cfg } }); api.post.mockResolvedValue({ data: { data: { joined: true } } }) })
  const scan = o => ({ id: 's1', status: 'COMPLETE_FAIL', atsScore: 62, badgeEligible: false, inputMode: 'text', fixPurchased: false, ...o })
  const wrap = (s, user = null) => <AuthContext.Provider value={{ user }}><FixBanner scan={s} onPay={vi.fn()} onRedeemCredit={vi.fn()} /></AuthContext.Provider>
  it('is offered beside the full fix', async () => {
    render(wrap(scan()))
    expect(await screen.findByTestId('human-rewrite-option')).toBeInTheDocument()
  })
  it('is NOT offered beside the credential-only lead offer, which says nothing is rewritten', async () => {
    render(wrap(scan({ status: 'COMPLETE_PASS', atsScore: 87, badgeEligible: true })))
    await screen.findByTestId('offer-card')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(screen.getByTestId('offer-card')).toHaveAttribute('data-primary', 'BADGE')
    expect(screen.queryByTestId('human-rewrite-option')).toBeNull()
  })
  it('describes what happens "when this opens", not as a service that already runs', async () => {
    const u = userEvent.setup()
    render(wrap(scan()))
    await u.click(await screen.findByTestId('human-rewrite-button'))
    expect(document.body.textContent).toMatch(/When this opens, a human expert will see your resume\. Your contact details will be hidden while they work\./)
    expect(document.body.textContent).not.toMatch(/stay hidden while they work/)
  })
  it('checks the email address before sending, with the reason', async () => {
    const u = userEvent.setup()
    render(wrap(scan()))
    await u.click(await screen.findByTestId('human-rewrite-button'))
    await u.click(screen.getByLabelText(/Human polish/))
    await u.type(screen.getByLabelText('Your email'), 'not-an-email')
    await u.click(screen.getByLabelText(/Email me when/))
    await u.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.')
    expect(api.post.mock.calls.some(c => c[0] === '/human-demand/waitlist')).toBe(false)
  })
})

describe('the homepage card says what the /scan page says', () => {
  const mountCard = () => render(<MemoryRouter><ScanForm /></MemoryRouter>)
  it('a visitor sees the real limits, not just "kept for 24 hours"', () => {
    mountCard()
    expect(screen.getByTestId('anon-limits')).toHaveTextContent(/free scan.* an hour, result kept for 24 hours\. A free account gets 3 a day, saved for good\./)
  })
  it('a LinkedIn link is flagged while it is typed, with the way out', async () => {
    const u = userEvent.setup()
    mountCard()
    await u.click(screen.getByRole('button', { name: /Job link|From a link|URL/i }))
    await u.type(screen.getByPlaceholderText(/jobs\.example\.com/), 'https://www.linkedin.com/jobs/view/1')
    const note = screen.getByTestId('link-blocked')
    await u.click(within(note).getByRole('button', { name: 'Switch to paste' }))
    expect(screen.getByPlaceholderText(/Paste the full job description/)).toBeInTheDocument()
  })
  it('the posting length is judged by the same meter', () => {
    mountCard()
    fireEvent.change(screen.getByPlaceholderText(/Paste the full job description/), { target: { value: 'short text' } })
    expect(screen.getByTestId('jd-meter-msg')).toHaveTextContent('40 more characters needed')
  })
  it('the meter itself: red under 50, amber when thin, green when full, amber and trimmed when long', () => {
    expect(jdMeter(0).tone).toBe('bad'); expect(jdMeter(49).msg).toBe('1 more characters needed')
    expect(jdMeter(200).tone).toBe('mid'); expect(jdMeter(800).tone).toBe('ok'); expect(jdMeter(6000).msg).toMatch(/Long\. We trim/)
    const { container } = render(<JdMeter text={'a'.repeat(900)} />)
    expect(container.textContent).toContain('900 / 5,000')
  })
})

describe('informative text stays readable (WCAG AA)', () => {
  // text-gray-400 is 2.5:1 on white, text-amber-600 3.2:1, text-red-500 3.8:1. Icons are exempt; words are not.
  const files = []
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.jsx$/.test(e.name) && files.push(path.join(d, e.name)))
  walk(path.resolve(process.cwd(), 'frontend/src/components/scan'))
  files.push(path.resolve(process.cwd(), 'frontend/src/pages/ScanResult.jsx'))
  it('no words in the scan journey use a colour below 4.5:1 on white', () => {
    const bad = []
    for (const f of files) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (/<svg|h-5 w-5|h-10 w-10/.test(l)) return
      if (/(^|[^:\w-])text-(gray-400|amber-600|red-500)\b/.test(l)) bad.push(`${path.basename(f)}:${i + 1}`)
    })
    expect(bad).toEqual([])
  })
})
