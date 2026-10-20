// @vitest-environment jsdom
// The admin's simulated Hot categories on the REAL homepage: shown to the signed-in admin only, always bannered, and
// never able to reach a visitor, an ordinary user, or the page when the stored value is stale or has been tampered with.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import { AuthContext } from '../src/context/AuthContext'
import Home from '../src/pages/Home'
import { _resetHomeDataCache } from '../src/hooks/useHomeData'
import { setStoredReferralCode } from '../src/hooks/useReferralCapture'
import { readPreview, writePreview, clearPreview, PREVIEW_MAX_AGE_MS } from '../src/hooks/useAdminHotPreview'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), defaults: { baseURL: '/api' } }, getErrorMessage: (e, f) => f }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => <nav aria-label="Main" /> }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => <footer /> }))
vi.mock('../src/components/scan/ScanForm', () => ({ default: () => <div data-testid="scan-form-stub" /> }))

const KEY = 'pt:admin-hot-preview'
const SAMPLE_NOTE = 'Sample numbers shown until enough real reports come in.'
const tiers = { currency: 'USD', promoActive: false, badgeThreshold: 80, maxFixRetries: 2, freeScansPerDay: 3, anonScansPerHour: 1,
  tiers: [{ tier: 'BADGE', amount: 3900, originalAmount: 3900 }, { tier: 'FIX_PLAIN', amount: 3900, originalAmount: 3900 }, { tier: 'FIX', amount: 4900, originalAmount: 4900 }] }
// The REAL stats: no field has enough reports yet, so visitors get the sample table.
const realStats = { stats: { resumesScanned: 31234, responses: 0, interviewRatePct: null, minResponses: 50 }, hotCategories: { 7: [], 30: [], minReports: 10 }, stories: [] }

function renderHome(user) {
  return render(
    <AuthContext.Provider value={{ user }}>
      <MemoryRouter initialEntries={['/']}>
        <Routes><Route path="/" element={<Home />} /><Route path="/admin/hot-categories" element={<div data-testid="admin-page" />} /></Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  )
}
const ready = () => screen.findAllByText(/resumes scanned/)
const hotList = () => within(screen.getByRole('list', { name: 'Fields ranked by interviews reported' }))
const store = (over = {}) => localStorage.setItem(KEY, JSON.stringify({
  hotCategories: { 7: [{ category: 'legal', interviews: 77, changePct: 25 }, { category: 'finance', interviews: 31, changePct: -10 }], 30: [{ category: 'legal', interviews: 200, changePct: null }], minReports: 10 },
  threshold: 10, savedAt: Date.now(), ...over,
}))
const ADMIN = { id: 'a1', role: 'ADMIN', name: 'Mas' }, USER = { id: 'u1', role: 'USER', name: 'Pat' }

let clock = Date.now()
beforeEach(() => {
  clock += 10 * 60 * 1000
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock)
  api.get.mockReset(); localStorage.clear(); window.history.replaceState({}, '', '/')
  setStoredReferralCode(''); _resetHomeDataCache()
  api.get.mockImplementation(async (url) => {
    if (url.startsWith('/pricing')) return { data: { data: tiers } }
    if (url === '/stats') return { data: { data: realStats } }
    throw new Error('unexpected GET ' + url)
  })
})
afterEach(() => vi.useRealTimers())

