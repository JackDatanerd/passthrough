// @vitest-environment jsdom
// Section 4 round 13 (bug B3): the payout-run CSV must leave out partners whose payout details changed inside the hold window.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import AdminPartners from '../src/pages/admin/AdminPartners'

const csv = { calls: [] }
vi.mock('../src/lib/utils', async orig => ({ ...(await orig()), downloadCsv: (...a) => csv.calls.push(a) }))
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
  // Round 23: the list is masked; the full details come from the step-up export endpoint.
  '/partners/payout-export': { data: { data: list.map(p => ({ id: p.id, name: p.name, email: p.email, payoutMethod: p.payoutMethod,
    payoutDetails: { bankName: 'B', accountName: p.name, accountNumber: '0012345678' }, payoutDetailsSubmittedAt: p.payoutDetailsSubmittedAt,
    readyToPayCents: p.readyToPayCents, currency: 'USD', taxCountry: null, taxId: null })) } },
  '/partners/applications?status=PENDING&limit=50&offset=0': { data: { data: [], reapplyCooldownDays: 30 } },
  '/partners/overview': { data: { data: { owedCents: 0, paidOutCents: 0, lifetimeCommissionCents: 0, pendingApplications: 0, activePartners: 1, partners: 1, currency: 'USD' } } },
  '/partners/codes': { data: { data: [], total: 0 } },
})
beforeEach(() => {
  cleanup(); vi.clearAllMocks(); csv.calls = []
  list = [mk('a1', 'Ann', 4500), mk('b2', 'Ben', 2500, { payoutDetailsSubmittedAt: hoursAgo(5) })]
  api.get.mockImplementation(url => Promise.resolve(routes()[url] || { data: { data: [] } }))
})

describe('Export payout run honours the payout-details hold', () => {
  it('leaves a recently-changed partner out of the sheet and says so', async () => {
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /export payout run/i }))
    await waitFor(() => expect(csv.calls).toHaveLength(1))
    const [, rows] = csv.calls[0]
    expect(rows[1][5]).toEqual({ __csvText: '0012345678' })   // the full number came from /partners/payout-export
    const names = rows.slice(1).map(r => r[0])
    expect(names).toEqual(['Ann'])
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Exported 1 payable partner.*1 left out.*48-hour hold/), type: 'warning' })))
  })

  it('exports everyone, with no warning, when nobody is inside the hold', async () => {
    list = [mk('a1', 'Ann', 4500), mk('b2', 'Ben', 2500)]
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /export payout run/i }))
    await waitFor(() => expect(csv.calls).toHaveLength(1))
    expect(csv.calls[0][1].slice(1).map(r => r[0])).toEqual(['Ann', 'Ben'])
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Exported 2 payable partner(s).', type: 'success' })))
  })
})
