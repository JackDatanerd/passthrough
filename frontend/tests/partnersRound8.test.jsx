// @vitest-environment jsdom
// Section 4 round 8 (frontend): manual adjustments, notes/profile editing, terms status + notice, dashboard
// transparency (payout account, hold, terms prompt, adjustment rows), mixed-currency payout runs.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDetail from '../src/pages/admin/PartnerDetail'
import AdminPartners from '../src/pages/admin/AdminPartners'
import PartnerDashboard from '../src/pages/PartnerDashboard'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

beforeEach(() => { cleanup(); vi.clearAllMocks() })

// ── admin: partner detail ──────────────────────────────────────────────────────────────
const partner = {
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', commissionRate: 0.2, currency: 'USD',
  payoutMethod: null, payoutDetails: null, payoutDetailsSubmittedAt: null, payoutDetailsHoldHours: 48,
  pendingCommissionCents: 5000, heldCents: 0, readyToPayCents: 0, creditCents: 0, netConversions: 0,
  referralCodes: [], payouts: [], commissionLedger: [], olderUnpaidCents: 0, cyclesSummary: [],
  website: 'https://k.example', audience: 'Runners', internalNotes: null,
  termsVersion: null, termsAcceptedAt: null, termsCurrent: false, currentTermsVersion: '2026-10',
}
const mountDetail = over => {
  api.get.mockResolvedValue({ data: { data: { ...partner, ...over } } })
  return render(<MemoryRouter initialEntries={['/admin/partners/p1']}><Routes><Route path="/admin/partners/:id" element={<PartnerDetail />} /></Routes></MemoryRouter>)
}

