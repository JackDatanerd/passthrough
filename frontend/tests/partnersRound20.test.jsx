// @vitest-environment jsdom
// Section 4 round 20 (frontend): held-until text, ENDED notices, UTC dates, tax fields on the payout page, reopening an application,
// the commission-ledger export, and the referral hook no longer resurrecting a removed code.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'
import PartnerPayoutDetails from '../src/pages/PartnerPayoutDetails'
import AdminPartners from '../src/pages/admin/AdminPartners'
import PartnersLookupPanel from '../src/pages/admin/AdminPartnersLookup'
import { formatDate, formatDateUtc } from '../src/lib/utils'

const h = vi.hoisted(() => ({ toast: null, csv: null }))
vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => h.toast }))
vi.mock('../src/lib/utils', async () => {
  const actual = await vi.importActual('../src/lib/utils')
  return { ...actual, downloadCsv: (...a) => h.csv(...a) }
})

beforeEach(() => { cleanup(); vi.clearAllMocks(); h.toast = vi.fn(); h.csv = vi.fn() })
afterEach(cleanup)

const code = { id: 'rc1', code: 'COACH', active: true, tierPrices: { FIX: 1900 }, usageLimit: null, usesSoFar: 0, clicks: 3, expiresAt: null, createdAt: '2026-09-01T00:00:00Z' }
const dash = (over = {}) => ({
  name: 'K', active: true, status: 'ACTIVE', commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, scope: 'dashboard',
  stats: { totalClicks: 3, totalConversions: 2, pendingCents: 400, paidCents: 0 }, referralCodes: [code], payouts: [],
  olderUnpaidCents: 0, carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0, readyToPayCents: 0, creditCents: 0, heldCents: 0, holdDays: 7,
  trend: [], attributionMix: { link: 2, typed: 0, account: 0, unknown: 0 }, subMix: [], conversions: [], conversionsTotal: 0,
  cyclesSummary: [], ...over,
})
const mountDash = data => {
  api.get.mockResolvedValue({ data: { data: data } })
  return render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
}
const cycle = (over = {}) => ({ key: '2026-10-a', label: 'Oct 1–15', start: '2026-10-01T00:00:00Z', end: '2026-10-15T23:59:59.999Z', grossCents: 5000, commissionCents: 1000,
  unpaidCents: 1000, paidCents: 0, heldCents: 0, heldDisputeCents: 0, heldUntil: null, outsideCreditCents: 0, ledgerCount: 1, payoutIds: [], ...over })

describe('dashboard: when does held money free up (gap 2)', () => {
  it('names the date an age hold ends', async () => {
    mountDash(dash({ heldCents: 1000, cyclesSummary: [cycle({ heldCents: 1000, heldUntil: '2026-10-22T10:00:00Z' })] }))
    expect(await screen.findByText(/held until Oct 22, 2026 \(refund window\)/)).toBeTruthy()
  })
  it('says a disputed payment is held until the dispute is resolved, with no invented date', async () => {
    mountDash(dash({ heldCents: 1000, cyclesSummary: [cycle({ heldCents: 1000, heldDisputeCents: 1000, heldUntil: null })] }))
    expect(await screen.findByText(/held until a payment dispute is resolved/)).toBeTruthy()
    expect(screen.queryByText(/refund window\)/)).toBeNull()
  })
})

describe('dashboard: ended membership (gap 6)', () => {
  it('shows an ended notice, not the paused one, and calls the code Ended', async () => {
    mountDash(dash({ active: false, status: 'ENDED' }))
    expect((await screen.findByTestId('account-ended')).textContent).toMatch(/membership has ended/)
    expect(screen.queryByTestId('account-paused')).toBeNull()
    expect(screen.getByText('Ended')).toBeTruthy()
  })
  it('a paused partner still sees the paused wording', async () => {
    mountDash(dash({ active: false, status: 'PAUSED' }))
    expect((await screen.findByTestId('account-paused')).textContent).toMatch(/currently paused/)
  })
})

describe('partner-facing dates are UTC like the cycles (bug 3)', () => {
  it('a sale at 22:00 UTC on the 15th is listed as the 15th, not the 16th, for a viewer east of UTC', async () => {
    const realTz = process.env.TZ
    process.env.TZ = 'Africa/Nairobi'
    try {
      expect(formatDate('2026-10-15T22:00:00Z')).toBe('Oct 16, 2026')      // the old rendering
      expect(formatDateUtc('2026-10-15T22:00:00Z')).toBe('Oct 15, 2026')
      expect(formatDateUtc('2026-10-01')).toBe('Oct 1, 2026')              // date-only values stay as they are
      expect(formatDateUtc(null)).toBe('—')
    } finally { process.env.TZ = realTz }
  })
  it('the conversions list uses it', async () => {
    const realTz = process.env.TZ
    process.env.TZ = 'Africa/Nairobi'
    try {
      mountDash(dash({ conversions: [{ id: 'c1', code: 'COACH', sub: null, grossAmountCents: 1000, commissionRate: 0.2, commissionAmountCents: 200, paid: false, isReversal: false, createdAt: '2026-10-15T22:00:00Z' }], conversionsTotal: 1 }))
      expect(await screen.findByText(/Oct 15, 2026/)).toBeTruthy()
      expect(screen.queryByText(/Oct 16, 2026/)).toBeNull()
    } finally { process.env.TZ = realTz }
  })
})

