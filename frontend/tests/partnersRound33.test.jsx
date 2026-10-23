// @vitest-environment jsdom
// Section 4 round 33 (frontend): the legacy dashboard-link converter has a button, shows how many are left, and skips ids that failed.
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

const partner = (n, over = {}) => ({
  id: `p${n}`, name: `Partner ${n}`, email: `p${n}@x.co`, status: 'ACTIVE', payoutMethod: 'BANK', commissionRate: 0.1,
  readyToPayCents: 0, pendingCommissionCents: 0, currentCycleAccruedCents: 0, currency: 'USD', termsCurrent: true,
  createdAt: '2026-09-01T00:00:00Z', ...over,
})
let routes
beforeEach(() => {
  cleanup(); vi.clearAllMocks(); routes = {}
  api.get.mockImplementation(url => Promise.resolve(routes[url] || { data: { data: [] } }))
})

describe('convert legacy dashboard links', () => {
  it('is offered only while someone is still on a stored link', async () => {
    routes['/partners'] = { data: { data: [partner(1)] } }
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    await screen.findByText('Partner 1')
    expect(screen.queryByRole('button', { name: /convert legacy links/i })).toBeNull()
  })
  it('confirms, posts, reports what is left, and sends the failed ids as skipIds on the next run', async () => {
    routes['/partners'] = { data: { data: [partner(1, { legacyDashboardLink: true }), partner(2, { legacyDashboardLink: true })] } }
    api.post.mockResolvedValueOnce({ data: { success: true, converted: 1, failed: 1, failedIds: ['p2'], remaining: 1 } })
    api.post.mockResolvedValueOnce({ data: { success: true, converted: 0, failed: 0, failedIds: [], remaining: 0 } })
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    await screen.findByText('Partner 1')
    for (let run = 0; run < 2; run += 1) {
      fireEvent.click(await screen.findByRole('button', { name: /convert legacy links \(2\)/i }))
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Convert and email' }))
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(run + 1))
    }
    expect(api.post.mock.calls[0]).toEqual(['/partners/dashboard-links/convert', { skipIds: [] }])
    expect(api.post.mock.calls[1]).toEqual(['/partners/dashboard-links/convert', { skipIds: ['p2'] }])
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('1 still to go') }))
  })
})