describe('homepage — admin preview of the Hot categories simulation', () => {
  it('shows the simulated ranking to a signed-in admin, with a banner saying it is simulated', async () => {
    store()
    renderHome(ADMIN)
    await ready()
    expect(screen.getByTestId('admin-preview-banner')).toHaveTextContent(/simulated.*Only you see this.*visitors see the real data/)
    expect(screen.getByTestId('admin-preview-banner')).toHaveTextContent('threshold 10')
    expect(hotList().getByText('Legal')).toBeInTheDocument()
    expect(hotList().getByText('77')).toBeInTheDocument()
    expect(hotList().getByText('▲ 25%')).toBeInTheDocument()
    expect(hotList().getByText('▼ 10%')).toBeInTheDocument()
    expect(screen.queryByText(SAMPLE_NOTE)).toBeNull()              // it is "real" data as far as the section is concerned...
    expect(screen.getByTestId('admin-preview-banner')).toBeInTheDocument()   // ...and the banner is what says otherwise
  })
  it('a visitor who is not signed in never sees it, even with the value sitting in their storage', async () => {
    store()
    renderHome(null)
    await ready()
    expect(screen.queryByTestId('admin-preview-banner')).toBeNull()
    expect(screen.getByText(SAMPLE_NOTE)).toBeInTheDocument()
    expect(screen.queryByText('77')).toBeNull()
  })
  it('an ordinary signed-in user never sees it either', async () => {
    store()
    renderHome(USER)
    await ready()
    expect(screen.queryByTestId('admin-preview-banner')).toBeNull()
    expect(screen.getByText(SAMPLE_NOTE)).toBeInTheDocument()
  })
  it('a simulation with no field over the line falls back to the sample table, exactly as visitors would see', async () => {
    store({ hotCategories: { 7: [], 30: [], minReports: 25 }, threshold: 25 })
    renderHome(ADMIN)
    await ready()
    expect(screen.getByTestId('admin-preview-banner')).toHaveTextContent('threshold 25')
    expect(screen.getByText(SAMPLE_NOTE)).toBeInTheDocument()
  })
  it('the threshold in the simulation is what the section tells a visitor about unranked fields', async () => {
    store({ hotCategories: { 7: [{ category: 'legal', interviews: 80, changePct: null }], 30: [], minReports: 40 }, threshold: 40 })
    renderHome(ADMIN)
    await ready()
    fireEvent.change(screen.getByLabelText('Which one are you?'), { target: { value: 'sales' } })
    expect(screen.getByText(/doesn.t have 40\+ reports/)).toBeInTheDocument()
  })
  it('"End preview" removes it from the page and from storage', async () => {
    store()
    renderHome(ADMIN)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'End preview' }))
    expect(screen.queryByTestId('admin-preview-banner')).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(screen.getByText(SAMPLE_NOTE)).toBeInTheDocument()
  })
  it('follows the simulator when it changes while the homepage is open', async () => {
    renderHome(ADMIN)
    await ready()
    expect(screen.queryByTestId('admin-preview-banner')).toBeNull()
    act(() => { writePreview({ 7: [{ category: 'sales', interviews: 15, changePct: null }], 30: [], minReports: 10 }, 10) })
    expect(await screen.findByTestId('admin-preview-banner')).toBeInTheDocument()
    expect(hotList().getByText('Sales')).toBeInTheDocument()
    act(() => { clearPreview() })
    expect(screen.queryByTestId('admin-preview-banner')).toBeNull()
  })
  it('the banner links back to the simulator', async () => {
    store()
    renderHome(ADMIN)
    await ready()
    fireEvent.click(screen.getByRole('link', { name: 'Back to the simulator' }))
    expect(await screen.findByTestId('admin-page')).toBeInTheDocument()
  })
  it('the real numbers are untouched: nothing was written to the API', async () => {
    store()
    renderHome(ADMIN)
    await ready()
    expect(api.get.mock.calls.every(([u]) => u === '/stats' || u.startsWith('/pricing'))).toBe(true)
    expect(api.post).not.toHaveBeenCalled()
  })
})

describe('readPreview — what is read back from storage is distrusted', () => {
  const put = (v) => localStorage.setItem(KEY, typeof v === 'string' ? v : JSON.stringify(v))
  const good = () => ({ hotCategories: { 7: [{ category: 'legal', interviews: 5, changePct: null }], 30: [], minReports: 10 }, threshold: 10, savedAt: Date.now() })
  it('accepts a well-formed value', () => { put(good()); expect(readPreview()).toMatchObject({ threshold: 10, hotCategories: { minReports: 10 } }) })
  it('forgets a preview older than the limit, and one dated in the future', () => {
    put({ ...good(), savedAt: Date.now() - PREVIEW_MAX_AGE_MS - 1 }); expect(readPreview()).toBeNull()
    put({ ...good(), savedAt: Date.now() + 10 * 60 * 1000 }); expect(readPreview()).toBeNull()
    put({ ...good(), savedAt: Date.now() - PREVIEW_MAX_AGE_MS + 5000 }); expect(readPreview()).not.toBeNull()
  })
  it('ignores anything malformed, hand-edited or oversized instead of throwing', () => {
    const g = good()
    for (const bad of [
      'not json', '{}', 'null', '[]', '"x"',
      { ...g, hotCategories: null },
      { ...g, hotCategories: { 7: 'x', 30: [] } },
      { ...g, hotCategories: { 7: [{ category: 'legal', interviews: 'many' }], 30: [] } },
      { ...g, hotCategories: { 7: [{ category: 'legal', interviews: -1 }], 30: [] } },
      { ...g, hotCategories: { 7: [{ category: 'legal', interviews: 5, changePct: 'up' }], 30: [] } },
      { ...g, hotCategories: { 7: [{ category: '', interviews: 5 }], 30: [] } },
      { ...g, hotCategories: { 7: [{ category: 'x'.repeat(61), interviews: 5 }], 30: [] } },
      { ...g, hotCategories: { 7: Array.from({ length: 13 }, (_, i) => ({ category: `c${i}`, interviews: 5 })), 30: [] } },
      { ...g, savedAt: 'yesterday' },
    ]) { put(bad); expect(readPreview(), JSON.stringify(bad).slice(0, 70)).toBeNull() }
  })
  it('a blocked or throwing storage means "no preview", never an error', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readPreview()).toBeNull()
    spy.mockRestore()
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(writePreview({ 7: [], 30: [], minReports: 10 }, 10)).toBe(false)
    set.mockRestore()
  })
})
