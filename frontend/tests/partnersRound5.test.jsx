// @vitest-environment jsdom
// Section 4 round 5 — frontend: header-borne partner token, void payout, credit-aware Pay amount,
// scoped link rotation, the per-sale email toggle, and attribution surviving blocked storage.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDetail from '../src/pages/admin/PartnerDetail'
import PartnerDashboard from '../src/pages/PartnerDashboard'
import { partnerAuth, PARTNER_TOKEN_HEADER } from '../src/lib/partnerApi'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const cycle = (over = {}) => ({ key: '2026-09-A', label: 'Sep 1–15', start: '2026-09-01T00:00:00.000Z', end: '2026-09-15T23:59:59.999Z',
  isCurrent: false, ledgerCount: 2, commissionCents: 1000, unpaidCents: 1000, heldCents: 0, paidCents: 0, outsideCreditCents: 0, ...over })
const partner = (over = {}) => ({
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commissionRate: 0.2, currency: 'USD',
  payoutMethod: 'BANK', payoutDetails: { bankName: 'B', accountName: 'K', accountNumber: '11112222' },
  payoutDetailsSubmittedAt: '2026-09-01T10:00:00.123456+00:00', pendingCommissionCents: 1000, heldCents: 0, readyToPayCents: 1000,
  creditCents: 0, netConversions: 3, referralCodes: [], commissionLedger: [], cyclesSummary: [cycle()], olderUnpaidCents: 0,
  payouts: [{ id: 'po1', amountCents: 5000, currency: 'USD', paidAt: '2026-09-20T00:00:00Z', status: 'PAID', voidedAt: null }], ...over,
})
const mount = () => render(<MemoryRouter initialEntries={['/admin/partners/p1']}>
  <Routes><Route path="/admin/partners/:id" element={<PartnerDetail />} /></Routes></MemoryRouter>)
const load = p => api.get.mockImplementation(() => Promise.resolve({ data: { data: p } }))

beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('partnerApi', () => {
  it('sends the token in a header, never in a URL', () => {
    expect(partnerAuth('abc')).toEqual({ headers: { [PARTNER_TOKEN_HEADER]: 'abc' } })
    expect(PARTNER_TOKEN_HEADER).toBe('X-Partner-Token')
  })
})

describe('admin partner page', () => {
  it('Pay on a cycle includes refund credit from OTHER cycles — the amount the server will settle', async () => {
    load(partner({ cyclesSummary: [cycle({ outsideCreditCents: -300 })] }))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /cycles & payouts/i }))
    expect(await screen.findByRole('button', { name: /^Pay \$7\.00$/ })).toBeTruthy()
    expect(screen.getByText(/refund credit/i)).toBeTruthy()
  })

  it('voids a payout: reason required, posts to the void endpoint, then reloads', async () => {
    load(partner())
    api.post.mockResolvedValue({ data: { success: true, message: 'Payout voided — its commission is owed again.' } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /cycles & payouts/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^Void$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'Wrong cycle' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /void payout/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/p1/payouts/po1/void', { reason: 'Wrong cycle', notifyPartner: true }))
    await waitFor(() => expect(api.get.mock.calls.filter(c => c[0] === '/partners/p1').length).toBeGreaterThanOrEqual(2))
  })

  it('a voided payout is shown struck through with its reason and has no Void button', async () => {
    load(partner({ payouts: [{ id: 'po1', amountCents: 5000, currency: 'USD', paidAt: '2026-09-20T00:00:00Z', voidedAt: '2026-09-21T00:00:00Z', voidReason: 'Wrong cycle' }] }))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /cycles & payouts/i }))
    expect(await screen.findByText(/Wrong cycle/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Void$/ })).toBeNull()
  })

  it('link rotation lets the admin pick the scope', async () => {
    load(partner())
    api.post.mockResolvedValue({ data: { success: true, emailed: true, dashboardUrl: 'https://x/d', payoutUrl: 'https://x/p' } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /regenerate link/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('regen-scope'), { target: { value: 'both' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Regenerate$/ }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/p1/regenerate-link', { scope: 'both' }))
  })
})

describe('partner dashboard', () => {
  const base = { name: 'Coach K', commissionRate: 0.2, active: true, currency: 'USD', hasPayoutDetails: true, scope: 'dashboard',
    referralCodes: [], conversions: [], conversionsTotal: 0, payouts: [], cyclesSummary: [], olderUnpaidCents: 0,
    stats: { totalClicks: 0, totalConversions: 0, pendingCents: 0, paidCents: 0 } }
  const show = data => {
    api.get.mockResolvedValue({ data: { success: true, data: { ...base, ...data } } })
    return render(<MemoryRouter initialEntries={['/partner/dashboard?token=tok']}><PartnerDashboard /></MemoryRouter>)
  }

  it('loads with the token in the header and not in the URL', async () => {
    show({})
    await screen.findByTestId('notification-prefs')
    expect(api.get).toHaveBeenCalledWith('/partners/dashboard', { headers: { 'X-Partner-Token': 'tok' } })
  })

  it('the per-sale email switch saves through the API', async () => {
    api.post.mockResolvedValue({ data: { success: true } })
    show({ notifyConversions: true })
    const sw = await screen.findByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/notifications', { conversions: false }, { headers: { 'X-Partner-Token': 'tok' } }))
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'))
  })
})

describe('referral attribution with blocked storage', () => {
  it('keeps the code in memory so it survives in-app navigation', async () => {
    vi.resetModules()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    const { setStoredReferralCode, getStoredReferralCode } = await import('../src/hooks/useReferralCapture')
    setStoredReferralCode('coach20')
    expect(getStoredReferralCode()).toBe('COACH20')
    setStoredReferralCode('')
    expect(getStoredReferralCode()).toBe('')
    vi.restoreAllMocks()
  })
})
