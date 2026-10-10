// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

// Profile & Dashboard round 8: sort + hand-picked delete.
const scan = (id, over = {}) => ({ id, status: 'ERROR', atsScore: null, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', jobTitle: `Job ${id}`, ...over })
const live = (id) => scan(id, { status: 'SCANNING', updatedAt: new Date().toISOString() })
function renderAt(path) {
  const router = createMemoryRouter([{ path: '/dashboard', element: <DashboardIndex /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}
const historyCalls = () => api.get.mock.calls.filter(c => c[0] === '/scan/history')
let scans
beforeEach(() => {
  for (const m of [api.get, api.post, api.delete]) m.mockReset()
  scans = [scan('a'), scan('b'), live('c')]
  api.get.mockImplementation(async url => url === '/profile'
    ? { data: { data: { hasSavedProfile: false } } }
    : { data: { data: { scans, total: scans.length } } })
})

describe('sort', () => {
  it('sends nothing for the default order and the chosen order otherwise', async () => {
    const router = renderAt('/dashboard')
    await screen.findByText('Job a')
    expect(historyCalls()[0][1].params.sort).toBeUndefined()
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'score_desc')
    await waitFor(() => expect(historyCalls().at(-1)[1].params.sort).toBe('score_desc'))
    expect(router.state.location.search).toBe('?sort=score_desc')
  })
  it('an unknown ?sort= falls back to newest', async () => {
    renderAt('/dashboard?sort=bogus')
    await screen.findByText('Job a')
    expect(screen.getByLabelText('Sort').value).toBe('newest')
    expect(historyCalls().every(c => c[1].params.sort === undefined)).toBe(true)
  })
})

describe('hand-picked delete', () => {
  it('in-flight scans cannot be ticked, and "Select page" skips them', async () => {
    renderAt('/dashboard')
    await screen.findByText('Job a')
    expect(screen.getByLabelText('Select Job c')).toBeDisabled()
    await userEvent.click(screen.getByLabelText('Select page'))
    expect(screen.getByLabelText('Select Job a')).toBeChecked()
    expect(screen.getByLabelText('Select Job c')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Delete 2 selected' })).toBeTruthy()
  })
  it('sends exactly the ticked ids in one request, then reloads and clears the selection', async () => {
    api.delete.mockResolvedValue({ data: { data: { deleted: 1, remaining: 0 } } })
    renderAt('/dashboard')
    await screen.findByText('Job a')
    await userEvent.click(screen.getByLabelText('Select Job b'))
    await userEvent.click(screen.getByRole('button', { name: 'Delete 1 selected' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete 1 scan' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1))
    expect(api.delete.mock.calls[0][0]).toBe('/profile/scans')
    expect(api.delete.mock.calls[0][1].params).toEqual({ ids: 'b' })
    await waitFor(() => expect(historyCalls().length).toBeGreaterThan(1))
    expect(screen.queryByRole('button', { name: /selected/ })).toBeNull()
  })
  it('changing the sort drops the selection', async () => {
    renderAt('/dashboard')
    await screen.findByText('Job a')
    await userEvent.click(screen.getByLabelText('Select Job a'))
    expect(screen.getByRole('button', { name: 'Delete 1 selected' })).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'oldest')
    await waitFor(() => expect(screen.queryByRole('button', { name: /selected/ })).toBeNull())
  })
})
