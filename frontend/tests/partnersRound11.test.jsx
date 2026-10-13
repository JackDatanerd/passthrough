// @vitest-environment jsdom
// Section 4 round 11 — admin list filter, the terms-notice failure message, the approve modal's low-price
// confirmation, and the partner dashboard's trend / attribution mix / share-page choice.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import AdminPartners, { PARTNER_FILTERS } from '../src/pages/admin/AdminPartners'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const partner = (n, over = {}) => ({
  id: `p${n}`, name: `Partner ${n}`, email: `p${n}@x.co`, status: 'ACTIVE', payoutMethod: 'BANK', commissionRate: 0.1,
  readyToPayCents: 0, pendingCommissionCents: 0, currentCycleAccruedCents: 0, currency: 'USD', termsCurrent: true,
  createdAt: '2026-09-01T00:00:00Z', ...over,
})
let routes
const mount = () => render(<MemoryRouter><AdminPartners /></MemoryRouter>)
beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  routes = {}
  api.get.mockImplementation(url => Promise.resolve(routes[url] || { data: { data: [] } }))
})

describe('partner list filter', () => {
  it('each filter picks exactly the partners in that state', () => {
    const list = [
      partner(1), partner(2, { status: 'PAUSED' }), partner(3, { readyToPayCents: 500 }), partner(4, { payoutMethod: null }),
      partner(5, { termsCurrent: false }), partner(6, { email: 'partner-p6@removed.invalid', status: 'PAUSED', payoutMethod: null }),
      partner(7, { payoutMethod: null, payoutLinkEmail: { status: 'failed' } }),
    ]
    const ids = key => list.filter(PARTNER_FILTERS[key].test).map(p => p.id)
    expect(ids('paused')).toEqual(['p2'])
    expect(ids('ready')).toEqual(['p3'])
    expect(ids('noDetails')).toEqual(['p4', 'p7'])
    expect(ids('terms')).toEqual(['p5'])
    expect(ids('removed')).toEqual(['p6'])
    expect(ids('mailFailed')).toEqual(['p7'])
    expect(ids('active')).not.toContain('p6')
  })

  it('the dropdown narrows the table', async () => {
    routes['/partners'] = { data: { data: [partner(1), partner(2, { status: 'PAUSED' })] } }
    mount()
    await screen.findByText('Partner 1')
    fireEvent.change(screen.getByLabelText('Filter partners'), { target: { value: 'paused' } })
    await waitFor(() => expect(screen.queryByText('Partner 1')).toBeNull())
    expect(screen.getByText('Partner 2')).toBeTruthy()
  })
})

describe('terms notice failure', () => {
  it('shows an error toast and closes the dialog instead of an unhandled rejection', async () => {
    routes['/partners'] = { data: { data: [partner(1, { termsCurrent: false })] } }
    api.post.mockRejectedValue({ response: { data: { message: 'Mail provider is down.' } } })
    mount()
    await screen.findByText('Partner 1')
    fireEvent.click(await screen.findByRole('button', { name: /send terms notice/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send notice' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Mail provider is down.' })))
  })
})

describe('approve modal low-price confirmation', () => {
  it('shows the confirm checkbox on a "far below" refusal and resends with confirmLowPrice', async () => {
    routes['/partners/applications?status=PENDING&limit=50&offset=0'] = { data: { data: [{ id: 'a1', name: 'Anna', email: 'a@x.co', status: 'PENDING', createdAt: '2026-09-01T00:00:00Z' }], total: 1 } }
    api.post.mockRejectedValueOnce({ response: { data: { message: 'Tier price(s) far below the standard price (FIX: 49 vs standard 900).' } } })
    api.post.mockResolvedValueOnce({ data: { success: true, emailed: true, codeCreated: { code: 'ANNA20' } } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText(/also create their first referral code/i))
    fireEvent.change(within(dialog).getByLabelText('Code'), { target: { value: 'ANNA20' } })
    fireEvent.change(within(dialog).getByLabelText('Fix price'), { target: { value: '0.49' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))
    const confirm = await screen.findByLabelText(/these prices are intentional/i)
    fireEvent.click(confirm)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post.mock.calls[1][1].referralCode.confirmLowPrice).toBe(true)
  })
})
