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
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'J', email: 'j@x.com', emailVerified: true }, setUser: vi.fn(), refreshUser: vi.fn(), logout: vi.fn() }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/SessionsCard', () => ({ default: () => null }))
// The editor tells Settings when it holds typed-but-unsaved changes; the stub lets a test say so.
vi.mock('../../src/components/account/SavedProfileEditor', () => ({
  default: ({ profileId, onDirtyChange }) => (
    <div data-testid={`editor-${profileId || 'primary'}`}>
      <button type="button" onClick={() => onDirtyChange?.(true)}>{`type into ${profileId || 'primary'}`}</button>
    </div>
  ),
}))

// Profile & Dashboard round 12: B4 (a draft is never dropped silently) and B5 (a failed refresh is not silent).
const extra = { id: 'p1', label: 'Product roles', savedAt: '2026-09-02T00:00:00Z', editedAt: null, version: 'v', sourceScanId: null, summary: { name: 'J', jobCount: 2 } }
const profile = (over = {}) => ({
  hasSavedProfile: true, savedAt: '2026-09-01T00:00:00Z', editedAt: null, sourceScanId: null,
  summary: { name: 'J', jobCount: 1, skillCount: 2, educationCount: 0 },
  extraProfiles: [extra], maxExtraProfiles: 4,
  previousVersion: { replacedAt: '2026-09-03T00:00:00Z', summary: { name: 'J', jobCount: 1, skillCount: 1 } },
  preferences: { notifyScanResults: true, notifyOutcomeFollowup: true }, ...over,
})
let profileCalls
beforeEach(() => {
  for (const m of [api.get, api.post, api.patch, api.put, api.delete]) m.mockReset()
  profileCalls = 0
  api.get.mockImplementation(async url => {
    if (url === '/profile') { profileCalls++; return { data: { data: profile() } } }
    throw new Error('unexpected ' + url)
  })
  api.post.mockResolvedValue({ data: { success: true } })
})
const renderPage = () => render(<MemoryRouter><Settings /></MemoryRouter>)
const mainEdit = async () => { await screen.findByText('Product roles'); await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]) }

describe('B4: Make main', () => {
  it('with nothing unsaved goes straight through', async () => {
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/profile/extras/p1/make-main'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('asks before throwing away unsaved edits in the main profile editor', async () => {
    renderPage()
    await mainEdit()
    await userEvent.click(screen.getByRole('button', { name: 'type into primary' }))
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/unsaved/i)
    expect(api.post).not.toHaveBeenCalled()
    expect(screen.getByTestId('editor-primary')).toBeTruthy()
  })
  it('"Keep editing" leaves everything as it was', async () => {
    renderPage()
    await mainEdit()
    await userEvent.click(screen.getByRole('button', { name: 'type into primary' }))
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.post).not.toHaveBeenCalled()
    expect(screen.getByTestId('editor-primary')).toBeTruthy()
  })
  it('confirming discards the draft and makes the swap', async () => {
    renderPage()
    await mainEdit()
    await userEvent.click(screen.getByRole('button', { name: 'type into primary' }))
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard and switch' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/profile/extras/p1/make-main'))
    await waitFor(() => expect(screen.queryByTestId('editor-primary')).toBeNull())
  })
  it('unsaved edits in an additional profile editor are protected the same way', async () => {
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1])
    await userEvent.click(screen.getByRole('button', { name: 'type into p1' }))
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent(/unsaved/i)
    expect(api.post).not.toHaveBeenCalled()
  })
})

describe('B4: Restore earlier version', () => {
  const openRestore = async () => { await screen.findByText('Product roles'); await userEvent.click(screen.getByRole('button', { name: 'Restore earlier version' })) }
  it('the usual confirmation does not mention edits when there are none', async () => {
    renderPage()
    await openRestore()
    expect(await screen.findByRole('dialog')).not.toHaveTextContent(/unsaved/i)
  })
  it('the confirmation warns that typed, unsaved edits will be lost', async () => {
    renderPage()
    await mainEdit()
    await userEvent.click(screen.getByRole('button', { name: 'type into primary' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restore earlier version' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/unsaved/i)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/profile/restore-previous', { replacedAt: '2026-09-03T00:00:00Z' }))
  })
})

describe('B5: a refresh that fails after an action that worked', () => {
  const failRefreshAfterFirstLoad = () => api.get.mockImplementation(async url => {
    if (url !== '/profile') throw new Error('unexpected ' + url)
    profileCalls++
    if (profileCalls > 1) throw { response: { status: 500, data: {} } }
    return { data: { data: profile() } }
  })
  it('says the change went through and the page needs a reload (instead of showing stale state in silence)', async () => {
    failRefreshAfterFirstLoad()
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/went through.*(refresh|reload)/i)
    expect(screen.getByText('Product roles')).toBeTruthy()   // what was on screen is kept, not blanked
  })
  it('a refresh that works shows no such notice', async () => {
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    await waitFor(() => expect(profileCalls).toBeGreaterThan(1))
    expect(screen.queryByText(/went through/i)).toBeNull()
  })
  it('the initial load failing is still the existing "couldn\'t check" error with Try again', async () => {
    api.get.mockRejectedValue({ response: { status: 500, data: {} } })
    renderPage()
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText(/went through/i)).toBeNull()
  })
})
