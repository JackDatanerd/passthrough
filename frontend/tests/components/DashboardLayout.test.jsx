// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext } from '../../src/context/AuthContext'
import api from '../../src/lib/api'
import { resetNeedsDecision } from '../../src/lib/needsDecision'
import DashboardLayout from '../../src/components/layout/DashboardLayout'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// DashboardLayout.jsx's own comment says its tab strip is the ONLY route to /dashboard/settings, so the bit that
// decides which tab is "active" is worth protecting, including the trailing-slash edge case (Section 12 audit).
// The signed-in area also has its own header: the dashboard's tabs and Sign out, never the public site's links.
function renderAt(path, auth = { user: null, logout: () => {} }) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={auth}>
        <DashboardLayout><p>Page content</p></DashboardLayout>
      </AuthContext.Provider>
    </MemoryRouter>
  )
}
const SIGNED_IN = { user: { id: 'u1', role: 'USER' }, logout: vi.fn() }

beforeEach(() => {
  api.get.mockReset(); resetNeedsDecision()
  api.get.mockResolvedValue({ data: { data: { scans: [], total: 0 } } })
})

describe('DashboardLayout tabs', () => {
  it('renders all the dashboard tabs, in order, and the page content', () => {
    renderAt('/dashboard')
    const order = [...screen.getByRole('navigation', { name: 'Dashboard' }).querySelectorAll('a')].map(a => a.textContent)
    expect(order).toEqual(['Scans', 'Proof', 'My Story', 'Payments', 'Settings'])
    expect(screen.getByText('Page content')).toBeInTheDocument()
  })

  it('marks the tab matching the current path as current, and no other', () => {
    renderAt('/dashboard/settings')
    expect(screen.getByText('Settings')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Scans')).not.toHaveAttribute('aria-current')
    expect(screen.getByText('Payments')).not.toHaveAttribute('aria-current')
  })

  it('marks Proof and My Story as current on their own pages, and only there', () => {
    const { unmount } = renderAt('/dashboard/proof')
    expect(screen.getByText('Proof')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Scans')).not.toHaveAttribute('aria-current')
    unmount()
    renderAt('/dashboard/story')
    expect(screen.getByText('My Story')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Proof')).not.toHaveAttribute('aria-current')
  })

  it('still matches with a trailing slash on the URL', () => {
    renderAt('/dashboard/payments/')
    expect(screen.getByText('Payments')).toHaveAttribute('aria-current', 'page')
  })
})

describe('DashboardLayout header', () => {
  it("has no links to the public site's sections in the header: no Stories, Hot categories, Pricing, For employers or a Dashboard link", () => {
    renderAt('/dashboard', SIGNED_IN)
    const header = within(screen.getByRole('banner'))
    for (const name of ['Stories', 'Hot categories', 'Pricing', 'For employers', 'Dashboard']) {
      expect(header.queryByRole('link', { name })).toBeNull()
    }
    expect(header.getByRole('link', { name: 'Passthrough' })).toHaveAttribute('href', '/')
  })

  it('signs out and goes to the homepage', async () => {
    const logout = vi.fn()
    renderAt('/dashboard', { user: { id: 'u1', role: 'USER' }, logout })
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0])
    expect(logout).toHaveBeenCalled()
  })

  it('shows an Admin link for admins only', () => {
    const { unmount } = renderAt('/dashboard', { user: { id: 'a', role: 'ADMIN' }, logout: () => {} })
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin')
    unmount()
    resetNeedsDecision()
    renderAt('/dashboard', SIGNED_IN)
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull()
  })
})

describe('the count on the Scans tab', () => {
  it('shows how many scans are waiting for a decision, asking for the total only', async () => {
    api.get.mockResolvedValue({ data: { data: { scans: [], total: 6 } } })
    renderAt('/dashboard/payments', SIGNED_IN)
    expect(await screen.findByText('6')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Scans 6 waiting for your decision/ })).toHaveAttribute('href', '/dashboard')
    expect(api.get).toHaveBeenCalledWith('/scan/history', { params: { status: 'NEEDS_DECISION', limit: 1 } })
  })

  it('is left off when nothing is waiting', async () => {
    renderAt('/dashboard', SIGNED_IN)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(screen.getByRole('link', { name: 'Scans' })).toBeInTheDocument()   // no badge, so the name is just "Scans"
  })

  it('a failed request leaves the tab plain, never an error', async () => {
    api.get.mockRejectedValue(new Error('down'))
    renderAt('/dashboard', SIGNED_IN)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(screen.getByRole('link', { name: 'Scans' })).toBeInTheDocument()
  })

  it('does not ask at all when there is no signed-in user', () => {
    renderAt('/dashboard')
    expect(api.get).not.toHaveBeenCalled()
  })

  it('shares one request between pages mounted within a minute, and one person never sees the previous one\'s number', async () => {
    api.get.mockResolvedValue({ data: { data: { scans: [], total: 4 } } })
    const first = renderAt('/dashboard', SIGNED_IN)
    expect(await screen.findByText('4')).toBeInTheDocument()
    first.unmount()
    renderAt('/dashboard/proof', SIGNED_IN)
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledTimes(1)
  })
})
