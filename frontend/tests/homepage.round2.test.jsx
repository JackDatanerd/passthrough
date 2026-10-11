// @vitest-environment jsdom
// Homepage round 2: the receipt section, the score picker, the field picker, the hero layout, the pull-quotes
// and the navbar entries.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import { AuthContext } from '../src/context/AuthContext'
import Home from '../src/pages/Home'
import Navbar from '../src/components/layout/Navbar'
import VerifySection from '../src/components/home/VerifySection'
import PricingSection from '../src/components/home/PricingSection'
import { _resetHomeDataCache } from '../src/hooks/useHomeData'
import { setStoredReferralCode } from '../src/hooks/useReferralCapture'
import { sha256Text } from '../src/lib/sha256'
import { TAMPER_DEMO, PULL_QUOTES, SAMPLE_STORIES } from '../src/lib/homeContent'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), defaults: { baseURL: '/api' } }, getErrorMessage: (e, f) => f }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => <footer /> }))
vi.mock('../src/components/scan/ScanForm', () => ({ default: () => <div data-testid="scan-form-stub" /> }))

const liveTiers = [{ tier: 'BADGE', amount: 3900, originalAmount: 3900 }, { tier: 'FIX_PLAIN', amount: 3900, originalAmount: 3900 }, { tier: 'FIX', amount: 4900, originalAmount: 4900 }]
const pricingPayload = (o = {}) => ({ currency: 'USD', promoActive: false, badgeThreshold: 80, maxFixRetries: 2, freeScansPerDay: 3, anonScansPerHour: 1, tiers: liveTiers, ...o })
const liveStats = () => ({
  stats: { resumesScanned: 31234, responses: 212, interviewRatePct: 71, since: '2026-08-01T00:00:00Z', minResponses: 50 },
  hotCategories: { 7: [{ category: 'legal', interviews: 14, changePct: 40 }, { category: 'finance', interviews: 11, changePct: null }], 30: [], minReports: 10 },
  stories: [{ id: 'x1', displayName: 'Real R.', roleCategory: 'sales', scoreBefore: 44, scoreAfter: 90, interviewCount: 2, interviewAfterDays: 4, quote: 'It actually worked for me.', story: 'First paragraph.', credentialCode: null }],
})

let pricingData, statsData, clock = Date.now()
beforeEach(() => {
  clock += 10 * 60 * 1000
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock)
  api.get.mockReset(); localStorage.clear(); window.history.replaceState({}, '', '/')
  setStoredReferralCode(''); _resetHomeDataCache()
  pricingData = pricingPayload(); statsData = liveStats()
  api.get.mockImplementation(async (url) => {
    if (url.startsWith('/pricing')) { if (pricingData instanceof Error) throw pricingData; return { data: { data: pricingData } } }
    if (url === '/stats') { if (statsData instanceof Error) throw statsData; return { data: { data: statsData } } }
    throw new Error('unexpected GET ' + url)
  })
})
afterEach(() => vi.useRealTimers())

const renderHome = () => render(<AuthContext.Provider value={{ user: null, logout() {} }}><MemoryRouter><Routes><Route path="/" element={<Home />} /></Routes></MemoryRouter></AuthContext.Provider>)
const ready = () => screen.findAllByText(/resumes scanned/)

describe('hero layout (the screenshot bug: copy floating mid-page beside a tall scan card)', () => {
  it('the copy column is top-aligned with the scan card, not vertically centred', async () => {
    renderHome(); await ready()
    const grid = screen.getByRole('heading', { level: 1 }).closest('div[class*="grid"]')
    expect(grid.className).toMatch(/items-start/)
    expect(grid.className).not.toMatch(/items-center/)
  })
  it('has a key-facts row that quotes the live Verified threshold, and does NOT repeat the 66% a third time', async () => {
    pricingData = pricingPayload({ badgeThreshold: 85 })
    renderHome()
    await screen.findByText('earns the Verified link')
    const facts = screen.getByText('earns the Verified link').closest('dl')
    await waitFor(() => expect(within(facts).getByText('85+')).toBeInTheDocument())
    expect(within(facts).getByText('Free')).toBeInTheDocument()
    expect(within(facts).getByText('~30s')).toBeInTheDocument()
    expect(facts.textContent).not.toMatch(/66%|71%/)
    expect(facts.textContent).not.toMatch(/always/i)
  })
})

