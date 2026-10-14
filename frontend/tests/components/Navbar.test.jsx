// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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
  it('shows Sign in / Scan free when logged out, and no Dashboard/Admin links', () => {
    renderNavbar({ user: null, logout: () => {} })
    expect(screen.getByText('Sign in')).toBeInTheDocument()
    expect(screen.getByText('Scan free')).toBeInTheDocument()
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

  it('the bar is sticky (it stays under the thumb/cursor while the page scrolls) and leads with the logo mark', () => {
    renderNavbar({ user: null, logout: () => {} })
    const bar = screen.getByRole('navigation', { name: 'Main' })
    expect(bar.className).toMatch(/\bsticky\b/)
    expect(bar.className).toMatch(/\btop-0\b/)
    const home = screen.getByRole('link', { name: 'Passthrough' })
    expect(home).toHaveAttribute('href', '/')
    expect(home.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it('the one button is the scan: "Scan free" jumps to the homepage scan card, for signed-out and signed-in alike', () => {
    for (const user of [null, { role: 'USER' }]) {
      const { unmount } = renderNavbar({ user, logout: () => {} })
      expect(screen.getByRole('link', { name: 'Scan free' })).toHaveAttribute('href', '/#scan-form')
      unmount()
    }
  })

  it('the bar has four entries — How it works, a Stories dropdown, Pricing, For employers', () => {
    renderNavbar({ user: null, logout: () => {} })
    const bar = screen.getByRole('navigation', { name: 'Main' })
    const links = [...bar.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')])
    const wanted = [['How it works', '/#how'], ['Pricing', '/pricing'], ['For employers', '/#employers']]
    expect(links.filter(l => wanted.some(w => w[0] === l[0]))).toEqual(wanted)
    const stories = screen.getByRole('button', { name: 'Stories' })
    expect(stories).toHaveAttribute('aria-expanded', 'false')
    expect(stories).toHaveAttribute('aria-controls', 'navbar-stories')
    // the proof-style sections are NOT in the bar any more — they live in the dropdown
    for (const gone of ['Proof', 'The receipt', 'Hot categories', 'Applicant stories']) expect(screen.queryByText(gone)).toBeNull()
  })

  it('the Stories dropdown opens on click and holds Applicant stories, Proof, The receipt and Hot categories', async () => {
    const user = userEvent.setup()
    renderNavbar({ user: null, logout: () => {} })
    await user.click(screen.getByRole('button', { name: 'Stories' }))
    expect(screen.getByRole('button', { name: 'Stories' })).toHaveAttribute('aria-expanded', 'true')
    const panel = document.getElementById('navbar-stories')
    expect([...panel.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Applicant stories', '/#stories'], ['Proof', '/#proof'], ['The receipt', '/#receipt'], ['Hot categories', '/#hot'],
    ])
  })

  it('Escape closes the dropdown and hands focus back to its button; a press outside closes it too', async () => {
    const user = userEvent.setup()
    renderNavbar({ user: null, logout: () => {} })
    const btn = screen.getByRole('button', { name: 'Stories' })
    await user.click(btn)
    expect(document.getElementById('navbar-stories')).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(document.getElementById('navbar-stories')).toBeNull()
    expect(btn).toHaveFocus()
    await user.click(btn)
    await user.click(document.body)
    expect(document.getElementById('navbar-stories')).toBeNull()
  })

  it('choosing an item closes the dropdown, and tabbing out of it closes it', async () => {
    const user = userEvent.setup()
    renderNavbar({ user: null, logout: () => {} })
    await user.click(screen.getByRole('button', { name: 'Stories' }))
    await user.click(within(document.getElementById('navbar-stories')).getByText('Proof'))
    expect(document.getElementById('navbar-stories')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Stories' }))
    expect(document.getElementById('navbar-stories')).not.toBeNull()
    // Tab through the four items and one more: focus leaves the dropdown, so it closes
    await user.tab(); await user.tab(); await user.tab(); await user.tab(); await user.tab()
    expect(document.getElementById('navbar-stories')).toBeNull()
  })

  it('in the phone menu the same group is listed flat under a "Stories" label (no nested dropdown)', async () => {
    const user = userEvent.setup()
    renderNavbar({ user: null, logout: () => {} })
    await user.click(screen.getByRole('button', { name: 'More' }))
    const menu = document.getElementById('navbar-more')
    expect([...menu.querySelectorAll('a')].map(a => a.textContent)).toEqual(['How it works', 'Applicant stories', 'Proof', 'The receipt', 'Hot categories', 'Pricing', 'For employers', 'Sign in'])
    expect(within(menu).getByRole('group', { name: 'Stories' })).toBeInTheDocument()
  })

  it('on a small screen a signed-in user reaches Dashboard, Admin and Sign out through More, and Sign out there calls logout()', async () => {
    const user = userEvent.setup()
    const logout = vi.fn()
    renderNavbar({ user: { role: 'ADMIN' }, logout })
    await user.click(screen.getByRole('button', { name: 'More' }))
    const menu = document.getElementById('navbar-more')
    expect([...menu.querySelectorAll('a,button')].map(e => e.textContent)).toEqual(['How it works', 'Applicant stories', 'Proof', 'The receipt', 'Hot categories', 'Pricing', 'For employers', 'Dashboard', 'Admin', 'Sign out'])
    await user.click([...menu.querySelectorAll('button')].find(b => b.textContent === 'Sign out'))
    expect(logout).toHaveBeenCalledTimes(1)
    expect(document.getElementById('navbar-more')).toBeNull()
  })
})
