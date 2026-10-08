// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import Settings from '../../src/pages/dashboard/Settings'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
const setUser = vi.fn(), refreshUser = vi.fn(), logout = vi.fn()
let currentUser
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: currentUser, setUser, refreshUser, logout }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/SessionsCard', () => ({ default: () => null }))

// Profile & Dashboard round 5: name save no longer flickers/relies on a refresh, pending-email
// expiry, the notification toggle, profile edit + rescan, whole-history deletion, export copy.
const PROFILE = {
  hasSavedProfile: true, savedAt: '2026-09-01T10:00:00Z', editedAt: null, sourceScanId: null,
  summary: { name: 'Jane Doe', roleCategory: 'data_science', latestTitle: 'Analyst', jobCount: 2, educationCount: 1, skillCount: 4 },
  preferences: { notifyScanResults: true }, quota: { limit: 3, used: 0, remaining: 3, resetsAt: '2026-10-06T00:00:00.000Z' },
}
const user0 = (over = {}) => ({ id: 'u1', name: 'Jane Doe', email: 'jane@x.com', emailVerified: true, freeFixCredits: 0, ...over })
function wire(profile = PROFILE) {
  api.get.mockImplementation(async url => {
    if (url === '/profile') { if (profile instanceof Error) throw profile; return { data: { data: profile } } }
    if (url === '/profile/data') return { data: { data: { resumeData: { name: 'Jane Doe', skills: ['SQL'] } } } }
    throw new Error('unexpected ' + url)
  })
}
const renderPage = () => render(<MemoryRouter><Settings /></MemoryRouter>)

beforeEach(() => {
  for (const m of [api.get, api.post, api.patch, api.put, api.delete, setUser, refreshUser, logout]) m.mockReset()
  currentUser = user0()
  // Like the real AuthProvider: the context's user becomes whatever setUser was given.
  setUser.mockImplementation(u => { currentUser = u })
  localStorage.clear()
  localStorage.setItem('passthrough_token', 'tok')   // a signed-in browser, as Settings is only reachable signed in
  wire()
})