describe('payout page: tax details (gap 7)', () => {
  const saved = (over = {}) => ({ data: { data: { name: 'K', payoutMethod: 'BANK', payoutDetailsMasked: true, payoutDetailsSubmittedAt: '2026-10-01T00:00:00Z',
    payoutDetails: { bankName: 'Equity', accountName: 'K', accountNumber: '…6789' }, dashboardToken: 'd', taxCountry: 'KE', taxIdMasked: '…789B', ...over } } })
  const page = () => render(<MemoryRouter initialEntries={['/partner/payout-details?token=tok']}><PartnerPayoutDetails /></MemoryRouter>)
  const fillNumber = async () => {
    await userEvent.type(await screen.findByLabelText('Account number'), '0123456789')
    await userEvent.type(screen.getByLabelText('Re-enter account number'), '0123456789')
  }
  it('shows the saved country and only a masked tax id', async () => {
    api.get.mockResolvedValue(saved())
    page()
    expect((await screen.findByLabelText(/Country of tax residence/)).value).toBe('KE')
    expect(screen.getByLabelText('Tax ID').placeholder).toMatch(/…789B/)
    expect(screen.getByLabelText('Tax ID').value).toBe('')
  })
  it('sends nothing tax-related when the partner did not touch it', async () => {
    api.get.mockResolvedValue(saved()); api.post.mockResolvedValue({ data: { success: true } })
    page(); await fillNumber()
    await userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('taxCountry')
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('taxId')
  })
  it('sends a changed country (upper-cased) and a typed id', async () => {
    api.get.mockResolvedValue(saved()); api.post.mockResolvedValue({ data: { success: true } })
    page(); await fillNumber()
    fireEvent.change(screen.getByLabelText(/Country of tax residence/), { target: { value: 'ug' } })
    await userEvent.type(screen.getByLabelText('Tax ID'), 'T-998877')
    await userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toMatchObject({ taxCountry: 'UG', taxId: 'T-998877' })
  })
  it('refuses a one-letter country before posting', async () => {
    api.get.mockResolvedValue(saved({ taxCountry: '' }))
    page(); await fillNumber()
    fireEvent.change(screen.getByLabelText(/Country of tax residence/), { target: { value: 'K' } })
    await userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
    expect(await screen.findByText(/2-letter country code/)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
  })
})

describe('admin: reopen a rejected application (gap 5)', () => {
  it('a rejected row has Reopen, which posts and refreshes the list', async () => {
    const rejected = { id: 'a9', name: 'Zed', email: 'z@x.co', status: 'REJECTED', createdAt: '2026-09-01T00:00:00Z', reviewedAt: '2026-09-02T00:00:00Z' }
    api.get.mockImplementation(url => Promise.resolve(
      url.startsWith('/partners/applications?status=REJECTED') ? { data: { data: [rejected], total: 1, reapplyCooldownDays: 30 } }
        : url.startsWith('/partners/applications') ? { data: { data: [], total: 0, reapplyCooldownDays: 30 } }
        : url === '/partners/overview' ? { data: { data: { owedCents: 0, paidOutCents: 0, lifetimeCommissionCents: 0, pendingApplications: 0, activePartners: 0, partners: 0, currency: 'USD' } } }
        : { data: { data: [] } }))
    api.post.mockResolvedValue({ data: { success: true } })
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /application history/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^rejected$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reopen/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/applications/a9/reopen'))
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })))
  })
})

describe('admin: commission ledger export (gap 4)', () => {
  const entry = (i, over = {}) => ({ id: `l${i}`, createdAt: '2026-10-03T10:00:00Z', partnerName: 'Ann', partnerEmail: 'a@x.co', code: 'ANN10', type: 'SALE', paymentRef: `ref_${i}`,
    grossAmountCents: 3900, commissionRate: 0.2, commissionAmountCents: 780, currency: 'USD', paid: false, paidAt: null, reason: null, sub: null, ...over })
  const openTab = async () => {
    render(<MemoryRouter><PartnersLookupPanel /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /partner tools|find a code/i }))
    fireEvent.click(await screen.findByRole('button', { name: /commission ledger/i }))
  }
  it('walks every page into one CSV with a header row and the sale rows', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => entry(i))
    const page2 = [entry(200, { type: 'REVERSAL', reason: 'REFUND', commissionAmountCents: -780, paid: true, paidAt: '2026-10-16T00:00:00Z' })]
    api.get.mockImplementation((url, cfg) => Promise.resolve(url !== '/partners/ledger' ? { data: { data: [], total: 0 } } : { data: { data: cfg.params.offset === 0 ? page1 : page2, total: 201 } }))
    await openTab()
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
    await waitFor(() => expect(h.csv).toHaveBeenCalled())
    const rows = h.csv.mock.calls[0][1]
    expect(rows).toHaveLength(1 + 201)
    expect(rows[0][0]).toBe('Date (UTC)')
    expect(rows[201][4]).toBe('REVERSAL')
    expect(rows[201][10]).toBe('Paid')
    expect(api.get.mock.calls.filter(c => c[0] === '/partners/ledger').map(c => c[1].params.offset)).toEqual([0, 200])
  })
  it('passes the date range through', async () => {
    api.get.mockImplementation(url => Promise.resolve(url === '/partners/ledger' ? { data: { data: [entry(1)], total: 1 } } : { data: { data: [], total: 0 } }))
    await openTab()
    fireEvent.change(screen.getByLabelText('Ledger from'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('Ledger to'), { target: { value: '2026-10-31' } })
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
    await waitFor(() => expect(api.get.mock.calls.some(c => c[0] === '/partners/ledger')).toBe(true))
    expect(api.get.mock.calls.find(c => c[0] === '/partners/ledger')[1].params).toMatchObject({ from: '2026-10-01', to: '2026-10-31' })
  })
})
