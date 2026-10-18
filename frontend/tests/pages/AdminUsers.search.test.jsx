// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminUsers from '../../src/pages/admin/AdminUsers'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Round 16 (G1): typing in the Users search used to send one request per character. The app-wide limiter allows 100 requests
// per 15 minutes (it covers /admin/*), so a handful of searches could lock the admin out of every call.
const user = n => ({ id: `u${n}`, name: `User ${n}`, email: `u${n}@x.co`, role: 'SEEKER', status: 'ACTIVE', emailVerified: true, scansToday: 0, createdAt: '2026-09-01T00:00:00Z' })
const searchCalls = () => api.get.mock.calls.map(c => c[1].params.search)

describe('AdminUsers — search is debounced', () => {
  beforeEach(() => {
    api.get.mockReset()
    api.get.mockImplementation(async () => ({ data: { data: [user(1)], meta: { total: 1 } } }))
  })

  it('typing a whole address sends one search request, not one per character', async () => {
    const u = userEvent.setup()
    render(<ToastProvider><AdminUsers /></ToastProvider>)
    await screen.findByText('User 1')
    expect(api.get).toHaveBeenCalledTimes(1)               // the initial, unfiltered load

    await u.type(screen.getByLabelText('Search'), 'jane@x.co')
    expect(screen.getByLabelText('Search').value).toBe('jane@x.co')   // the box itself is never laggy
    expect(api.get).toHaveBeenCalledTimes(1)               // nothing sent mid-typing

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(searchCalls()).toEqual([undefined, 'jane@x.co'])
  })

  it('Enter searches immediately', async () => {
    const u = userEvent.setup()
    render(<ToastProvider><AdminUsers /></ToastProvider>)
    await screen.findByText('User 1')
    await u.type(screen.getByLabelText('Search'), 'bob{Enter}')
    await waitFor(() => expect(searchCalls()).toEqual([undefined, 'bob']), { timeout: 250 })   // well inside the 350 ms wait
  })

  it('a new search goes back to page 1 in the same request (not new text on the old page, then a second request)', async () => {
    api.get.mockImplementation(async (_u, { params }) => ({ data: { data: [user(params.page)], meta: { total: 60 } } }))
    const u = userEvent.setup()
    render(<ToastProvider><AdminUsers /></ToastProvider>)
    await screen.findByText('User 1')
    await u.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('User 2')
    api.get.mockClear()

    await u.type(screen.getByLabelText('Search'), 'zed{Enter}')
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 500))
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.get.mock.calls[0][1].params).toMatchObject({ page: 1, search: 'zed' })
  })
})
