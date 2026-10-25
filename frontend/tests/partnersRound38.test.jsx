// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, renderHook, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'
import PartnerApply from '../src/pages/PartnerApply'
import { ReferralCodeEntry } from '../src/components/ui/ReferralCodeEntry'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../src/components/lead/TurnstileWidget', () => ({ default: () => null, TURNSTILE_ENABLED: false }))

// Partners round 38 (frontend): terms bound to the version shown, the yearly statement, requesting a code, conversion filters, the reason
// a checkout code does not apply, and a paused partner's link not wiping the visitor's stored code.

const base = {
  name: 'Coach K', commissionRate: 0.2, active: true, status: 'ACTIVE', currency: 'USD', hasPayoutDetails: true,
  referralCodes: [{ id: 'c1', code: 'ONE', active: true, tierPrices: {}, clicks: 0, usesSoFar: 0 }, { id: 'c2', code: 'TWO', active: true, tierPrices: {}, clicks: 0, usesSoFar: 0 }],
  conversions: [{ id: 'v1', createdAt: '2026-03-01T00:00:00Z', code: 'ONE', commissionAmountCents: 500, grossAmountCents: 2500, commissionRate: 0.2, paid: false }],
  conversionsTotal: 1, payouts: [], cyclesSummary: [], olderUnpaidCents: 0,
  stats: { totalClicks: 0, totalConversions: 0, pendingCents: 0, paidCents: 0 },
}
const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, sales: i === 2 ? 2 : 0, grossCents: 0, commissionCents: 0, reversalCents: 0, adjustmentCents: 0, netCents: i === 2 ? 1500 : 0 }))
const statement = { year: new Date().getUTCFullYear(), currency: 'USD', months, earnedCents: 1500, paidCents: 1000, payoutCount: 1, taxCountry: null, taxIdOnFile: false }