describe('before / after', () => {
  it('shows what the robot read in each panel', async () => {
    renderHome(); await ready()
    expect(screen.getByText('What the robot read')).toBeInTheDocument()
    expect(screen.getByText('What the robot reads now')).toBeInTheDocument()
    expect(screen.getByText('✕ not found')).toBeInTheDocument()
    expect(screen.getByText('✓ 4 roles, in order')).toBeInTheDocument()
    expect(screen.getAllByText('stakeholder management')).toHaveLength(2)   // the keyword chips survived the rewrite
  })
})

describe('receipt: the tamper test', () => {
  const { original, edit } = TAMPER_DEMO
  const renderReceipt = (props = {}) => render(<MemoryRouter><VerifySection badgeThreshold={80} {...props} /></MemoryRouter>)
  const issuedFp = () => screen.getByLabelText('Issued fingerprint')
  const nowFp = () => screen.getByLabelText('Fingerprint of the text above')

  it('starts as an exact copy, with the issued fingerprint equal to the sample line\'s real SHA-256', () => {
    renderReceipt()
    expect(screen.getByLabelText('Resume line')).toHaveValue(original)
    expect(issuedFp().textContent).toBe(sha256Text(original).slice(0, 32).match(/.{8}/g).join(''))
    expect(screen.getByText('Exact copy')).toBeInTheDocument()
    expect(screen.getByText('✓ Exact copy')).toBeInTheDocument()
    expect(nowFp().querySelector('[data-diff]')).toBeNull()
  })
  it('one changed character flips the verdict, the ticket row and the fingerprint', () => {
    renderReceipt()
    fireEvent.click(screen.getByRole('button', { name: 'Change one character' }))
    expect(screen.getByLabelText('Resume line')).toHaveValue(original.replace(edit[0], edit[1]))
    expect(screen.getByText('Not an exact copy', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByText('⚠ Not an exact copy')).toBeInTheDocument()
    expect(nowFp().textContent).toBe(sha256Text(original.replace(edit[0], edit[1])).slice(0, 32).match(/.{8}/g).join(''))
    expect(nowFp().querySelectorAll('[data-diff]').length).toBeGreaterThan(0)
    expect(issuedFp().querySelector('[data-diff]')).toBeNull()   // the issued fingerprint is never the one that changes
  })
  it('is never alarmist: a mismatch says "ask for the original", not "forged"', () => {
    renderReceipt()
    fireEvent.click(screen.getByRole('button', { name: 'Change one character' }))
    expect(document.body.textContent).toMatch(/edited, re-saved or converted\. Ask the candidate for the original/)
    expect(document.body.textContent).toMatch(/A mismatch doesn.t prove tampering/)
    expect(document.body.textContent).not.toMatch(/forged|fraud|fake/i)
  })
  it('Reset, or typing the original back, restores the exact copy', () => {
    renderReceipt()
    fireEvent.click(screen.getByRole('button', { name: 'Change one character' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByText('Exact copy')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Resume line'), { target: { value: original + '!' } })
    expect(screen.getByText('Not an exact copy', { selector: 'b' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Resume line'), { target: { value: original } })
    expect(screen.getByText('Exact copy')).toBeInTheDocument()
  })
  it('states the real check uploads nothing, and states the Verified threshold it was given', () => {
    renderReceipt({ badgeThreshold: 85 })
    expect(document.body.textContent).toMatch(/nothing is uploaded/)
    expect(screen.getByText(/needs an ATS score of 85 or higher/)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/not an endorsement by any employer/i)
  })
})

describe('receipt: placement tabs', () => {
  const renderReceipt = () => render(<MemoryRouter><VerifySection badgeThreshold={80} /></MemoryRouter>)
  it('is a real, keyboard-operable tablist (roving tabindex, arrows wrap, Home/End)', () => {
    renderReceipt()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['Email signature', 'LinkedIn', 'Resume header', 'Application form'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1, -1])
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true'); expect(tabs[1]).toHaveFocus()
    fireEvent.keyDown(tabs[1], { key: 'End' })
    expect(tabs[3]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tabs[3], { key: 'ArrowRight' })
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')            // wraps
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
    expect(tabs[3]).toHaveAttribute('aria-selected', 'true')            // wraps back
    fireEvent.keyDown(tabs[3], { key: 'Home' })
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
  })
  it('exactly one panel is shown and it is labelled by its tab', () => {
    renderReceipt()
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: 'LinkedIn' }))
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('aria-labelledby', 'home-tab-linkedin')
    expect(within(panel).getByText('Profile · Featured')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Application form' }))
    expect(within(screen.getByRole('tabpanel')).getByLabelText(/Website or additional info/)).toHaveAttribute('readonly')
  })
  it('the email tab warns about the PNG badge (most clients cannot render SVG)', () => {
    renderReceipt()
    expect(screen.getByText(/Use the PNG badge here/)).toBeInTheDocument()
  })
})

describe('score picker', () => {
  const byTier = (t) => liveTiers.find(x => x.tier === t)
  const limits = (o = {}) => ({ badgeThreshold: 80, maxFixRetries: 2, freeScansPerDay: 3, anonScansPerHour: 1, ...o })
  const renderPricing = ({ pricing = pricingPayload(), lim = limits() } = {}) =>
    render(<MemoryRouter><PricingSection pricing={pricing} byTier={byTier} refresh={() => {}} clockOffsetMs={0} referralCode="" limits={lim} /></MemoryRouter>)
  const slide = (v) => fireEvent.change(screen.getByRole('slider', { name: 'Your ATS score' }), { target: { value: String(v) } })
  const plan = (id) => document.querySelector(`[data-plan="${id}"]`)

  it('at the default 72: Full fix fits, Credential only is locked and says why', () => {
    renderPricing()
    expect(plan('full')).toHaveAttribute('data-fit', 'true')
    expect(plan('badge')).not.toHaveAttribute('data-fit')
    expect(plan('badge')).toHaveAttribute('data-locked', 'true')
    expect(within(plan('badge')).getByText('Needs a score of 80+')).toHaveAttribute('aria-disabled', 'true')
    expect(within(plan('badge')).queryByRole('link')).toBeNull()
    expect(within(plan('badge')).getByText('Unlocks at a score of 80+')).toBeInTheDocument()
    expect(screen.getByText(/Below the pass line/)).toBeInTheDocument()
  })
  it('between the pass line and the threshold it counts the points, in the singular too', () => {
    renderPricing()
    slide(77); expect(screen.getByText(/3 points short of the credential/)).toBeInTheDocument()
    slide(79); expect(screen.getByText(/1 point short of the credential/)).toBeInTheDocument()
    expect(plan('badge')).toHaveAttribute('data-locked', 'true')
  })
  it('at the threshold Credential only unlocks, becomes the fit, and gets a working link', () => {
    renderPricing()
    slide(80)
    expect(plan('badge')).toHaveAttribute('data-fit', 'true')
    expect(plan('badge')).not.toHaveAttribute('data-locked')
    expect(within(plan('badge')).getByRole('link', { name: 'Get credential' })).toHaveAttribute('href', '/pricing')
    expect(plan('full')).not.toHaveAttribute('data-fit')
    expect(screen.getByText(/already credential-eligible/)).toBeInTheDocument()
  })
  it('uses the SERVER\'s threshold, not a hardcoded 80', () => {
    renderPricing({ lim: limits({ badgeThreshold: 85 }), pricing: pricingPayload({ badgeThreshold: 85 }) })
    slide(82)
    expect(plan('badge')).toHaveAttribute('data-locked', 'true')
    expect(screen.getByText(/3 points short of the credential/)).toBeInTheDocument()
    expect(screen.getByText('Below 75: fails')).toBeInTheDocument()
    expect(screen.getByText('85+: credential')).toBeInTheDocument()
    slide(85); expect(plan('badge')).not.toHaveAttribute('data-locked')
  })
  it('sliding never changes a price', () => {
    renderPricing()
    const before = plan('full').textContent.match(/\$\d+/g)
    slide(95); slide(10)
    expect(plan('full').textContent.match(/\$\d+/g)).toEqual(before)
  })
  it('the duplicate-charge refund line appears only when the server says that refund is on', () => {
    const { unmount } = renderPricing({ pricing: pricingPayload({ autoRefundDuplicates: false }) })
    expect(screen.queryByText(/Charged twice/)).toBeNull()
    unmount()
    renderPricing({ pricing: pricingPayload({ autoRefundDuplicates: true }) })
    expect(screen.getByText(/Charged twice\? The extra payment is refunded automatically/)).toBeInTheDocument()
  })
})

describe('hot categories: field picker and flames', () => {
  const pick = (v) => fireEvent.change(screen.getByLabelText('Which one are you?'), { target: { value: v } })
  const section = () => document.getElementById('hot')

  it('tells you where your field ranks and highlights its row', async () => {
    renderHome(); await ready()
    await waitFor(() => expect(within(section()).getByRole('list', { name: /Fields ranked/ })).toBeInTheDocument())
    pick('legal')
    expect(within(section()).getByText(/#1 this week with 14 reported interviews/)).toBeInTheDocument()
    expect(section().querySelector('li[data-mine="true"]').textContent).toMatch(/Legal/)
  })
  it('a field that is missing is "not ranked yet", never "last"', async () => {
    renderHome(); await ready()
    await waitFor(() => within(section()).getByRole('list', { name: /Fields ranked/ }))
    pick('design')
    expect(within(section()).getByText(/doesn.t have 10\+ reports this week yet, so it isn.t ranked/)).toBeInTheDocument()
    expect(section().querySelector('li[data-mine]')).toBeNull()
  })
  it('"Something else" is honest that the scan works for any posting', async () => {
    renderHome(); await ready()
    await waitFor(() => within(section()).getByRole('list', { name: /Fields ranked/ }))
    pick('__else')
    expect(within(section()).getByText(/The scan works for any posting/)).toBeInTheDocument()
  })
  it('choosing a field below the fold opens the full list so the highlighted row is visible', async () => {
    statsData = new Error('down'); renderHome(); await ready()
    await waitFor(() => within(section()).getByRole('list', { name: /Fields ranked/ }))
    expect(within(within(section()).getByRole('list', { name: /Fields ranked/ })).getAllByRole('listitem')).toHaveLength(6)
    pick('legal')                                                           // 12th in the sample ranking
    expect(within(within(section()).getByRole('list', { name: /Fields ranked/ })).getAllByRole('listitem')).toHaveLength(12)
    expect(section().querySelector('li[data-mine="true"]').textContent).toMatch(/Legal/)
  })
  it('only the top three get a flame', async () => {
    statsData = new Error('down'); renderHome(); await ready()
    const list = await waitFor(() => within(section()).getByRole('list', { name: /Fields ranked/ }))
    expect(list.querySelectorAll('svg')).toHaveLength(3)
  })
})

describe('stories and pull-quotes', () => {
  it('the third sample story is Dana R., with its "Verified link earned" tag and closing line', async () => {
    statsData = new Error('down'); renderHome(); await ready()
    const dana = screen.getByText('Dana R.').closest('article')
    expect(within(dana).getByText('Verified link earned')).toBeInTheDocument()
    expect(within(dana).getByText(/I didn.t have a resume\. I had a notes app\./)).toBeInTheDocument()
    expect(within(dana).getByText(/You don.t need a better history/)).toBeInTheDocument()
    expect(SAMPLE_STORIES.map(s => s.displayName)).toEqual(['Amara O.', 'Daniel M.', 'Dana R.'])
  })
  it('renders all six pull-quotes, labelled as placeholders while they are samples', async () => {
    renderHome(); await ready()
    const stories = document.getElementById('stories')
    expect(PULL_QUOTES).toHaveLength(6)
    expect(within(stories).getAllByRole('figure')).toHaveLength(6)
    expect(within(stories).getByText(/The short quotes above are illustrative placeholders/)).toBeInTheDocument()
  })
  it('live stories never carry a sample "closing line"', async () => {
    renderHome()
    await screen.findByText(/It actually worked for me/)
    expect(screen.queryByText(/The robot reads text, not taste/)).toBeNull()
  })
})

describe('guarantee wording matches the corrected Pricing page (no "until you pass" promise)', () => {
  it('the homepage no longer promises that we keep going until the resume passes', async () => {
    renderHome(); await ready()
    const text = document.body.textContent
    expect(text).not.toMatch(/until you pass|don.t stop|until it passes|or your next fix is free/i)
    expect(text).toMatch(/Included with every fix: free retries and a safety net/)
    expect(text).toMatch(/if those still don.t get you past the verification threshold, a free credit for your next resume/)
    expect(document.getElementById('faq-retry').textContent).toMatch(/if those still don.t get you past the verification threshold/)
  })
})

describe('faq', () => {
  it('has the two new questions, and the JSON-LD still mirrors the visible list', async () => {
    renderHome(); await ready()
    const visible = [...document.querySelectorAll('#faq summary')].map(s => s.textContent.replace(/[＋−]/g, '').trim())
    expect(visible).toEqual(expect.arrayContaining(["I don't have a resume. Can I still use this?", "Does it match how my target company's ATS works?"]))
    const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)
    expect(ld.mainEntity.map(q => q.name)).toEqual(visible)
    expect(document.getElementById('faq-ats').textContent).toMatch(/not a feed from those vendors/)
  })
})

describe('navbar entries', () => {
  const renderNav = (user = null) => render(<MemoryRouter><AuthContext.Provider value={{ user, logout() {} }}><Navbar /></AuthContext.Provider></MemoryRouter>)
  it('lists Stories, Hot categories, Pricing, For employers — in the order they appear on the page', () => {
    renderNav()
    const bar = screen.getAllByRole('navigation')[0]
    const links = within(bar).getAllByRole('link').map(a => [a.textContent, a.getAttribute('href')])
    const wanted = [['Stories', '/#stories'], ['Hot categories', '/#hot'], ['Pricing', '/pricing'], ['For employers', '/#employers']]
    expect(links.filter(l => wanted.some(w => w[0] === l[0]))).toEqual(wanted)
  })
  it('no longer has "Check a resume" in the bar or the mobile menu (it lives in the footer, the receipt and the employer section)', () => {
    renderNav()
    fireEvent.click(screen.getByRole('button', { name: /More/ }))
    expect(screen.queryByText('Check a resume')).toBeNull()
    const menu = document.getElementById('navbar-more')
    expect(within(menu).getAllByRole('link').map(a => a.textContent)).toEqual(['Stories', 'Hot categories', 'Pricing', 'For employers'])
  })
  it('the check link is still one click away from the employer section and the receipt', async () => {
    renderHome(); await ready()
    expect(within(document.getElementById('employers')).getByRole('link', { name: /Check a resume you were sent/ })).toHaveAttribute('href', '/check')
    expect(within(document.getElementById('receipt')).getByRole('link', { name: /check the file you were sent/ })).toHaveAttribute('href', '/check')
  })
})
