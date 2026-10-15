// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import api from '../../src/lib/api'
import DashboardIndex from '../../src/pages/dashboard/Index'

let authUser
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: authUser, refreshUser: vi.fn() }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))

// Webhooks round 14 (G1): the person is told when the mail provider reports their address as undeliverable.
function renderDash() {
  const router = createMemoryRouter([{ path: '/dashboard', element: <DashboardIndex /> }], { initialEntries: ['/dashboard'] })
  render(<RouterProvider router={router} />)
}
beforeEach(() => {
  for (const m of [api.get, api.post, api.delete]) m.mockReset()
  api.get.mockImplementation(async url => url === '/profile/quota'
    ? { data: { data: { hasSavedProfile: false } } }
    : { data: { data: { scans: [], total: 0 } } })
})

describe('email undeliverable banner', () => {
  it('says so, links to Settings, and explains a bounce', async () => {
    authUser = { emailVerified: true, freeFixCredits: 0, emailBounce: { type: 'bounce', at: '2026-09-27T10:00:00Z' } }
    renderDash()
    const banner = await screen.findByTestId('email-bounce-banner')
    expect(banner.textContent).toMatch(/can't reach your email/i)
    expect(banner.textContent).toMatch(/returned/)
    expect(banner.querySelector('a').getAttribute('href')).toBe('/dashboard/settings')
  })
  it('a spam complaint is described as one', async () => {
    authUser = { emailVerified: true, freeFixCredits: 0, emailBounce: { type: 'complaint', at: '2026-09-27T10:00:00Z' } }
    renderDash()
    expect((await screen.findByTestId('email-bounce-banner')).textContent).toMatch(/reported as spam/)
  })
  it('is absent for a normal account', async () => {
    authUser = { emailVerified: true, freeFixCredits: 0, emailBounce: null }
    renderDash()
    await screen.findByText(/New scan/i)
    expect(screen.queryByTestId('email-bounce-banner')).toBeNull()
  })
})
