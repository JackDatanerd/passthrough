// @vitest-environment jsdom
// Section 4 round 27: the admin detail view is masked with a step-up "show full details" reveal, an unpaid sale can be moved to another
// partner's code, and the partner dashboard shows what each code has earned.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDetail from '../src/pages/admin/PartnerDetail'
import PartnerDashboard from '../src/pages/PartnerDashboard'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => vi.fn() }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))

const sale = (id, over = {}) => ({ id, kind: 'SALE', paymentRef: `ref_${id}`, grossAmountCents: 2900, commissionRate: 0.2, commissionAmountCents: 580,
  currency: 'USD', payoutId: null, reversesLedgerId: null, createdAt: '2026-09-02T10:00:00Z', ...over })
const partner = (over = {}) => ({
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commissionRate: 0.2, currency: 'USD',
  payoutMethod: 'BANK', payoutDetails: { bankName: 'Bank', accountName: 'K', accountNumber: '…7890' }, taxCountry: 'US', taxId: '…6789', detailsMasked: true,
  pendingCommissionCents: 0, heldCents: 0, readyToPayCents: 0, creditCents: 0, netConversions: 0,
  referralCodes: [], payouts: [], commissionLedger: [], cyclesSummary: [], olderUnpaidCents: 0, ...over,
})
const mount = () => render(<MemoryRouter initialEntries={['/admin/partners/p1']}><Routes><Route path="/admin/partners/:id" element={<PartnerDetail />} /></Routes></MemoryRouter>)

describe('masked payout details with a step-up reveal', () => {
  beforeEach(() => { cleanup(); vi.clearAllMocks() })
  it('shows only the masked values until the admin asks, then fetches the full ones from the reveal endpoint', async () => {
    api.get.mockImplementation(url => String(url) === '/partners/p1/payout-details'
      ? Promise.resolve({ data: { data: { payoutMethod: 'BANK', payoutDetails: { bankName: 'Bank', accountName: 'K', accountNumber: '1234567890' }, taxCountry: 'US', taxId: '123-45-6789', snapshots: {} } } })
      : Promise.resolve({ data: { data: partner() } }))
    mount()
    expect((await screen.findAllByText(/…7890/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/1234567890/)).toBeNull()
    expect(api.get).not.toHaveBeenCalledWith('/partners/p1/payout-details')
    fireEvent.click(screen.getAllByTestId('reveal-details')[0])
    expect((await screen.findAllByText(/1234567890/)).length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('partner-tax')[0].textContent).toContain('123-45-6789')
    expect(api.get).toHaveBeenCalledWith('/partners/p1/payout-details')
  })
  it('a failed reveal (step-up declined) shows why and leaves the values masked', async () => {
    api.get.mockImplementation(url => String(url) === '/partners/p1/payout-details'
      ? Promise.reject(Object.assign(new Error('Re-enter your password.'), { response: { data: { message: 'Re-enter your password.' } } }))
      : Promise.resolve({ data: { data: partner() } }))
    mount()
    fireEvent.click((await screen.findAllByTestId('reveal-details'))[0])
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/1234567890/)).toBeNull()
  })
  it('no reveal button when the response is not masked', async () => {
    api.get.mockResolvedValue({ data: { data: partner({ detailsMasked: false }) } })
    mount()
    await screen.findAllByText(/Coach K/)
    expect(screen.queryByTestId('reveal-details')).toBeNull()
  })
})

describe('moving a sale to another partner', () => {
  beforeEach(() => { cleanup(); vi.clearAllMocks() })
  async function openConversions(ledger) {
    api.get.mockResolvedValue({ data: { data: partner({ commissionLedger: ledger }) } })
    mount()
    fireEvent.click(await screen.findByRole('tab', { name: /conversions/i }))
  }
  it('offers Move only on an unpaid, un-reversed sale', async () => {
    await openConversions([sale('l1'), sale('l2', { payoutId: 'po1' }), sale('l3', { kind: 'ADJUSTMENT' })])
    expect(await screen.findAllByRole('button', { name: 'Reverse' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Move' })).toHaveLength(1)
  })
  it('posts the uppercased code and the reason, and refuses a missing code or reason', async () => {
    api.post.mockResolvedValue({ data: { success: true } })
    await openConversions([sale('l1')])
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: /move sale/i }))
    expect(await screen.findByText(/enter the code/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/code that should get the sale/i), { target: { value: 'ann20' } })
    fireEvent.click(screen.getByRole('button', { name: /move sale/i }))
    expect(await screen.findByText(/say why/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'typed the wrong code' } })
    fireEvent.click(screen.getByRole('button', { name: /move sale/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/p1/ledger/l1/reattribute', { toCode: 'ANN20', reason: 'typed the wrong code' }))
  })
  it('shows the server\'s refusal and keeps the dialog open', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('x'), { response: { data: { message: 'That code belongs to a partner who is not active.' } } }))
    await openConversions([sale('l1')])
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }))
    fireEvent.change(screen.getByLabelText(/code that should get the sale/i), { target: { value: 'ANN20' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'typed the wrong code' } })
    fireEvent.click(screen.getByRole('button', { name: /move sale/i }))
    expect(await screen.findByText(/not active/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /move sale/i })).toBeTruthy()
  })
})

describe('partner dashboard: earnings per code', () => {
  const code = (id, stats) => ({ id, code: id.toUpperCase(), active: true, clicks: 10, usesSoFar: 1, tierPrices: { FIX: 1900 }, signups: 2, stats })
  function mountDash(referralCodes) {
    api.get.mockImplementation(url => (url.startsWith('/partners/dashboard')
      ? Promise.resolve({ data: { data: { name: 'Coach K', active: true, status: 'ACTIVE', commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, payoutMethod: 'BANK', scope: 'dashboard',
        stats: { totalClicks: 5, totalConversions: 1, pendingCents: 0, paidCents: 0 }, referralCodes, payouts: [], cyclesSummary: [], olderUnpaidCents: 0, carriedForwardCents: 0, belowMinimum: false,
        minPayoutCents: 0, readyToPayCents: 0, creditCents: 0, conversions: [], conversionsTotal: 0 } } })
      : Promise.reject(new Error(`unexpected GET ${url}`))))
    return render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
  }
  beforeEach(() => { cleanup(); vi.clearAllMocks() })
  it('shows each code\'s own earnings, and nothing for a code that has not earned yet', async () => {
    mountDash([code('aaa', { conversions: 2, conversionRate: 0.2, commissionCents: 1160 }), code('bbb', { conversions: 0, conversionRate: 0, commissionCents: 0 })])
    const earned = await screen.findAllByTestId('code-earned')
    expect(earned).toHaveLength(1)
    expect(earned[0].textContent).toMatch(/earned \$11\.60/)
  })
})