describe('Settings — name', () => {
  it('saving puts the SERVER\'s saved name in the field, the cache and localStorage together — even if the follow-up refresh fails', async () => {
    const user = userEvent.setup()
    refreshUser.mockRejectedValue(new Error('offline'))
    api.patch.mockResolvedValue({ data: { data: { user: { name: 'Jane Q Doe' } } } })
    renderPage()
    const field = screen.getByLabelText('Name')
    await user.clear(field); await user.type(field, '  Jane Q Doe  ')
    await user.click(within(field.closest('form')).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Name updated.')).toBeInTheDocument()
    expect(api.patch).toHaveBeenCalledWith('/auth/name', { name: 'Jane Q Doe' })
    expect(field).toHaveValue('Jane Q Doe')
    expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', name: 'Jane Q Doe', email: 'jane@x.com' }))
    expect(JSON.parse(localStorage.getItem('passthrough_user')).name).toBe('Jane Q Doe')
  })
  // Auth round 4 (B2): a save that lands after the person signed out must not write a user back with no
  // token — Login would then redirect to the dashboard, which would redirect straight back, forever.
  it('does not write the cached user back when the person signed out while the save was in flight', async () => {
    const user = userEvent.setup()
    api.patch.mockImplementation(async () => { localStorage.removeItem('passthrough_token'); return { data: { data: { user: { name: 'Jane Q Doe' } } } } })
    renderPage()
    const field = screen.getByLabelText('Name')
    await user.clear(field); await user.type(field, 'Jane Q Doe')
    await user.click(within(field.closest('form')).getByRole('button', { name: 'Save' }))
    await screen.findByText('Name updated.')
    expect(localStorage.getItem('passthrough_user')).toBeNull()
    expect(setUser).not.toHaveBeenCalled()
  })
  it('a rejected save shows the reason and leaves the cached user alone', async () => {
    const user = userEvent.setup()
    api.patch.mockRejectedValue({ response: { data: { message: 'Name is too long.' } } })
    renderPage()
    const field = screen.getByLabelText('Name')
    await user.type(field, 'x')
    await user.click(within(field.closest('form')).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Name is too long.')).toBeInTheDocument()
    expect(setUser).not.toHaveBeenCalled()
  })
})

describe('Settings — pending email change', () => {
  it('says until when the confirmation link works', async () => {
    currentUser = user0({ pendingEmail: 'new@x.com', pendingEmailExpiry: '2026-10-05T12:00:00Z' })
    renderPage()
    const banner = await screen.findByText(/Confirmation pending for/)
    expect(banner).toHaveTextContent('new@x.com')
    expect(banner).toHaveTextContent(/the link works until/)
  })
  it('shows no banner when nothing is pending (the server hides an expired one)', async () => {
    renderPage()
    await screen.findByText('Saved profile')
    expect(screen.queryByText(/Confirmation pending/)).toBeNull()
  })
})

describe('Settings — email preference', () => {
  it('shows the saved choice and saves a change', async () => {
    const user = userEvent.setup()
    api.patch.mockResolvedValue({ data: { success: true } })
    renderPage()
    const box = await screen.findByRole('checkbox', { name: /Email me when a scan finishes/ })
    expect(box).toBeChecked()
    await user.click(box)
    expect(api.patch).toHaveBeenCalledWith('/profile/preferences', { notifyScanResults: false })
    await waitFor(() => expect(box).not.toBeChecked())
  })
  it('a failed save puts the checkbox back and says so', async () => {
    const user = userEvent.setup()
    api.patch.mockRejectedValue({ response: { data: { message: 'Nope.' } } })
    renderPage()
    const box = await screen.findByRole('checkbox', { name: /Email me when a scan finishes/ })
    await user.click(box)
    expect(await screen.findByText('Nope.')).toBeInTheDocument()
    expect(box).toBeChecked()
  })
  it('an opted-out account shows unchecked; and the control is hidden if the preference could not be read', async () => {
    wire({ ...PROFILE, preferences: { notifyScanResults: false } })
    const { unmount } = renderPage()
    expect(await screen.findByRole('checkbox', { name: /Email me when a scan finishes/ })).not.toBeChecked()
    unmount()
    wire(new Error('down'))
    renderPage()
    await screen.findByText(/Couldn't check your saved profile/)
    expect(screen.queryByRole('checkbox', { name: /Email me/ })).toBeNull()
  })
})

describe('Settings — saved profile', () => {
  it('offers a rescan straight into saved-profile mode', async () => {
    renderPage()
    const link = await screen.findByRole('link', { name: 'Scan against a new job' })
    expect(link).toHaveAttribute('href', '/?mode=savedProfile')
  })
  it('shows when it was edited', async () => {
    wire({ ...PROFILE, editedAt: '2026-09-15T10:00:00Z' })
    renderPage()
    expect(await screen.findByText(/edited Sep 15, 2026/)).toBeInTheDocument()
  })
  it('Edit opens the editor in place; saving refreshes the summary and closes it', async () => {
    const user = userEvent.setup()
    api.put.mockResolvedValue({ data: { success: true } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(await screen.findByLabelText('Skills (comma-separated)')).toHaveValue('SQL')
    const profileReads = () => api.get.mock.calls.filter(c => c[0] === '/profile').length
    const before = profileReads()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.queryByLabelText('Skills (comma-separated)')).toBeNull())
    expect(profileReads()).toBeGreaterThan(before)
    expect(api.put).toHaveBeenCalledWith('/profile', expect.objectContaining({ resumeData: expect.any(Object) }))
  })
  it('no saved profile: no rescan link, no Edit', async () => {
    wire({ ...PROFILE, hasSavedProfile: false, summary: null })
    renderPage()
    await screen.findByText(/No saved profile yet/)
    expect(screen.queryByRole('link', { name: 'Scan against a new job' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})

describe('Settings — delete scan history', () => {
  const open = async user => {
    await user.click(await screen.findByRole('button', { name: 'Delete my scan history' }))
    return within(await screen.findByRole('dialog'))
  }
  it('asks first, then deletes batch after batch until none remain, and reports the total', async () => {
    const user = userEvent.setup()
    api.delete
      .mockResolvedValueOnce({ data: { data: { deleted: 25, remaining: 30 } } })
      .mockResolvedValueOnce({ data: { data: { deleted: 25, remaining: 5 } } })
      .mockResolvedValueOnce({ data: { data: { deleted: 5, remaining: 0 } } })
    renderPage()
    const dlg = await open(user)
    expect(api.delete).not.toHaveBeenCalled()                       // nothing happens until confirmed
    expect(dlg.getByText(/payment records, saved profile and account stay/i)).toBeInTheDocument()
    await user.click(dlg.getByRole('button', { name: 'Delete all scans' }))
    expect(await screen.findByText('Deleted 55 scans.')).toBeInTheDocument()
    expect(api.delete.mock.calls.map(c => c[0])).toEqual(['/profile/scans', '/profile/scans', '/profile/scans'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('stops when nothing more can go (scans still being processed) and says how many were kept', async () => {
    const user = userEvent.setup()
    api.delete
      .mockResolvedValueOnce({ data: { data: { deleted: 3, remaining: 2 } } })
      .mockResolvedValueOnce({ data: { data: { deleted: 0, remaining: 2 } } })
    renderPage()
    const dlg = await open(user)
    await user.click(dlg.getByRole('button', { name: 'Delete all scans' }))
    const status = await screen.findByText(/Deleted 3 scans\./)
    expect(status).toHaveTextContent(/2 are still being processed and were kept/)
    expect(api.delete).toHaveBeenCalledTimes(2)
  })
  it('an empty history says so', async () => {
    const user = userEvent.setup()
    api.delete.mockResolvedValueOnce({ data: { data: { deleted: 0, remaining: 0 } } })
    renderPage()
    const dlg = await open(user)
    await user.click(dlg.getByRole('button', { name: 'Delete all scans' }))
    expect(await screen.findByText('You have no scans to delete.')).toBeInTheDocument()
  })
  it('an error part-way keeps what was deleted honest', async () => {
    const user = userEvent.setup()
    api.delete
      .mockResolvedValueOnce({ data: { data: { deleted: 25, remaining: 40 } } })
      .mockRejectedValueOnce({ response: { status: 429, data: { message: 'Too many delete requests. Please try again later.' } } })
    renderPage()
    const dlg = await open(user)
    await user.click(dlg.getByRole('button', { name: 'Delete all scans' }))
    const alert = await screen.findByText(/Too many delete requests/)
    expect(alert).toHaveTextContent('25 scans were deleted before it stopped.')
  })
  it('Cancel deletes nothing', async () => {
    const user = userEvent.setup()
    renderPage()
    const dlg = await open(user)
    await user.click(dlg.getByRole('button', { name: 'Cancel' }))
    expect(api.delete).not.toHaveBeenCalled()
  })
})

describe('Settings — your data', () => {
  it('describes the fuller export and no longer promises a fixed number of scans per file', async () => {
    renderPage()
    const para = await screen.findByText(/Download a copy of what we hold/)
    expect(para).toHaveTextContent(/sign-in history/)
    expect(para).toHaveTextContent(/emails we've sent you/)
    expect(document.body.textContent).not.toMatch(/500 scans/)
  })
})
