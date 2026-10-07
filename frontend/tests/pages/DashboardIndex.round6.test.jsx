// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import api from '../../src/lib/api'
import DashboardIndex from '../../src/pages/dashboard/Index'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn() }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))

// Profile & Dashboard round 6: programmatic URL updates REPLACE history (no Back trap), and
// "Delete these N scans" removes what the current filters show.
const scan = (id, over = {}) => ({ id, status: 'ERROR', atsScore: null, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', jobTitle: `Job ${id}`, resumeOriginalName: 'cv.pdf', ...over })

function wire({ scans = [scan('a'), scan('b')], total } = {}) {
  api.get.mockImplementation(async url => {
    if (url === '/profile') return { data: { data: { hasSavedProfile: false } } }
    if (url === '/scan/history') return { data: { data: { scans, total: total ?? scans.length } } }
    throw new Error('unexpected ' + url)
  })
}
function renderAt(path) {
  const router = createMemoryRouter([{ path: '/dashboard', element: <DashboardIndex /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}
beforeEach(() => { api.get.mockReset(); api.delete.mockReset() })

describe('dashboard — Back button', () => {
  it('stepping back from an out-of-range ?page= REPLACES the entry, so Back cannot bounce the person forward again', async () => {
    wire({ scans: [], total: 5 })
    const router = renderAt('/dashboard?page=9')
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(router.state.historyAction).toBe('REPLACE')
  })
  it('a debounced search commit replaces the entry instead of adding one per pause in typing', async () => {
    wire()
    const router = renderAt('/dashboard?status=ERROR')
    const box = await screen.findByPlaceholderText(/Search by job/)
    await userEvent.type(box, 'pm')
    await waitFor(() => expect(router.state.location.search).toContain('search=pm'))
    expect(router.state.historyAction).toBe('REPLACE')
  })
  it('a deliberate filter or page choice still pushes (Back undoes it)', async () => {
    wire({ total: 45 })
    const router = renderAt('/dashboard')
    await userEvent.click(await screen.findByRole('button', { name: /Next/ }))
    await waitFor(() => expect(router.state.location.search).toContain('page=2'))
    expect(router.state.historyAction).toBe('PUSH')
  })
})

describe('dashboard — delete the scans the filters show', () => {
  it('no filter: no bulk button (Settings owns "delete everything")', async () => {
    wire(); renderAt('/dashboard')
    await screen.findByText('Job a')
    expect(screen.queryByRole('button', { name: /Delete these/ })).toBeNull()
  })
  it('with a filter it offers the count, asks first (naming the filter), and sends nothing until confirmed', async () => {
    wire({ total: 2 }); renderAt('/dashboard?status=ERROR')
    await userEvent.click(await screen.findByRole('button', { name: 'Delete these 2 scans' }))
    const dlg = within(await screen.findByRole('dialog'))
    expect(dlg.getByText(/matching status Error/i)).toBeInTheDocument()
    expect(dlg.getByText(/Payment records and your saved profile are kept/)).toBeInTheDocument()
    expect(api.delete).not.toHaveBeenCalled()
  })
  it('confirming deletes batch by batch with the SAME filters the list uses, then re-reads the list', async () => {
    wire({ total: 2 })
    api.delete.mockResolvedValueOnce({ data: { data: { deleted: 25, remaining: 5 } } }).mockResolvedValueOnce({ data: { data: { deleted: 5, remaining: 0 } } })
    renderAt('/dashboard?status=ERROR&search=pm')
    await userEvent.click(await screen.findByRole('button', { name: /Delete these 2 scans/ }))
    const before = api.get.mock.calls.filter(c => c[0] === '/scan/history').length
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete 2 scans' }))
    expect(await screen.findByText('Deleted 30 scans.')).toBeInTheDocument()
    expect(api.delete).toHaveBeenCalledTimes(2)
    expect(api.delete).toHaveBeenCalledWith('/profile/scans', { params: { status: 'ERROR', search: 'pm' } })
    expect(api.get.mock.calls.filter(c => c[0] === '/scan/history').length).toBeGreaterThan(before)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('scans still being processed are kept, and the result says so', async () => {
    wire({ total: 3 })
    api.delete.mockResolvedValueOnce({ data: { data: { deleted: 2, remaining: 1 } } }).mockResolvedValueOnce({ data: { data: { deleted: 0, remaining: 1 } } })
    renderAt('/dashboard?status=ERROR')
    await userEvent.click(await screen.findByRole('button', { name: /Delete these 3 scans/ }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete 3 scans' }))
    expect(await screen.findByText(/Deleted 2 scans\./)).toHaveTextContent(/1 is still being processed and was kept/)
  })
  it('a server refusal or mid-way failure is shown, with how many had already gone', async () => {
    wire({ total: 60 })
    api.delete.mockResolvedValueOnce({ data: { data: { deleted: 25, remaining: 35 } } })
      .mockRejectedValueOnce({ response: { status: 429, data: { message: 'Too many delete requests. Please try again later.' } } })
    renderAt('/dashboard?status=ERROR')
    await userEvent.click(await screen.findByRole('button', { name: /Delete these 60 scans/ }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete 60 scans' }))
    expect(await screen.findByText(/Too many delete requests/)).toHaveTextContent('25 scans were deleted before it stopped.')
  })
  it('Cancel deletes nothing', async () => {
    wire({ total: 2 }); renderAt('/dashboard?status=ERROR')
    await userEvent.click(await screen.findByRole('button', { name: /Delete these 2 scans/ }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.delete).not.toHaveBeenCalled()
  })
  it('a filter with no results offers no bulk button', async () => {
    wire({ scans: [], total: 0 }); renderAt('/dashboard?status=ERROR')
    await screen.findByText(/No scans match your search/)
    expect(screen.queryByRole('button', { name: /Delete these/ })).toBeNull()
  })
})
