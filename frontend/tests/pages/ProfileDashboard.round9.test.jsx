// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router-dom'
import api from '../../src/lib/api'
import Settings from '../../src/pages/dashboard/Settings'
import DashboardIndex from '../../src/pages/dashboard/Index'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'J', email: 'j@x.com', emailVerified: true, freeFixCredits: 0 }, setUser: vi.fn(), refreshUser: vi.fn(), logout: vi.fn() }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/SessionsCard', () => ({ default: () => null }))
vi.mock('../../src/components/account/SavedProfileEditor', () => ({ default: ({ profileId }) => <div data-testid="editor">{profileId || 'primary'}</div> }))

// Profile & Dashboard round 9.
const extra = { id: 'p1', label: 'Product roles', savedAt: '2026-09-02T00:00:00Z', editedAt: null, version: 'v', sourceScanId: null, summary: { name: 'J', jobCount: 2 } }
const primary = { name: 'Jo', jobCount: 3, skillCount: 4, savedAt: '2026-09-01T00:00:00Z', editedAt: null, version: 'a|b' }
let profile
beforeEach(() => {
  for (const m of [api.get, api.post, api.patch, api.put, api.delete]) m.mockReset()
  profile = { hasSavedProfile: true, summary: primary, extraProfiles: [extra], maxExtraProfiles: 4, preferences: { notifyScanResults: true, notifyOutcomeFollowup: true } }
  api.get.mockImplementation(async url => {
    if (url === '/profile') return { data: { data: profile } }
    if (url === '/scan/history') return { data: { data: { scans: [
      { id: 's1', status: 'COMPLETE_PASS', atsScore: 80, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', jobTitle: 'Job one' },
      { id: 's2', status: 'ERROR', atsScore: null, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', jobTitle: 'Job two' },
    ], total: 2 } } }
    throw new Error('unexpected ' + url)
  })
  api.post.mockResolvedValue({ data: { success: true } })
  api.patch.mockResolvedValue({ data: { success: true } })
})
const renderSettings = () => render(<MemoryRouter><Settings /></MemoryRouter>)

describe('Settings — additional profile actions', () => {
  it('"Scan with this" deep-links the scan form to that profile', async () => {
    renderSettings()
    await screen.findByText('Product roles')
    expect(screen.getByRole('link', { name: 'Scan with this' }).getAttribute('href')).toBe('/scan?mode=savedProfile&profile=p1')
  })
  it('"Make main" posts the swap, then reloads the list', async () => {
    renderSettings()
    await screen.findByText('Product roles')
    const loads = api.get.mock.calls.filter(c => c[0] === '/profile').length
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/profile/extras/p1/make-main'))
    await waitFor(() => expect(api.get.mock.calls.filter(c => c[0] === '/profile').length).toBeGreaterThan(loads))
  })
  it('a failed swap says so and keeps the page', async () => {
    api.post.mockRejectedValueOnce({ response: { data: { message: 'Profile not found.' } } })
    renderSettings()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Make main' }))
    expect(await screen.findByText('Profile not found.')).toBeTruthy()
  })
  it('"Copy as another profile" posts to /profile/extras, and is hidden when the account is full', async () => {
    renderSettings()
    await screen.findByText('Product roles')
    await userEvent.click(screen.getByRole('button', { name: 'Copy as another profile' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/profile/extras', {}))
  })
  it('no copy button once the limit is reached', async () => {
    profile.extraProfiles = [extra, { ...extra, id: 'p2', label: 'B' }, { ...extra, id: 'p3', label: 'C' }, { ...extra, id: 'p4', label: 'D' }]
    renderSettings()
    await screen.findByText('Product roles')
    expect(screen.queryByRole('button', { name: 'Copy as another profile' })).toBeNull()
  })
})

describe('Settings — the two email switches', () => {
  it('the interview follow-up has its own checkbox and saves only its own key', async () => {
    renderSettings()
    const box = await screen.findByLabelText(/Ask me how it went after a fix/)
    await userEvent.click(box)
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/profile/preferences', { notifyOutcomeFollowup: false }))
    expect(screen.getByLabelText(/Email me when a scan finishes/).checked).toBe(true)
  })
  it('a failed save puts the checkbox back', async () => {
    api.patch.mockRejectedValueOnce({ response: { data: { message: 'nope' } } })
    renderSettings()
    const box = await screen.findByLabelText(/Ask me how it went after a fix/)
    await userEvent.click(box)
    expect(await screen.findByText('nope')).toBeTruthy()
    expect(box.checked).toBe(true)
  })
})

describe('Dashboard — rescan shortcut', () => {
  it('rows that can be rescanned link to /scan?from=<id>; failed scans do not', async () => {
    const router = createMemoryRouter([{ path: '/dashboard', element: <DashboardIndex /> }], { initialEntries: ['/dashboard'] })
    render(<RouterProvider router={router} />)
    await screen.findByText('Job one')
    // The shortcut lives in each row's "more actions" menu; a failed scan's menu has no such item.
    const user = userEvent.setup()
    const rows = screen.getAllByTestId('scan-row')
    const hrefs = []
    for (const row of rows) {
      await user.click(within(row).getByRole('button', { name: /More actions for/ }))
      const link = within(row).queryByRole('menuitem', { name: /against another job/ })
      hrefs.push(link ? link.getAttribute('href') : null)
    }
    expect(hrefs.filter(Boolean)).toEqual(['/scan?from=s1'])
  })
})