function routeGets(extra = {}) {
  api.get.mockImplementation(async url => {
    if (url.startsWith('/partners/dashboard')) return { data: { success: true, data: { ...base, ...extra } } }
    if (url.startsWith('/partners/statement')) return { data: { success: true, data: statement } }
    if (url.startsWith('/partners/conversions')) return { data: { success: true, total: 0, data: [] } }
    return { data: { success: true, data: {} } }
  })
}
const show = () => render(<MemoryRouter initialEntries={['/partner/dashboard?token=tok']}><PartnerDashboard /></MemoryRouter>)
beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('terms prompt', () => {
  it('sends the version on screen, and says to reload when the server reports the terms moved on', async () => {
    routeGets({ termsAcceptanceRequired: true, currentTermsVersion: '2026-10b' })
    api.post.mockRejectedValue({ response: { status: 409, data: { code: 'TERMS_VERSION_CHANGED' } } })
    show()
    fireEvent.click(await screen.findByRole('button', { name: /I accept the current terms/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][0]).toBe('/partners/accept-terms')
    expect(api.post.mock.calls[0][1]).toEqual({ version: '2026-10b' })
    expect(await screen.findByTestId('terms-changed')).toHaveTextContent(/updated while this page was open/i)
  })
})

describe('yearly statement', () => {
  it('shows what was earned and paid in the year and offers the CSV', async () => {
    routeGets()
    show()
    const box = await screen.findByTestId('annual-statement')
    await waitFor(() => expect(box).toHaveTextContent('$15.00'))
    expect(box).toHaveTextContent('$10.00')
    expect(screen.getByTestId('statement-csv')).toBeInTheDocument()
    expect(api.get.mock.calls.some(c => c[0].startsWith(`/partners/statement?year=${statement.year}`))).toBe(true)
  })
  it('a response that is not a statement shows an error rather than a broken table', async () => {
    api.get.mockImplementation(async url => url.startsWith('/partners/statement')
      ? { data: { success: true, data: { somethingElse: true } } } : { data: { success: true, data: base } })
    show()
    expect(await screen.findByText(/Could not load the statement/i)).toBeInTheDocument()
  })
})

describe('request a code of your own', () => {
  it('posts the wanted code and note, then confirms', async () => {
    routeGets()
    api.post.mockResolvedValue({ data: { success: true, message: 'Thanks - we have your request.' } })
    show()
    fireEvent.click(await screen.findByTestId('code-request-open'))
    const [codeBox] = screen.getAllByRole('textbox')
    fireEvent.change(screen.getByLabelText(/Code you'd like/i), { target: { value: 'mynews' } })
    fireEvent.click(screen.getByRole('button', { name: /send request/i }))
    expect(await screen.findByTestId('code-request-sent')).toBeInTheDocument()
    expect(api.post.mock.calls[0][0]).toBe('/partners/request-code')
    expect(api.post.mock.calls[0][1]).toMatchObject({ code: 'MYNEWS' })
    expect(codeBox).toBeDefined()
  })
  it('is not offered to a partner whose account is not active', async () => {
    routeGets({ active: false, status: 'PAUSED' })
    show()
    await screen.findByText(/Coach K's Passthrough dashboard/)
    expect(screen.queryByTestId('code-request-open')).toBeNull()
  })
})

describe('conversion filters', () => {
  it('filtering by code asks the server for that code and shows what it returns', async () => {
    routeGets()
    api.get.mockImplementation(async url => {
      if (url.startsWith('/partners/dashboard')) return { data: { success: true, data: base } }
      if (url.startsWith('/partners/statement')) return { data: { success: true, data: statement } }
      if (url.includes('codeId=c2')) return { data: { success: true, total: 1, data: [{ id: 'v9', createdAt: '2026-04-02T00:00:00Z', code: 'TWO', commissionAmountCents: 700, grossAmountCents: 3500, commissionRate: 0.2, paid: false }] } }
      return { data: { success: true, total: 0, data: [] } }
    })
    show()
    const filters = await screen.findByTestId('conversion-filters')
    fireEvent.change(filters.querySelector('select'), { target: { value: 'c2' } })
    await waitFor(() => expect(api.get.mock.calls.some(c => c[0].includes('codeId=c2'))).toBe(true))
    expect(await screen.findByText('$7.00')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /clear filter/i }))
    expect(await screen.findByText('$5.00')).toBeInTheDocument()
  })
})

describe('apply form', () => {
  it('sends the terms version it loaded with the application', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { termsVersion: '2026-10b' } } })
    api.post.mockResolvedValue({ data: { success: true } })
    render(<MemoryRouter><PartnerApply /></MemoryRouter>)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/partners/program'))
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@x.co' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /partner program terms/i }))
    fireEvent.click(screen.getByRole('button', { name: /submit application/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toMatchObject({ acceptTerms: true, termsVersion: '2026-10b' })
  })
})

describe('checkout code message', () => {
  const show2 = reason => render(<ReferralCodeEntry referralCode="OLD" pricing={{ referralApplied: false, selfReferral: false, referralReason: reason }} onApply={() => {}} disabled={false} />)
  it.each([['expired', /has expired/], ['exhausted', /used up/], ['paused', /isn't available right now/], ['inactive', /isn't active any more/]])('%s says so', (reason, re) => {
    show2(reason)
    expect(screen.getByText(re)).toBeInTheDocument()
  })
  it('unknown (or no reason) keeps the generic wording', () => {
    show2('unknown')
    expect(screen.getByText(/doesn't look right/)).toBeInTheDocument()
  })
})

describe('useReferralCapture — a paused partner’s link', () => {
  const KEY = 'passthrough_referral_code'
  const REAL = JSON.stringify({ code: 'COACH20', capturedAt: Date.now() - 5 * 24 * 3600 * 1000 })
  async function visit(entry) {
    vi.resetModules()
    const mod = await import('../src/hooks/useReferralCapture')
    renderHook(() => { mod.useReferralCapture() }, { wrapper: ({ children }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> })
    return mod
  }
  it('retry:true keeps the visitor’s code (a plain invalid still wipes it)', async () => {
    localStorage.clear()
    api.post.mockResolvedValue({ data: { success: true, valid: false, retry: true } })
    const mod = await visit('/?ref=PAUSEME')
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))
    expect(mod.getStoredReferralCode()).toBe('PAUSEME')
    localStorage.clear(); api.post.mockReset()
    localStorage.setItem(KEY, REAL)
    api.post.mockResolvedValue({ data: { success: true, valid: false } })
    const mod2 = await visit('/?ref=junk')
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe(REAL))
    expect(mod2.getStoredReferralCode()).toBe('COACH20')
  })
})
