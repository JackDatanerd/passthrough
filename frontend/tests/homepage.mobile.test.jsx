// @vitest-environment jsdom
// Mobile pass. jsdom has no layout engine, so these pin the DECISIONS that the real-browser measurements drove
// (DOM order, which classes carry the responsive behaviour, what the animations show before they run) — the
// numbers themselves (no horizontal overflow at 320–1280px, the upload box at y≈544 on a 390×800 phone) were
// measured in Chromium against the built app.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import { AuthContext } from '../src/context/AuthContext'
import Home from '../src/pages/Home'
import Navbar from '../src/components/layout/Navbar'
import Footer from '../src/components/layout/Footer'
import Input from '../src/components/ui/Input'
import Textarea from '../src/components/ui/Textarea'
import VerifySection from '../src/components/home/VerifySection'
import EmployerLeadForm from '../src/components/lead/EmployerLeadForm'
import { _resetHomeDataCache } from '../src/hooks/useHomeData'
import { setStoredReferralCode } from '../src/hooks/useReferralCapture'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), defaults: { baseURL: '/api' } }, getErrorMessage: (e, f) => f }))
vi.mock('../src/components/scan/ScanForm', () => ({ default: () => <div data-testid="scan-form-stub" /> }))

const tiers = [{ tier: 'BADGE', amount: 3900, originalAmount: 3900 }, { tier: 'FIX_PLAIN', amount: 3900, originalAmount: 3900 }, { tier: 'FIX', amount: 4900, originalAmount: 4900 }]
let clock = Date.now()
beforeEach(() => {
  clock += 10 * 60 * 1000
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock)
  api.get.mockReset(); localStorage.clear(); window.history.replaceState({}, '', '/')
  setStoredReferralCode(''); _resetHomeDataCache()
  api.get.mockImplementation(async (url) => {
    if (url.startsWith('/pricing')) return { data: { data: { currency: 'USD', promoActive: false, badgeThreshold: 80, maxFixRetries: 2, freeScansPerDay: 3, anonScansPerHour: 1, tiers } } }
    if (url === '/stats') throw new Error('down')
    throw new Error('unexpected GET ' + url)
  })
})
afterEach(() => vi.useRealTimers())

const renderHome = (user = null) => render(<AuthContext.Provider value={{ user, logout() {} }}><MemoryRouter><Home /></MemoryRouter></AuthContext.Provider>)
const ready = () => screen.findAllByText(/resumes scanned/)

// A controllable IntersectionObserver: records what each instance watches and lets a test fire it.
let observers
class FakeIO {
  constructor(cb) { this.cb = cb; this.els = []; observers.push(this) }
  observe(el) { this.els.push(el) }
  unobserve() {} disconnect() {}
}
const fire = (el, entry) => act(() => { observers.filter(o => o.els.includes(el)).forEach(o => o.cb([{ target: el, isIntersecting: false, boundingClientRect: { top: 0 }, ...entry }], o)) })
function withFakeIO() {
  observers = []
  const prev = window.IntersectionObserver
  window.IntersectionObserver = FakeIO
  return () => { window.IntersectionObserver = prev }
}

