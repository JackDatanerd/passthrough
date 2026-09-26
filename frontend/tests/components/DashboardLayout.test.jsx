// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext } from '../../src/context/AuthContext'
import DashboardLayout from '../../src/components/layout/DashboardLayout'

// DashboardLayout.jsx's own comment says its nav tab strip is the ONLY route
// to /dashboard/settings on narrow screens — worth protecting the bit that
// decides which tab is "active", including the trailing-slash edge case
// (Section 12 audit).
function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ user: null, logout: () => {} }}>
        <DashboardLayout><p>Page content</p></DashboardLayout>
      </AuthContext.Provider>
    </MemoryRouter>
  )
}

describe('DashboardLayout', () => {
  it('renders all three dashboard tabs and the page content', () => {
    renderAt('/dashboard')
    expect(screen.getByText('Scans')).toBeInTheDocument()
    expect(screen.getByText('Payments')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByText('Page content')).toBeInTheDocument()
  })

  it('marks the tab matching the current path as current, and no other', () => {
    renderAt('/dashboard/settings')
    expect(screen.getByText('Settings')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Scans')).not.toHaveAttribute('aria-current')
    expect(screen.getByText('Payments')).not.toHaveAttribute('aria-current')
  })

  it('still matches with a trailing slash on the URL', () => {
    renderAt('/dashboard/payments/')
    expect(screen.getByText('Payments')).toHaveAttribute('aria-current', 'page')
  })
})
