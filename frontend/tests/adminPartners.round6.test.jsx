// @vitest-environment jsdom
// Section 4 round 6 — "Record payout run": record a whole run at once, with the server's per-partner checks.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import AdminPartners from '../src/pages/admin/AdminPartners'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString()
const OLD = '2026-01-01T10:00:00.000Z'
const mk = (id, name, cents, over = {}) => ({
  id, name, email: `${id}@x.co`, status: 'ACTIVE', commissionRate: 0.2, currency: 'USD', createdAt: OLD,
  readyToPayCents: cents, currentCycleAccruedCents: 0, currentCycleLabel: 'Oct 1–15', payoutMethod: 'BANK',
  payoutDetails: { bankName: 'B', accountName: name, accountNumber: '0012345678' }, payoutDetailsSubmittedAt: OLD, ...over,
})
let list
const routes = () => ({
  '/partners': { data: { payoutDetailsHoldHours: 48, data: list } },
  '/partners/applications?status=PENDING': { data: { data: [], reapplyCooldownDays: 30 } },
  '/partners/overview': { data: { data: { owedCents: 0, paidOutCents: 0, lifetimeCommissionCents: 0, pendingApplications: 0, activePartners: 1, partners: 1, currency: 'USD' } } },
  '/partners/codes': { data: { data: [], total: 0 } },
})
const mount = () => render(<MemoryRouter><AdminPartners /></MemoryRouter>)
const openRun = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /record payout run/i }))
  return screen.findByRole('dialog')
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  list = [mk('a1', 'Ann', 4500), mk('b2', 'Ben', 2500), mk('c3', 'Cy', 0), mk('d4', 'Dee', 900, { payoutMethod: null, payoutDetails: null })]
  api.get.mockImplementation(url => Promise.resolve(routes()[url] || { data: { data: [] } }))
})

describe('Record payout run', () => {
  it('is disabled when nobody is payable', async () => {
    list = [mk('c3', 'Cy', 0)]
    mount()
    expect(await screen.findByRole('button', { name: /record payout run/i })).toBeDisabled()
  })

  it('lists only partners with something ready AND somewhere to send it, all selected, with the total', async () => {
    mount()
    const dialog = await openRun()
    expect(within(dialog).getByText('Ann')).toBeTruthy()
    expect(within(dialog).getByText('Ben')).toBeTruthy()
    expect(within(dialog).queryByText('Cy')).toBeNull()
    expect(within(dialog).queryByText('Dee')).toBeNull()
    expect(within(dialog).getByTestId('run-total').textContent).toMatch(/2 partners.*\$70\.00/)
  })

  it('cannot be submitted until the admin states the money has been sent', async () => {
    mount()
    const dialog = await openRun()
    const go = within(dialog).getByRole('button', { name: /mark 2 paid & notify/i })
    expect(go).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /sent every selected payment/i }))
    expect(go).not.toBeDisabled()
  })

  it('sends exactly the listed amount and the details timestamp it saw, then shows a per-partner result', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { recorded: 1, failed: 1, results: [
      { partnerId: 'a1', ok: true, status: 200, emailed: true },
      { partnerId: 'b2', ok: false, status: 409, code: 'AMOUNT_DIFFERS', message: 'Amount differs from the commission being settled.' }] } } })
    mount()
    const dialog = await openRun()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /sent every selected payment/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /mark 2 paid & notify/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post.mock.calls[0][0]).toBe('/partners/payouts/batch')
    expect(api.post.mock.calls[0][1].items).toEqual([
      { partnerId: 'a1', amountCents: 4500, expectedDetailsSubmittedAt: OLD },
      { partnerId: 'b2', amountCents: 2500, expectedDetailsSubmittedAt: OLD },
    ])
    const results = await screen.findByTestId('run-results')
    expect(results.textContent).toMatch(/✓ Ann/)
    expect(results.textContent).toMatch(/✗ Ben — Amount differs/)
    expect(toast.mock.calls.at(-1)[0]).toMatchObject({ message: '1 of 2 payout(s) recorded.', type: 'warning' })
  })

  it('a partner whose details changed inside the hold starts UNSELECTED and needs a direct confirmation', async () => {
    list = [mk('a1', 'Ann', 4500), mk('b2', 'Ben', 2500, { payoutDetailsSubmittedAt: hoursAgo(3) })]
    api.post.mockResolvedValue({ data: { success: true, data: { recorded: 2, failed: 0, results: [{ partnerId: 'a1', ok: true }, { partnerId: 'b2', ok: true }] } } })
    mount()
    const dialog = await openRun()
    expect(within(dialog).getByText(/Held — details changed/)).toBeTruthy()
    expect(within(dialog).getByTestId('run-total').textContent).toMatch(/1 partner .*\$45\.00/)
    // select Ben: now he needs the confirmation before the run can go
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Ben' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /sent every selected payment/i }))
    expect(within(dialog).getByRole('button', { name: /mark 2 paid & notify/i })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /confirmed the change with Ben directly/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /mark 2 paid & notify/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const items = api.post.mock.calls[0][1].items
    expect(items.find(i => i.partnerId === 'b2')).toMatchObject({ confirmedWithPartner: true })
    expect(items.find(i => i.partnerId === 'a1')).not.toHaveProperty('confirmedWithPartner')
  })

  it('if the whole request fails it does NOT claim success, and says to check history before retrying', async () => {
    api.post.mockRejectedValue(new Error('network'))
    mount()
    const dialog = await openRun()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /sent every selected payment/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /mark 2 paid & notify/i }))
    const results = await screen.findByTestId('run-results')
    expect(results.textContent).toMatch(/✗ Ann — Request failed — check this partner's payout history/)
    expect(toast.mock.calls.at(-1)[0]).toMatchObject({ message: '0 of 2 payout(s) recorded.', type: 'warning' })
  })

  it('splits a run larger than the server cap into several requests', async () => {
    list = Array.from({ length: 30 }, (_, i) => mk(`id${i}`, `P${i}`, 100))
    api.post.mockImplementation((url, body) => Promise.resolve({ data: { success: true, data: { results: body.items.map(i => ({ partnerId: i.partnerId, ok: true })) } } }))
    mount()
    const dialog = await openRun()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /sent every selected payment/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /mark 30 paid & notify/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post.mock.calls.map(c => c[1].items.length)).toEqual([25, 5])
  })

  it('closing the results reloads the list', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { results: [{ partnerId: 'a1', ok: true }, { partnerId: 'b2', ok: true }] } } })
    mount()
    const dialog = await openRun()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /sent every selected payment/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /mark 2 paid & notify/i }))
    const results = await screen.findByTestId('run-results')
    const before = api.get.mock.calls.filter(c => c[0] === '/partners').length
    fireEvent.click(within(results).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(api.get.mock.calls.filter(c => c[0] === '/partners').length).toBe(before + 1))
  })
})
