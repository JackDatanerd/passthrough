// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import AdminPartners from '../src/pages/admin/AdminPartners'
import { ReverseSaleModal } from '../src/pages/admin/PartnerDetail'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

// Partners round 38 (admin): the payout run asks to confirm a partner who has not accepted the current terms (only when the server says it
// blocks them), and a sale's commission can be reduced for a partial refund.

const OLD = '2026-01-01T10:00:00.000Z'
const mk = (id, name, cents, over = {}) => ({
  id, name, email: `${id}@x.co`, status: 'ACTIVE', commissionRate: 0.2, currency: 'USD', createdAt: OLD, termsCurrent: true,
  readyToPayCents: cents, currentCycleAccruedCents: 0, currentCycleLabel: 'Oct 1–15', payoutMethod: 'BANK',
  payoutDetails: { bankName: 'B', accountName: name, accountNumber: '0012345678' }, payoutDetailsSubmittedAt: OLD, ...over,
})
let list, block
const routes = () => ({
  '/partners': { data: { payoutDetailsHoldHours: 48, termsBlockPayout: block, data: list } },
  '/partners/applications?status=PENDING&limit=50&offset=0': { data: { data: [], reapplyCooldownDays: 30 } },
  '/partners/overview': { data: { data: { owedCents: 0, paidOutCents: 0, lifetimeCommissionCents: 0, pendingApplications: 0, activePartners: 1, partners: 1, currency: 'USD' } } },
  '/partners/codes': { data: { data: [], total: 0 } },
})
const openRun = async () => {
  render(<MemoryRouter><AdminPartners /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /record payout run/i }))
  return screen.findByRole('dialog')
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  block = true
  list = [mk('a1', 'Ann', 4500), mk('b2', 'Ben', 2500, { termsCurrent: false })]
  api.get.mockImplementation(url => Promise.resolve(routes()[url] || { data: { data: [] } }))
  api.post.mockResolvedValue({ data: { success: true, data: { results: [{ partnerId: 'a1', ok: true }, { partnerId: 'b2', ok: true }] } } })
})

describe('payout run — partners who have not accepted the current terms', () => {
  it('needs a "pay anyway" tick for that partner, then sends confirmedTerms for them only', async () => {
    const dialog = await openRun()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /sent every selected payment/i }))
    const go = within(dialog).getByRole('button', { name: /mark 2 paid & notify/i })
    expect(go).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /pay ben anyway/i }))
    expect(go).not.toBeDisabled()
    fireEvent.click(go)
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    const items = api.post.mock.calls[0][1].items
    expect(items.find(i => i.partnerId === 'b2')).toMatchObject({ confirmedTerms: true })
    expect(items.find(i => i.partnerId === 'a1').confirmedTerms).toBeUndefined()
  })
  it('asks for nothing when the server is not enforcing it', async () => {
    block = false
    const dialog = await openRun()
    expect(within(dialog).queryByRole('checkbox', { name: /pay ben anyway/i })).toBeNull()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /sent every selected payment/i }))
    expect(within(dialog).getByRole('button', { name: /mark 2 paid & notify/i })).not.toBeDisabled()
  })
})

describe('ReverseSaleModal — partial refund', () => {
  const partner = { id: 'p1', name: 'Ann', currency: 'USD' }
  const sale = { id: 'l1', commissionAmountCents: 1000, grossAmountCents: 5000, currency: 'USD', paymentRef: 'ref1' }
  const mount = () => render(<ReverseSaleModal partner={partner} sale={sale} onClose={() => {}} onDone={() => {}} />)
  it('sends refundCents for the amount refunded, not a full reversal', async () => {
    api.post.mockResolvedValue({ data: { partial: true, commissionCents: -400, remainingCents: 600 } })
    mount()
    fireEvent.click(screen.getByTestId('reverse-partial'))
    fireEvent.change(screen.getByTestId('reverse-partial-amount'), { target: { value: '20.00' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'goodwill partial refund' } })
    fireEvent.click(screen.getByRole('button', { name: /reduce commission/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][0]).toBe('/partners/p1/ledger/l1/reverse')
    expect(api.post.mock.calls[0][1]).toEqual({ reason: 'goodwill partial refund', refundCents: 2000 })
    await waitFor(() => expect(toast.mock.calls.at(-1)[0].message).toMatch(/reduced by \$4\.00.*\$6\.00/))
  })
  it('refuses a refund larger than the sale before calling the server', async () => {
    mount()
    fireEvent.click(screen.getByTestId('reverse-partial'))
    fireEvent.change(screen.getByTestId('reverse-partial-amount'), { target: { value: '60' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'goodwill partial refund' } })
    fireEvent.click(screen.getByRole('button', { name: /reduce commission/i }))
    expect(await screen.findByText(/more than the sale/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('without the tick it is the full reversal, as before', async () => {
    api.post.mockResolvedValue({ data: { alreadyPaidOut: false } })
    mount()
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'buyer was a second account' } })
    fireEvent.click(screen.getByRole('button', { name: /reverse sale/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toEqual({ reason: 'buyer was a second account' })
  })
})
