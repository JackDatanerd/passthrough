// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { AuthContext } from '../../src/context/AuthContext'
import Navbar from '../../src/components/layout/Navbar'

// Navbar reads auth state to decide what to show (signed-out CTAs vs.
// Dashboard/Sign out vs. an Admin link for admins) — none of that had a
// regression test before this (Section 12 audit). Rendered against a plain
// AuthContext.Provider with a fake value rather than the real AuthProvider,
// since the real one makes a live /auth/me call on mount.
function renderNavbar(authValue) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <Navbar />
      </AuthContext.Provider>
    </MemoryRouter>
  )
}

describe('Navbar', () => {
  it('shows Sign in / Get started when logged out, and no Dashboard/Admin links', () => {
    renderNavbar({ user: null, logout: () => {} })
    expect(screen.getByText('Sign in')).toBeInTheDocument()
    expect(screen.getByText('Get started')).toBeInTheDocument()
    expect(screen.queryByText('Dashboard')).toBeNull()
    expect(screen.queryByText('Admin')).toBeNull()
  })

  it('shows Dashboard and Sign out for a logged-in non-admin, but no Admin link', () => {
    renderNavbar({ user: { role: 'USER' }, logout: () => {} })
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Sign out')).toBeInTheDocument()
    expect(screen.queryByText('Admin')).toBeNull()
  })

  it('also shows an Admin link for a user with role ADMIN', () => {
    renderNavbar({ user: { role: 'ADMIN' }, logout: () => {} })
    expect(screen.getByText('Admin')).toBeInTheDocument()
  })

  it('Sign out calls logout()', async () => {
    const user = userEvent.setup()
    const logout = vi.fn()
    renderNavbar({ user: { role: 'USER' }, logout })
    await user.click(screen.getByText('Sign out'))
    expect(logout).toHaveBeenCalledTimes(1)
  })
})
