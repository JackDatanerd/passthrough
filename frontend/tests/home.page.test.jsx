// @vitest-environment jsdom
// The conversion homepage: live numbers beat hardcoded copy, placeholders are always labelled, a partner's
// discount shows on the first paint, and the whole thing degrades to its editable fallbacks when the
// network does not answer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import { AuthContext } from '../src/context/AuthContext'
import Home from '../src/pages/Home'
import { _resetHomeDataCache } from '../src/hooks/useHomeData'
import { setStoredReferralCode } from '../src/hooks/useReferralCapture'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), defaults: { baseURL: '/api' } }, getErrorMessage: (e, f) => f }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => <nav aria-label="Main" /> }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => <footer /> }))
vi.mock('../src/components/scan/ScanForm', () => ({ default: () => <div data-testid="scan-form-stub" /> }))

const tiers = (over = {}) => ({
  currency: 'USD', promoActive: false, badgeThreshold: 80, maxFixRetries: 2, freeScansPerDay: 3, anonScansPerHour: 1,
  tiers: [
    { tier: 'BADGE', amount: 3900, originalAmount: 3900 }, { tier: 'FIX_PLAIN', amount: 3900, originalAmount: 3900 }, { tier: 'FIX', amount: 4900, originalAmount: 4900 },
  ], ...over,
})
const liveStats = () => ({
  stats: { resumesScanned: 31234, responses: 212, interviewRatePct: 71, since: '2026-08-01T00:00:00Z', minResponses: 50 },
  hotCategories: { 7: [{ category: 'legal', interviews: 14, changePct: 40 }, { category: 'finance', interviews: 11, changePct: null }], 30: [{ category: 'sales', interviews: 90, changePct: -5 }], minReports: 10 },
  stories: [{ id: 'x1', displayName: 'Real R.', roleCategory: 'sales', scoreBefore: 44, scoreAfter: 90, interviewCount: 2, interviewAfterDays: 4, quote: 'It actually worked for me.', story: 'First paragraph.\n\nSecond paragraph.', credentialCode: 'ABCDEFGH23' }],
})