describe('hero order: the scan card must be on the first phone screen', () => {
  it('DOM order is pitch → scan card → proof (phone), and desktop keeps the card in the right column spanning both rows', async () => {
    renderHome(); await ready()
    const h1 = screen.getByRole('heading', { level: 1 })
    const card = document.getElementById('scan-form')
    const proof = screen.getByText(/Built for Workday/).closest('div[class*="min-w-0"]')
    const pos = (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    expect(pos(h1, card)).toBeTruthy()
    expect(pos(card, proof)).toBeTruthy()
    expect(card.className).toMatch(/lg:col-start-2/)
    expect(card.className).toMatch(/lg:row-span-2/)
    expect(proof.className).toMatch(/lg:col-start-1/)
    expect(proof.className).toMatch(/lg:row-start-2/)
  })
  it('the key-facts row is a 3-column grid on phones (no orphaned third fact)', async () => {
    renderHome(); await ready()
    expect(screen.getByText('earns the Verified link').closest('dl').className).toMatch(/grid-cols-3/)
  })
  it('the headline steps down on phones so it does not eat the first screen', async () => {
    renderHome(); await ready()
    expect(screen.getByRole('heading', { level: 1 }).className).toMatch(/text-\[34px\].*sm:text-5xl/)
  })
})

describe('navbar fits 320–360px phones', () => {
  const renderNav = (user = null) => render(<MemoryRouter><AuthContext.Provider value={{ user, logout() {} }}><Navbar /></AuthContext.Provider></MemoryRouter>)
  it('Pricing leaves the bar below sm for everyone, Sign in leaves it below 340px — both stay reachable in "More"', () => {
    renderNav()
    const bar = screen.getAllByRole('navigation')[0]
    expect(within(bar).getAllByText('Pricing')[0].className).toMatch(/hidden sm:block/)
    const signIn = within(bar).getAllByText('Sign in')[0]
    expect(signIn.className).toMatch(/hidden min-\[340px\]:block/)
    fireEvent.click(screen.getByRole('button', { name: /More/ }))
    const menu = document.getElementById('navbar-more')
    expect(within(menu).getByText('Pricing')).toBeInTheDocument()
    expect(within(menu).getByText('Sign in').className).toMatch(/min-\[340px\]:hidden/)
  })
  it('a signed-in user never gets a "Sign in" row', () => {
    renderNav({ id: 'u1', role: 'USER', emailVerified: true })
    fireEvent.click(screen.getByRole('button', { name: /More/ }))
    expect(within(document.getElementById('navbar-more')).queryByText('Sign in')).toBeNull()
  })
  it('bar items keep a thumb-sized hit area on phones (padding, not a wider gap)', () => {
    renderNav()
    const bar = screen.getAllByRole('navigation')[0]
    expect(within(bar).getAllByText('Sign in')[0].className).toMatch(/py-3/)
    expect(screen.getByRole('button', { name: /More/ }).className).toMatch(/py-3/)
    expect(within(bar).getByText('Get started').className).toMatch(/whitespace-nowrap|py-2/)
  })
})

describe('iOS zoom-on-focus: form controls are 16px on phones', () => {
  it('Input and Textarea use text-base below sm and text-sm from sm up', () => {
    render(<><Input label="A" /><Textarea label="B" /></>)
    for (const el of [screen.getByLabelText('A'), screen.getByLabelText('B')]) {
      expect(el.className).toMatch(/\btext-base\b/)
      expect(el.className).toMatch(/\bsm:text-sm\b/)
      expect(el.className).not.toMatch(/(^|\s)text-sm(\s|$)/)
    }
  })
  it('the homepage-owned inputs follow the same rule', () => {
    render(<MemoryRouter><VerifySection badgeThreshold={80} /></MemoryRouter>)
    expect(screen.getByLabelText('Resume line').className).toMatch(/\btext-base\b/)
    expect(screen.getByLabelText('Verification code or link').className).toMatch(/\btext-base\b/)
  })
  it('the employer form select label is short enough not to be clipped at 390px', () => {
    render(<MemoryRouter><EmployerLeadForm /></MemoryRouter>)
    const opt = screen.getByRole('option', { name: /Field you are hiring in/ })
    expect(opt.textContent.length).toBeLessThanOrEqual(36)
  })
})

describe('the receipt ticket can shrink to a 320px screen', () => {
  it('its grid columns and score row are allowed to be narrower than their content', () => {
    render(<MemoryRouter><VerifySection badgeThreshold={80} /></MemoryRouter>)
    const ticket = screen.getByLabelText('Example of the page an employer sees')
    expect(ticket.parentElement.className).toMatch(/min-w-0/)
    expect(screen.getByText('Try the tamper test').closest('div[class*="min-w-0"]')).toBeTruthy()
    expect(ticket.querySelector('[class*="minmax(0,1fr)"]')).toBeTruthy()
    expect(ticket.querySelector('[class*="text-4xl"]')).toBeTruthy()          // the big score steps down on phones
  })
})

describe('pricing on a phone', () => {
  it('Full fix is first in the stack on phones (and tablets), but keeps its middle slot on desktop', async () => {
    renderHome(); await ready()
    const full = document.querySelector('[data-plan="full"]')
    expect(full.className).toMatch(/\border-first\b/)
    expect(full.className).toMatch(/\blg:order-none\b/)
    expect(full.className).toMatch(/\bsm:col-span-2\b/)
    expect(full.className).toMatch(/\blg:col-span-1\b/)
  })
  it('the zone labels have a short form for narrow screens and the full form from sm up', async () => {
    renderHome(); await ready()
    expect(screen.getByText('Below 75: fails').className).toMatch(/hidden sm:inline/)
    expect(screen.getByText('Fails').className).toMatch(/sm:hidden/)
    expect(screen.getByText('80+: credential').className).toMatch(/hidden sm:inline/)
    expect(screen.getByText('80+', { selector: 'span.sm\\:hidden' })).toBeInTheDocument()
  })
})

describe('count-up never shows 0', () => {
  it('the stats band shows the real numbers until it scrolls into view', async () => {
    const restore = withFakeIO()
    try {
      renderHome(); await ready()
      const band = screen.getByLabelText('Passthrough by the numbers')
      expect(within(band).getByText('25,000+')).toBeInTheDocument()
      expect(within(band).getByText('66%')).toBeInTheDocument()
      expect(band.textContent).not.toMatch(/(^|[^\d])0\+|(^|[^\d])0%/)
    } finally { restore() }
  })
  it('after it is revealed it counts and ends exactly on the real number', async () => {
    const restore = withFakeIO()
    try {
      renderHome(); await ready()
      const band = screen.getByLabelText('Passthrough by the numbers')
      fire(band, { isIntersecting: true })
      await waitFor(() => expect(within(band).getByText('25,000+')).toBeInTheDocument(), { timeout: 4000 })
      expect(within(band).getByText('66%')).toBeInTheDocument()
    } finally { restore() }
  })
})

describe('sticky scan bar (phones)', () => {
  const bar = () => [...document.querySelectorAll('div.fixed')].find(e => /Scan now/.test(e.textContent))
  it('appears once the scan card has scrolled away, and hides again while the closing call to action is on screen', async () => {
    const restore = withFakeIO()
    try {
      renderHome(); await ready()
      expect(bar().className).toMatch(/translate-y-full/)                         // hidden at the top
      fire(document.getElementById('scan-form'), { isIntersecting: false, boundingClientRect: { top: -300 } })
      expect(bar().className).toMatch(/translate-y-0/)                            // card passed → shown
      fire(document.getElementById('final-cta'), { isIntersecting: true })
      expect(bar().className).toMatch(/translate-y-full/)                         // closing CTA visible → hidden
      fire(document.getElementById('final-cta'), { isIntersecting: false })
      expect(bar().className).toMatch(/translate-y-0/)
    } finally { restore() }
  })
  it('is not shown while the card is merely below the fold (it has not been scrolled past)', async () => {
    const restore = withFakeIO()
    try {
      renderHome(); await ready()
      fire(document.getElementById('scan-form'), { isIntersecting: false, boundingClientRect: { top: 600 } })
      expect(bar().className).toMatch(/translate-y-full/)
    } finally { restore() }
  })
  it('its links are unreachable by keyboard while hidden, and the footer has room above it', async () => {
    renderHome(); await ready()
    expect(within(bar()).getByText('Scan now').closest('a')).toHaveAttribute('tabindex', '-1')
    expect(bar().getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('div.sm\\:hidden.h-16')).toBeTruthy()
  })
})

describe('smaller touch details', () => {
  it('only the first three pull-quotes show on phones', async () => {
    renderHome(); await ready()
    const figs = within(document.getElementById('stories')).getAllByRole('figure', { hidden: true })
    expect(figs).toHaveLength(6)
    expect(figs.map(f => /hidden sm:block/.test(f.className))).toEqual([false, false, false, true, true, true])
  })
  it('"Read my story" is a 44px target', async () => {
    renderHome(); await ready()
    for (const s of document.querySelectorAll('#stories summary')) expect(s.className).toMatch(/min-h-\[44px\]/)
  })
  it('the "live" dot respects reduced motion', async () => {
    renderHome(); await ready()
    expect(document.querySelector('#hot .animate-pulse').className).toMatch(/motion-reduce:animate-none/)
  })
  it('footer links have vertical padding so they are not 20px-tall targets', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>)
    for (const a of screen.getAllByRole('link')) expect(a.className).toMatch(/py-1\.5/)
  })
})
