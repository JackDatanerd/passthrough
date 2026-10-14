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
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'J', email: 'j@x.com', emailVerified: false }, setUser: vi.fn(), refreshUser: vi.fn(), logout: vi.fn() }) }))
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

// Profile & Dashboard round 15: a lost verification email can be asked for again; removing a profile warns about unsaved edits.
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


describe('round 15', () => {
  it('"Sent!" gives way to a resend button again', async () => {
    api.post.mockResolvedValue({ data: { success: true } })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderPage()
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      await user.click(await screen.findByRole('button', { name: 'Resend verification email' }))
      await screen.findByText('Sent!')
      await vi.advanceTimersByTimeAsync(30001)
      expect(await screen.findByRole('button', { name: 'Resend again' })).toBeTruthy()
    } finally { vi.useRealTimers() }
  })
  it('removing the main profile warns about unsaved edits in the open editor', async () => {
    renderPage()
    await mainEdit()
    await userEvent.click(screen.getByRole('button', { name: 'type into primary' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove saved profile' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent(/unsaved edits/i)
  })
  it('removing an additional profile warns only when its editor is dirty', async () => {
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(within(await screen.findByRole('dialog')).queryByText(/unsaved/i)).toBeNull()
  })
})