describe('adjust balance', () => {
  it('posts a negative amount for a deduction, with the reason and the notify choice', async () => {
    api.post.mockResolvedValue({ data: { success: true, emailed: true } })
    mountDetail()
    fireEvent.click(await screen.findByRole('button', { name: /adjust balance/i }))
    const dialog = await screen.findByRole('dialog')
    // opens pre-filled to write the whole balance off (a deduction of the unpaid 50.00)
    expect(within(dialog).getByLabelText(/amount/i).value).toBe('50')
    fireEvent.change(within(dialog).getByLabelText(/amount/i), { target: { value: '12.34' } })
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'Self-referral via a second account' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /record adjustment/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/p1/adjustments',
      { amountCents: -1234, reason: 'Self-referral via a second account', notify: true }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })))
  })

  it('posts a positive amount for a bonus and honours "do not email"', async () => {
    api.post.mockResolvedValue({ data: { success: true, emailed: false } })
    mountDetail()
    fireEvent.click(await screen.findByRole('button', { name: /adjust balance/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^add \(bonus\)/i }))
    fireEvent.change(within(dialog).getByLabelText(/amount/i), { target: { value: '5' } })
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'Webinar bonus' } })
    fireEvent.click(within(dialog).getByLabelText(/email the partner/i))
    fireEvent.click(within(dialog).getByRole('button', { name: /record adjustment/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/p1/adjustments', { amountCents: 500, reason: 'Webinar bonus', notify: false }))
  })

  it('refuses a missing amount or reason without calling the server', async () => {
    mountDetail({ pendingCommissionCents: 0 })
    fireEvent.click(await screen.findByRole('button', { name: /adjust balance/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /record adjustment/i }))
    expect(await within(dialog).findByText(/amount greater than zero/i)).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText(/amount/i), { target: { value: '3' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /record adjustment/i }))
    expect(await within(dialog).findByText(/say why/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('is not offered for a partner whose data was removed', async () => {
    mountDetail({ name: 'Removed partner', email: 'partner-p1@removed.invalid' })
    await screen.findByRole('button', { name: /resend payout-details link/i })
    expect(screen.queryByRole('button', { name: /adjust balance/i })).toBeNull()
  })

  it('shows adjustments in the ledger with their reason, labelled as an adjustment not a code', async () => {
    mountDetail({ commissionLedger: [{ id: 'l1', kind: 'ADJUSTMENT', adjustmentReason: 'Clawback: fraud', commissionAmountCents: -700, grossAmountCents: 0, commissionRate: 0, createdAt: '2026-10-01T00:00:00Z', payoutId: null, currency: 'USD' }] })
    fireEvent.click(await screen.findByRole('button', { name: /conversions/i }))
    expect(await screen.findByText('Clawback: fraud')).toBeTruthy()
    expect(screen.getByText('Adjustment')).toBeTruthy()
  })
})

describe('profile, notes and terms status', () => {
  it('Edit sends only the profile fields that changed (notes cleared with an empty string)', async () => {
    api.patch.mockResolvedValue({ data: { success: true } })
    mountDetail({ internalNotes: 'old note' })
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/website/i), { target: { value: 'https://new.example' } })
    fireEvent.change(within(dialog).getByLabelText(/internal notes/i), { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/partners/p1', { website: 'https://new.example', internalNotes: '' }))
  })

  it('shows internal notes and the terms state', async () => {
    mountDetail({ internalNotes: 'Met at the conference' })
    expect((await screen.findByTestId('internal-notes')).textContent).toMatch(/Met at the conference/)
    expect(screen.getByTestId('terms-status').textContent).toMatch(/has not accepted/i)
  })
  it('distinguishes an older accepted version and a current one', async () => {
    mountDetail({ termsVersion: '2026-01', termsCurrent: false })
    expect((await screen.findByTestId('terms-status')).textContent).toMatch(/older version.*2026-01.*2026-10/i)
    cleanup()
    mountDetail({ termsVersion: '2026-10', termsCurrent: true, termsAcceptedAt: '2026-10-05T00:00:00Z' })
    expect((await screen.findByTestId('terms-status')).textContent).toMatch(/accepted the current/i)
  })
})

// ── admin: partners list ───────────────────────────────────────────────────────────────
const row = (id, over = {}) => ({ id, name: `P${id}`, email: `${id}@x.co`, status: 'ACTIVE', commissionRate: 0.2, currency: 'USD',
  payoutMethod: 'BANK', payoutDetails: { bankName: 'B', accountName: 'N', accountNumber: '1234567890' }, payoutDetailsSubmittedAt: '2020-01-01T00:00:00Z',
  pendingCommissionCents: 1000, readyToPayCents: 1000, creditCents: 0, currentCycleAccruedCents: 0, termsCurrent: true, ...over })
function mountList(partners) {
  api.get.mockImplementation(url => Promise.resolve(
    url === '/partners' ? { data: { data: partners, payoutDetailsHoldHours: 48, currentTermsVersion: '2026-10' } } : { data: { data: [], total: 0 } }))
  return render(<MemoryRouter><AdminPartners /></MemoryRouter>)
}

describe('partners list', () => {
  it('leaves a mixed-currency partner out of the payout run and says so', async () => {
    mountList([row('a'), row('b', { mixedCurrency: true })])
    expect((await screen.findByTestId('mixed-currency-list')).textContent).toMatch(/1 partner has unpaid commission in more than one currency/)
    fireEvent.click(screen.getByRole('button', { name: /record payout run/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Pa')).toBeTruthy()
    expect(within(dialog).queryByText('Pb')).toBeNull()
  })

  it('offers the terms notice only when someone is outstanding, confirms, then posts and reports', async () => {
    mountList([row('a', { termsCurrent: false }), row('b')])
    api.post.mockResolvedValue({ data: { success: true, sent: 1, failed: 0, remaining: 0 } })
    fireEvent.click(await screen.findByRole('button', { name: /send terms notice \(1\)/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^send notice$/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/terms-notice'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/sent to 1 partner/i) })))
  })
  it('has no terms-notice button when everyone is current', async () => {
    mountList([row('a'), row('b')])
    await screen.findByText('Pa')
    expect(screen.queryByRole('button', { name: /send terms notice/i })).toBeNull()
  })
})

// ── partner dashboard ──────────────────────────────────────────────────────────────────
const dashBase = {
  name: 'Coach K', active: true, commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, payoutMethod: 'BANK', scope: 'dashboard',
  stats: { totalClicks: 5, totalConversions: 1, pendingCents: 600, paidCents: 0 }, referralCodes: [], payouts: [], cyclesSummary: [],
  olderUnpaidCents: 0, carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0, readyToPayCents: 0, creditCents: 0,
  conversions: [], conversionsTotal: 0,
}
function mountDash(over = {}) {
  api.get.mockImplementation(url => (url.startsWith('/partners/dashboard') ? Promise.resolve({ data: { data: { ...dashBase, ...over } } }) : Promise.reject(new Error('x'))))
  return render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
}

describe('partner dashboard', () => {
  it('shows the payout account (last four) and a recent-change hold', async () => {
    mountDash({ payoutAccount: { method: 'BANK', provider: 'Acme Bank', last4: '6789' }, payoutHoldUntil: new Date(Date.now() + 3600000).toISOString() })
    expect((await screen.findByTestId('payout-account')).textContent).toMatch(/Bank transfer · Acme Bank · ending 6789/)
    expect(screen.getByTestId('payout-hold').textContent).toMatch(/on hold until/i)
  })
  it('shows neither when the server sends nothing (older payload) or the hold is over', async () => {
    mountDash({ payoutHoldUntil: null })
    await screen.findByRole('heading', { name: 'Conversions' })
    expect(screen.queryByTestId('payout-account')).toBeNull()
    expect(screen.queryByTestId('payout-hold')).toBeNull()
    expect(screen.queryByTestId('terms-prompt')).toBeNull()
  })
  it('prompts for the terms, posts the acceptance with the partner token, and goes away', async () => {
    api.post.mockResolvedValue({ data: { success: true } })
    mountDash({ termsAcceptanceRequired: true, currentTermsVersion: '2026-10' })
    fireEvent.click(await screen.findByRole('button', { name: /i accept the current terms/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/accept-terms', {}, { headers: { 'X-Partner-Token': 'TOK' } }))
    await waitFor(() => expect(screen.queryByTestId('terms-prompt')).toBeNull())
  })
  it('keeps the prompt and says so when the save fails', async () => {
    api.post.mockRejectedValue(new Error('boom'))
    mountDash({ termsAcceptanceRequired: true })
    fireEvent.click(await screen.findByRole('button', { name: /i accept the current terms/i }))
    expect(await screen.findByText(/couldn't save that/i)).toBeTruthy()
    expect(screen.getByTestId('terms-prompt')).toBeTruthy()
  })
  it('renders an adjustment with its reason and no sale line', async () => {
    mountDash({ conversions: [{ id: 'a1', code: null, grossAmountCents: 0, commissionRate: 0, commissionAmountCents: -700, paid: false, isReversal: false, isAdjustment: true, adjustmentReason: 'Clawback: fraud', createdAt: '2026-10-01T00:00:00Z' }], conversionsTotal: 1 })
    expect(await screen.findByText('Clawback: fraud')).toBeTruthy()
    expect(screen.getByText('Balance adjustment')).toBeTruthy()
    expect(screen.getByText('Clawback: fraud').closest('li').textContent).not.toMatch(/\$\d.* sale/)   // no "$x sale · y% rate" line
  })
})