let pricingData, statsData
function wire() {
  api.get.mockImplementation(async (url) => {
    if (url.startsWith('/pricing')) { if (pricingData instanceof Error) throw pricingData; return { data: { data: pricingData } } }
    if (url === '/stats') { if (statsData instanceof Error) throw statsData; return { data: { data: statsData } } }
    throw new Error('unexpected GET ' + url)
  })
}
function renderHome({ user = null, path = '/' } = {}) {
  return render(
    <AuthContext.Provider value={{ user }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/" element={<Home />} /><Route path="/v/:code" element={<div data-testid="verify-page" />} /></Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  )
}
const ready = () => screen.findAllByText(/resumes scanned/)
// usePricing keeps a module-level cache with a 5-minute TTL; stepping the (faked) clock past it gives every
// test a cold cache without re-importing React (which would leave two copies of it in one process).
let clock = Date.now()
beforeEach(() => {
  clock += 10 * 60 * 1000
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock)
  api.get.mockReset(); localStorage.clear(); window.history.replaceState({}, '', '/')
  setStoredReferralCode('')   // also drops the module's in-memory copy of the code (kept on purpose for blocked-storage browsers)
  _resetHomeDataCache()
  pricingData = tiers(); statsData = liveStats(); wire()
})
afterEach(() => vi.useRealTimers())

describe('structure', () => {
  it('renders every section, in the order that sells: scan → proof → verify → price', async () => {
    renderHome()
    await screen.findByText(/31,000\+ resumes scanned/)
    const ids = ['scan-form', 'proof', 'stories', 'hot', 'verify', 'how', 'pricing', 'employers', 'faq']
    const els = ids.map(id => document.getElementById(id))
    els.forEach((el, i) => expect(el, ids[i]).toBeTruthy())
    for (let i = 1; i < els.length; i++) expect(els[i - 1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${ids[i - 1]} before ${ids[i]}`).toBeTruthy()
    expect(screen.getByTestId('scan-form-stub')).toBeInTheDocument()
    expect(document.getElementById('scan-form')).toContainElement(screen.getByTestId('scan-form-stub'))
  })
  it('has exactly one h1', async () => {
    renderHome()
    await ready()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})

describe('numbers come from the server, not the copy', () => {
  it('shows the live scan count (rounded DOWN) and the live rate with its response count and start month', async () => {
    renderHome()
    expect(await screen.findByText(/31,000\+ resumes scanned/)).toBeInTheDocument()
    expect(screen.getAllByText(/71% of applicants/).length).toBeGreaterThan(0)
    expect(screen.getByText(/based on 212 responses since August 2026/)).toBeInTheDocument()
  })
  it('free-scan limits, threshold and retry count are the API\'s — not the old hardcoded 3/day · 1/hour · 80+ · 2', async () => {
    pricingData = tiers({ badgeThreshold: 85, maxFixRetries: 3, freeScansPerDay: 5, anonScansPerHour: 2 })
    renderHome()
    await screen.findByText(/2 scans\/hour, no account/)
    expect(screen.getByText(/5\/day with a free account/)).toBeInTheDocument()
    expect(screen.getByText(/Already scoring 85\+\? Prove it\./)).toBeInTheDocument()
    expect(screen.getAllByText(/3 free (manual )?retries/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/3\/day with a free account/)).toBeNull()
    const stats = screen.getByLabelText('Passthrough by the numbers')
    expect(within(stats).getByText('85+')).toBeInTheDocument()
    expect(screen.getByText(/scored 85 or higher/)).toBeInTheDocument()
  })
})

describe('partner referral on the homepage', () => {
  it('asks /api/pricing with the stored code and shows the discounted price and the banner on the first paint', async () => {
    localStorage.setItem('passthrough_referral_code', JSON.stringify({ code: 'COACH20', capturedAt: Date.now() }))
    pricingData = tiers({ tiers: [
      { tier: 'BADGE', amount: 3900, originalAmount: 3900 }, { tier: 'FIX_PLAIN', amount: 3900, originalAmount: 3900 },
      { tier: 'FIX', amount: 3900, originalAmount: 4900, referralApplied: true, discountApplied: true },
    ] })
    renderHome()
    await screen.findByText(/Your referral discount is applied/)
    expect(api.get).toHaveBeenCalledWith('/pricing?ref=COACH20')
    const card = screen.getByText('Full fix').closest('div[class*="border-blue-700"]')
    expect(within(card).getByText('$39')).toBeInTheDocument()
    expect(within(card).getByText('$49')).toBeInTheDocument()   // struck-through anchor
  })
  it('a ?ref= in the landing URL is picked up before the first request (no wrong-price flash)', async () => {
    window.history.replaceState({}, '', '/?ref=newcode')
    renderHome({ path: '/?ref=newcode' })
    await ready()
    expect(api.get.mock.calls.some(c => c[0] === '/pricing?ref=NEWCODE')).toBe(true)
    expect(api.get.mock.calls.some(c => c[0] === '/pricing')).toBe(false)
  })
  it('no code: no banner, plain price request', async () => {
    renderHome()
    await ready()
    expect(api.get).toHaveBeenCalledWith('/pricing')
    expect(screen.queryByText(/referral discount/)).toBeNull()
  })
})

describe('pricing section', () => {
  it('frames Full fix against Fix only ("only $10 more") and shows the saving while a promo runs', async () => {
    pricingData = tiers({ promoActive: true, promoEndsAt: new Date(Date.now() + 3 * 3600e3).toISOString(), serverTime: Date.now(), tiers: [
      { tier: 'BADGE', amount: 900, originalAmount: 3900 }, { tier: 'FIX_PLAIN', amount: 1900, originalAmount: 3900 }, { tier: 'FIX', amount: 2900, originalAmount: 4900 },
    ] })
    renderHome()
    expect(await screen.findByText('You save $20 today')).toBeInTheDocument()
    expect(screen.getByText(/Only \$10 more than Fix only/)).toBeInTheDocument()
    expect(screen.getByText(/Most popular/)).toBeInTheDocument()
  })
  it('without a promo there is no fake anchor, saving or countdown', async () => {
    renderHome()
    await ready()
    expect(screen.queryByText(/You save/)).toBeNull()
    expect(screen.queryByRole('timer')).toBeNull()
    expect(screen.getByText(/Only \$10 more than Fix only/)).toBeInTheDocument()   // 49 − 39: the framing is true at standard prices too
  })
  it('falls back to the standard prices when /api/pricing is down', async () => {
    pricingData = new Error('down')
    renderHome()
    await ready()
    const card = screen.getByText('Full fix').closest('div[class*="border-blue-700"]')
    expect(within(card).getByText('$49')).toBeInTheDocument()
  })
})

describe('placeholders never pass as real', () => {
  it('when the stats call fails the page still renders from the fallbacks — and samples are tagged "Sample"', async () => {
    statsData = new Error('down')
    renderHome()
    expect(await screen.findByText(/25,000\+ resumes scanned/)).toBeInTheDocument()
    expect(screen.getAllByText('Sample').length).toBeGreaterThanOrEqual(4)   // 3 stories + the hot list
    expect(screen.getByText(/Sample numbers shown until enough real reports come in/)).toBeInTheDocument()
    expect(screen.getByText(/Stories are shared by customers with their permission/)).toBeInTheDocument()
    expect(screen.queryByText(/if the badge doesn't open, the story doesn't run/)).toBeNull()
  })
  it('live stories carry no Sample tag, link the real credential, and make the "live badge" promise only when it is true', async () => {
    renderHome()
    await screen.findByText(/It actually worked for me/)
    expect(screen.queryByText('Sample')).toBeNull()
    expect(screen.getByRole('link', { name: /View Real's Verified credential/ })).toHaveAttribute('href', '/v/ABCDEFGH23')
    expect(screen.getByText(/if the badge doesn't open, the story doesn't run/)).toBeInTheDocument()
    expect(screen.getByText('2 interviews')).toBeInTheDocument()
  })
  it('a story links no credential unless its author asked (no code in the payload = no link)', async () => {
    statsData = { ...liveStats(), stories: [{ ...liveStats().stories[0], credentialCode: null }] }
    renderHome()
    await screen.findByText(/It actually worked for me/)
    expect(screen.queryByRole('link', { name: /Verified credential/ })).toBeNull()
    expect(screen.getByText(/Stories are shared by customers with their permission/)).toBeInTheDocument()
  })
})

describe('hot categories', () => {
  it('shows the live 7-day list and switches window', async () => {
    renderHome()
    const section = await waitFor(() => { const s = document.getElementById('hot'); expect(within(s).getByText(/Legal/)).toBeInTheDocument(); return s })
    expect(within(section).getByText('▲ 40%')).toBeInTheDocument()
    expect(within(section).queryByText('Sample')).toBeNull()
    fireEvent.click(within(section).getByRole('button', { name: '30 days' }))
    expect(within(section).getByText(/Sales/)).toBeInTheDocument()
    expect(within(section).getByText('▼ 5%')).toBeInTheDocument()
    expect(within(section).getByText(/in the last 30 days/)).toBeInTheDocument()
  })
  it('a change that has no usable base is a dash, not a made-up percentage', async () => {
    renderHome()
    const section = await waitFor(() => { const s = document.getElementById('hot'); expect(within(s).getByText(/Finance/)).toBeInTheDocument(); return s })
    expect(within(section).getAllByText('—').length).toBeGreaterThan(0)
  })
  it('expands the sample list to all 12 fields on request', async () => {
    statsData = new Error('down')
    renderHome()
    const section = await waitFor(() => { const s = document.getElementById('hot'); expect(s).toBeTruthy(); return s })
    expect(within(section).getAllByRole('listitem')).toHaveLength(6)
    fireEvent.click(within(section).getByRole('button', { name: /Show all 12 fields/ }))
    expect(within(section).getAllByRole('listitem')).toHaveLength(12)
  })
})

describe('signed-in visitors', () => {
  it('are not told "no account needed"', async () => {
    renderHome({ user: { id: 'u1', emailVerified: true } })
    await ready()
    expect(screen.getByText('Saved to your dashboard')).toBeInTheDocument()
    expect(screen.queryByText('No account needed')).toBeNull()
  })
  it('anonymous visitors are', async () => {
    renderHome()
    await ready()
    expect(screen.getByText('No account needed')).toBeInTheDocument()
  })
})

describe('verification section', () => {
  it('turns a pasted link into the right verification page', async () => {
    renderHome()
    await ready()
    fireEvent.change(screen.getByLabelText('Verification code or link'), { target: { value: 'https://passthrough.dev/v/k7m2-qx9p4a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByTestId('verify-page')).toBeInTheDocument()
  })
  it('explains a bad code instead of navigating', async () => {
    renderHome()
    await ready()
    fireEvent.change(screen.getByLabelText('Verification code or link'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/doesn't look like a Passthrough verification/)
    expect(screen.queryByTestId('verify-page')).toBeNull()
  })
  it('builds the embed snippets with the same function a customer\'s result page uses, and switches format', async () => {
    renderHome()
    await ready()
    expect(screen.getByLabelText('Example embed snippet').textContent).toMatch(/<a href="http:\/\/localhost[^"]*\/v\/K7M2QX9P4A"><img src=".*\/badge\.png"/)
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(screen.getByLabelText('Example embed snippet').textContent).toMatch(/^\[!\[Passthrough badge\]\(.*badge\.svg\)\]\(/)
    fireEvent.click(screen.getByRole('button', { name: 'Plain link' }))
    expect(screen.getByLabelText('Example embed snippet').textContent).toMatch(/\/v\/K7M2QX9P4A$/)
  })
})

describe('FAQ + structured data', () => {
  it('footnote anchors resolve to real FAQ entries', async () => {
    renderHome()
    await ready()
    expect(document.getElementById('faq-66')).toBeTruthy()
    expect(document.querySelector('a[href="#faq-66"]')).toBeTruthy()
  })
  it('FAQPage JSON-LD is valid and matches the visible questions exactly', async () => {
    renderHome()
    await ready()
    const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)
    expect(ld['@type']).toBe('FAQPage')
    const visible = [...document.querySelectorAll('#faq summary')].map(s => s.textContent.replace(/[＋−]/g, '').trim())
    expect(ld.mainEntity.map(q => q.name)).toEqual(visible)
  })
  it('never promises an interview anywhere on the page', async () => {
    renderHome()
    await ready()
    // the FAQ question itself is "Does Passthrough guarantee an interview?" — everything else must not say it does
    const text = document.body.textContent.replaceAll('Does Passthrough guarantee an interview?', '')   // (the question also appears in the JSON-LD)
    expect(text).not.toMatch(/guarantee(d|s)? (you )?(an )?interview/i)
    expect(document.querySelector('#faq-guarantee p').textContent).toMatch(/^No/)
    expect(text).toMatch(/Not a guarantee of any outcome/)
  })
})

describe('old bugs stay fixed', () => {
  it('no full-page-reload anchors to /?mode= (the three-ways cards that dropped a half-filled form)', async () => {
    renderHome()
    await ready()
    expect(document.querySelector('a[href*="mode="]')).toBeNull()
  })
  it('the unsubstantiated "75% of resumes are rejected" claim is gone from the page', async () => {
    renderHome()
    await ready()
    expect(document.body.textContent).not.toMatch(/75%/)
  })
})
