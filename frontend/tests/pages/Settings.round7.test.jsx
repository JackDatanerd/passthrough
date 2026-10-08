// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import Settings from '../../src/pages/dashboard/Settings'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
const refreshUser = vi.fn()
let mockUser
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser, setUser: vi.fn(), refreshUser, logout: vi.fn() }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/SessionsCard', () => ({ default: ({ reloadKey }) => <p data-testid="sessions-key">{reloadKey}</p> }))
let editorMounts = 0
vi.mock('../../src/components/account/SavedProfileEditor', async () => {
  const { useEffect } = await import('react')
  return {
    default: ({ onSaved }) => {
      useEffect(() => { editorMounts++ }, [])   // real mounts, not renders
      return <div data-testid="editor"><input aria-label="typed" /><button onClick={onSaved}>fake-save</button></div>
    },
  }
})

// Profile & Dashboard round 7.
const profile = (over = {}) => ({ data: { data: { hasSavedProfile: true, savedAt: '2026-09-01T00:00:00Z', sourceScanId: 's1', summary: { name: 'J', jobCount: 1 }, preferences: { notifyScanResults: true }, ...over } } })
beforeEach(() => {
  for (const m of [api.get, api.post, api.patch, api.put, api.delete]) m.mockReset()
  refreshUser.mockReset(); editorMounts = 0
  mockUser = { id: 'u1', name: 'J', email: 'j@x.com', emailVerified: true }
  api.get.mockImplementation(async url => { if (url === '/profile') return profile(); throw new Error('unexpected ' + url) })
})
const renderPage = () => render(<MemoryRouter><Settings /></MemoryRouter>)

describe('devices list re-reads after a password change', () => {
  it('a password change revokes every session and starts a new one — the list is told to reload', async () => {
    api.patch.mockResolvedValue({ data: { data: { token: 't2' } } })
    renderPage()
    await screen.findByText('Change password')
    const before = screen.getByTestId('sessions-key').textContent
    await userEvent.type(screen.getByLabelText('Current password'), 'OldPassw0rd!x')
    await userEvent.type(screen.getByLabelText('New password'), 'Brand-new-pass-9!')
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'Brand-new-pass-9!')
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }))
    await screen.findByText(/Password updated/)
    expect(screen.getByTestId('sessions-key').textContent).not.toBe(before)
  })
  it('a rejected password change does not', async () => {
    api.patch.mockRejectedValue({ response: { status: 400, data: { message: 'Current password incorrect.' } } })
    renderPage()
    await screen.findByText('Change password')
    const before = screen.getByTestId('sessions-key').textContent
    await userEvent.type(screen.getByLabelText('Current password'), 'WrongPassw0rd!x')
    await userEvent.type(screen.getByLabelText('New password'), 'Brand-new-pass-9!')
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'Brand-new-pass-9!')
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }))
    await screen.findByText('Current password incorrect.')
    expect(screen.getByTestId('sessions-key').textContent).toBe(before)
  })
})

describe('"Already verified." re-syncs the account', () => {
  it('refreshes the cached user on a 400 Already verified, not on other failures', async () => {
    mockUser = { ...mockUser, emailVerified: false }
    api.post.mockRejectedValueOnce({ response: { status: 429, data: { message: 'Slow down.' } } })
      .mockRejectedValueOnce({ response: { status: 400, data: { message: 'Already verified.' } } })
    renderPage()
    await waitFor(() => expect(refreshUser).toHaveBeenCalled())
    refreshUser.mockClear()
    await userEvent.click(await screen.findByRole('button', { name: 'Resend verification email' }))
    await screen.findByText('Slow down.')
    expect(refreshUser).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Resend verification email' }))
    await screen.findByText('Already verified.')
    expect(refreshUser).toHaveBeenCalledTimes(1)
  })
})

describe('the saved-profile editor survives refreshes of the card', () => {
  it('finishing "delete my scan history" while the editor is open does not unmount it (typed changes stay)', async () => {
    api.delete.mockResolvedValue({ data: { data: { deleted: 2, remaining: 0 } } })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await userEvent.type(await screen.findByLabelText('typed'), 'half-typed edit')
    const mounts = editorMounts
    await userEvent.click(screen.getByRole('button', { name: 'Delete my scan history' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all scans' }))
    await screen.findByText(/Deleted 2 scans/)
    await waitFor(() => expect(api.get.mock.calls.filter(c => c[0] === '/profile').length).toBeGreaterThan(1))   // card refreshed...
    expect(screen.getByLabelText('typed')).toHaveValue('half-typed edit')                                      // ...editor and its text intact
    expect(editorMounts).toBe(mounts)
  })
  it('a quiet refresh that fails leaves what is on screen alone', async () => {
    api.delete.mockResolvedValue({ data: { data: { deleted: 1, remaining: 0 } } })
    renderPage()
    await screen.findByText(/View source scan/)
    api.get.mockRejectedValue(new Error('down'))
    await userEvent.click(screen.getByRole('button', { name: 'Delete my scan history' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all scans' }))
    await screen.findByText(/Deleted 1 scan/)
    expect(screen.getByText(/View source scan/)).toBeInTheDocument()
    expect(screen.queryByText("Couldn't check your saved profile.")).toBeNull()
  })
  it('the first load failing still shows the error with Try again', async () => {
    api.get.mockRejectedValueOnce(new Error('down')).mockImplementation(async () => profile())
    renderPage()
    await screen.findByText("Couldn't check your saved profile.")
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/View source scan/)).toBeInTheDocument()
  })
})

describe('the export copy matches what the export holds', () => {
  it('mentions the scan analysis and refunds', async () => {
    renderPage()
    const copy = (await screen.findByText(/Download a copy of what we hold/)).textContent
    expect(copy).toMatch(/analysis/); expect(copy).toMatch(/refunds/)
  })
})
