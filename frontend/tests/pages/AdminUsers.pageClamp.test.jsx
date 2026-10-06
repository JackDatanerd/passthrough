// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminUsers from '../../src/pages/admin/AdminUsers'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// The reachable bug: on the LAST page, act on the only row there so the list shrinks by one page.
// The reload used to keep asking for page 2; the server answered "no rows, total 25", <Pagination>
// hid itself (one page), and the admin sat on an empty "No users found." with no way back.
const user = (n, over = {}) => ({
  id: `u${n}`, name: `User ${n}`, email: `u${n}@x.co`, role: 'SEEKER', status: 'ACTIVE',
  emailVerified: true, scansToday: 0, createdAt: '2026-09-01T00:00:00Z', ...over,
})

describe('AdminUsers — page clamp after the list shrinks', () => {
  beforeEach(() => { api.get.mockReset(); api.patch.mockReset() })

  it('returns to the last real page instead of stranding the admin on an empty one', async () => {
    let banned = false
    api.get.mockImplementation(async (_url, { params }) => {
      const total = banned ? 25 : 26
      if (params.page === 1) return { data: { data: Array.from({ length: 25 }, (_, i) => user(i + 1)), meta: { total } } }
      return { data: { data: banned ? [] : [user(26)], meta: { total } } }
    })
    api.patch.mockImplementation(async () => { banned = true; return { data: {} } })

    const u = userEvent.setup()
    render(<ToastProvider><AdminUsers /></ToastProvider>)
    await screen.findByText('User 1')
    await u.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('User 26')

    await u.click(screen.getByRole('button', { name: 'Ban' }))
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }))

    // Back on page 1 with real rows — not "No users found." on a page that no longer exists.
    await screen.findByText('User 1')
    expect(screen.queryByText('No users found.')).toBeNull()
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin/users', expect.objectContaining({ params: expect.objectContaining({ page: 1 }) })))
  })
})
