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
vi.mock('../../src/components/account/SavedProfileEditor', () => ({ default: ({ profileId }) => <div data-testid="editor">{profileId || 'primary'}</div> }))

// Profile & Dashboard round 8: additional profiles + downloads.
const extra = { id: 'p1', label: 'Product roles', savedAt: '2026-09-02T00:00:00Z', editedAt: null, version: 'v', sourceScanId: null, summary: { name: 'J', jobCount: 2 } }
let extras
beforeEach(() => {
  for (const m of [api.get, api.post, api.patch, api.put, api.delete]) m.mockReset()
  extras = [extra]
  api.get.mockImplementation(async url => {
    if (url === '/profile') return { data: { data: { hasSavedProfile: false, extraProfiles: extras, maxExtraProfiles: 4, preferences: { notifyScanResults: true } } } }
    if (url.startsWith('/profile/download-')) return { data: new Blob(['x']) }
    throw new Error('unexpected ' + url)
  })
  URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn()
})
const renderPage = () => render(<MemoryRouter><Settings /></MemoryRouter>)

describe('additional profiles', () => {
  it('are listed even when there is no main saved profile (no "No saved profile yet")', async () => {
    renderPage()
    expect(await screen.findByText('Product roles')).toBeTruthy()
    expect(screen.queryByText(/No saved profile yet/)).toBeNull()
  })
  it('download asks the server for that profile as a blob', async () => {
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: '.docx' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/profile/download-docx', { params: { profileId: 'p1' }, responseType: 'blob' }))
  })
  it('rename sends only the label', async () => {
    api.put.mockResolvedValue({ data: { success: true } })
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const box = screen.getByLabelText('Profile name')
    await userEvent.clear(box); await userEvent.type(box, 'PM')
    await userEvent.click(within(box.closest('form')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/profile/extras/p1', { label: 'PM' }))
  })
  it('remove asks first, then deletes and reloads', async () => {
    api.delete.mockResolvedValue({ data: { success: true } })
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(api.delete).not.toHaveBeenCalled()
    extras = []
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/profile/extras/p1'))
  })
  it('Edit mounts the editor for that profile only', async () => {
    renderPage()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect((await screen.findByTestId('editor')).textContent).toBe('p1')
  })
})
