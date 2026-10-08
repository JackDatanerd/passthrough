// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import api from '../../src/lib/api'
import DashboardIndex from '../../src/pages/dashboard/Index'

const refreshUser = vi.fn()
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
let mockUser = { emailVerified: true, freeFixCredits: 0 }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser, refreshUser }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))

// Profile & Dashboard round 7.
const scan = (id, over = {}) => ({ id, status: 'ERROR', atsScore: null, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', jobTitle: `Job ${id}`, ...over })
function renderAt(path) {
  const router = createMemoryRouter([{ path: '/dashboard', element: <DashboardIndex /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}
const historyCalls = () => api.get.mock.calls.filter(c => c[0] === '/scan/history')
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.delete.mockReset(); refreshUser.mockReset(); mockUser = { emailVerified: true, freeFixCredits: 0 } })
afterEach(() => vi.useRealTimers())

describe('search box — a keystroke typed as the debounce commits is not lost', () => {
  it('keeps "ab" when "b" arrives before the router re-render of the committed "a"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.get.mockImplementation(async url => url === '/profile' ? { data: { data: { hasSavedProfile: false } } } : { data: { data: { scans: [scan('a')], total: 1 } } })
    const router = renderAt('/dashboard')
    const box = await screen.findByPlaceholderText(/Search by job/)
    await act(async () => { fireEvent.change(box, { target: { value: 'a' } }) })
    await act(async () => {
      vi.advanceTimersByTime(351)                         // the debounce commits "a"
      fireEvent.change(box, { target: { value: 'ab' } })  // ...and "b" is typed before that lands
    })
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(box.value).toBe('ab')
    expect(router.state.location.search).toBe('?search=ab')   // and "ab" itself is committed in turn
  })
  it('still follows the URL when it changes from outside the box (Back / a link)', async () => {
    api.get.mockImplementation(async url => url === '/profile' ? { data: { data: { hasSavedProfile: false } } } : { data: { data: { scans: [scan('a')], total: 1 } } })
    const router = renderAt('/dashboard?search=zzz')
    const box = await screen.findByPlaceholderText(/Search by job/)
    expect(box.value).toBe('zzz')
    await act(async () => { await router.navigate('/dashboard?search=other') })
    await waitFor(() => expect(box.value).toBe('other'))
    await act(async () => { await router.navigate('/dashboard') })
    await waitFor(() => expect(box.value).toBe(''))
  })
})

describe('a search the server would ignore is not a filter', () => {
  it('a box holding only spaces / filter punctuation: no "Delete these N", and no search is sent', async () => {
    api.get.mockImplementation(async url => url === '/profile' ? { data: { data: { hasSavedProfile: false } } } : { data: { data: { scans: [scan('a'), scan('b')], total: 2 } } })
    renderAt('/dashboard?search=%2C%20')
    await screen.findByText('Job a')
    expect(screen.queryByRole('button', { name: /Delete these/ })).toBeNull()
    expect(historyCalls().every(c => c[1].params.search === undefined)).toBe(true)
  })
  it('a real term with stray punctuation is sent (and purged) the way the server reads it', async () => {
    api.get.mockImplementation(async url => url === '/profile' ? { data: { data: { hasSavedProfile: false } } } : { data: { data: { scans: [scan('a')], total: 1 } } })
    api.delete.mockResolvedValue({ data: { data: { deleted: 1, remaining: 0 } } })
    renderAt('/dashboard?search=p%28m%29')
    expect(historyCalls().length).toBeGreaterThan(0)
    await screen.findByText('Job a')
    expect(historyCalls().at(-1)[1].params.search).toBe('pm')
    await userEvent.click(await screen.findByRole('button', { name: 'Delete these 1 scan' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete 1 scan' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalled())
    expect(api.delete.mock.calls[0][1].params).toEqual({ search: 'pm' })
  })
})

describe('the list spinner always clears', () => {
  it('a background refresh that takes over a cancelled page load reports its failure instead of spinning forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const live = scan('live', { status: 'SCANNING', updatedAt: new Date().toISOString() })
    let historyN = 0
    api.get.mockImplementation(async (url, cfg) => {
      if (url === '/profile') return { data: { data: { hasSavedProfile: false } } }
      if (url.startsWith('/scan/status/')) return { data: { data: { status: 'COMPLETE_PASS' } } }   // the live scan finished
      historyN++
      if (historyN === 1) return { data: { data: { scans: [live], total: 45 } } }
      if (historyN === 2) return new Promise(() => {})                                             // the page-2 load: still in flight
      throw Object.assign(new Error('boom'), { response: { data: { message: 'History is down.' } } }) // the refresh the poll triggers
    })
    renderAt('/dashboard')
    await screen.findByText('Job live')
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Next/ })) })   // spinner on, page-2 request pending
    await act(async () => { vi.advanceTimersByTime(6100) })                                         // the poll sees the scan change -> refresh
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(await screen.findByText('History is down.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('live polling stays under the status endpoint budget', () => {
  it('polls at most 3 scans per tick', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const now = new Date().toISOString()
    const scans = ['a', 'b', 'c', 'd', 'e'].map(id => scan(id, { status: 'SCANNING', updatedAt: now }))
    api.get.mockImplementation(async url => url === '/profile' ? { data: { data: { hasSavedProfile: false } } }
      : url.startsWith('/scan/status/') ? { data: { data: { status: 'SCANNING' } } }
      : { data: { data: { scans, total: 5 } } })
    renderAt('/dashboard')
    await screen.findByText('Job a')
    api.get.mockClear()
    await act(async () => { vi.advanceTimersByTime(6100) })
    const polled = api.get.mock.calls.filter(c => String(c[0]).startsWith('/scan/status/'))
    expect(polled).toHaveLength(3)
  })
})

describe('"Already verified." re-syncs the account', () => {
  it('resend answering 400 Already verified refreshes the cached user', async () => {
    mockUser = { emailVerified: false, freeFixCredits: 0 }
    api.get.mockImplementation(async url => url === '/profile' ? { data: { data: { hasSavedProfile: false } } } : { data: { data: { scans: [], total: 0 } } })
    api.post.mockRejectedValue({ response: { status: 400, data: { message: 'Already verified.' } } })
    renderAt('/dashboard')
    await waitFor(() => expect(refreshUser).toHaveBeenCalled())
    refreshUser.mockClear()
    await userEvent.click(await screen.findByRole('button', { name: 'Resend email' }))
    await screen.findByText('Already verified.')
    expect(refreshUser).toHaveBeenCalledTimes(1)
  })
  it('any other failure does not', async () => {
    mockUser = { emailVerified: false, freeFixCredits: 0 }
    api.get.mockImplementation(async url => url === '/profile' ? { data: { data: { hasSavedProfile: false } } } : { data: { data: { scans: [], total: 0 } } })
    api.post.mockRejectedValue({ response: { status: 429, data: { message: 'Slow down.' } } })
    renderAt('/dashboard')
    await waitFor(() => expect(refreshUser).toHaveBeenCalled())
    refreshUser.mockClear()
    await userEvent.click(await screen.findByRole('button', { name: 'Resend email' }))
    await screen.findByText('Slow down.')
    expect(refreshUser).not.toHaveBeenCalled()
  })
})
