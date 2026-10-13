// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import Settings from '../../src/pages/dashboard/Settings'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'J', email: 'j@x.com', emailVerified: true }, setUser: vi.fn(), refreshUser: vi.fn(), logout: vi.fn() }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/SessionsCard', () => ({ default: () => <div>devices</div> }))

// The Settings page used to be one narrow column (max-w-lg) with a long row of profile buttons that could not wrap and
// ran out of its card. It now uses the dashboard's full width: account and security in two columns, the saved profile
// across the page with its actions on their own wrapping row, and the data tools after it.
const profile = (over = {}) => ({
  data: { data: {
    hasSavedProfile: true, savedAt: '2026-07-25T00:00:00Z', sourceScanId: 's1', editedAt: null, preferences: {},
    summary: { name: 'Robinson Wycliffe Francis', latestTitle: 'AI Training Specialist — Mathematics & Physics QA', jobCount: 4, educationCount: 4, skillCount: 30 },
    extraProfiles: [{ id: 'p1', label: 'Teaching', savedAt: '2026-08-01T00:00:00Z', summary: { name: 'R', jobCount: 2 } }, { id: 'p2', label: 'Data', savedAt: '2026-08-02T00:00:00Z', summary: { name: 'R', jobCount: 1 } }],
    maxExtraProfiles: 3, ...over,
  } },
})
beforeEach(() => {
  for (const m of [api.get, api.post, api.patch, api.put, api.delete]) m.mockReset()
  api.get.mockImplementation(async url => { if (url === '/profile') return profile(); throw new Error('unexpected ' + url) })
})
const renderPage = () => render(<MemoryRouter><Settings /></MemoryRouter>)

describe('Settings layout', () => {
  it('is no longer squeezed into one narrow column', async () => {
    const { container } = renderPage()
    await screen.findByText('Saved profile')
    expect(container.querySelector('.max-w-lg')).toBeNull()
    expect(container.querySelector('.lg\\:grid-cols-2')).not.toBeNull()
  })

  it('keeps the saved profile\'s actions on their own row that wraps, so they can never run out of the card', async () => {
    renderPage()
    const scan = await screen.findByRole('link', { name: 'Scan against a new job' })
    const actions = scan.parentElement
    expect(actions.className).toContain('flex-wrap')
    expect(actions.className).not.toContain('shrink-0')
    // all six actions are in that one row, and the summary text is not beside it
    for (const name of ['Edit', 'Copy as another profile', 'Download .docx', 'Download PDF', 'Remove saved profile']) {
      expect(within(actions).getByRole('button', { name })).toBeInTheDocument()
    }
    expect(within(actions).queryByText(/Latest role/)).toBeNull()
    expect(screen.getByText(/Latest role: AI Training Specialist/)).toBeInTheDocument()
  })

  it('lays the other profiles out as cards in a grid, each with wrapping actions', async () => {
    renderPage()
    const heading = await screen.findByText('Other profiles')
    const list = heading.parentElement.querySelector('ul')
    expect(list.className).toContain('md:grid-cols-2')
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    const scanWith = within(list).getAllByRole('link', { name: 'Scan with this' })[0]
    expect(scanWith.parentElement.className).toContain('flex-wrap')
  })

  it('groups the page: account and security, saved profiles, your data', async () => {
    renderPage()
    await screen.findByText('Saved profile')
    for (const label of ['Account and security', 'Saved profiles', 'Your data']) {
      expect(screen.getAllByText(label).some(el => el.tagName === 'P')).toBe(true)
    }
    for (const card of ['Account', 'Change password', 'Sign out other sessions', 'Your data', 'Scan history', 'Danger zone']) {
      expect(screen.getAllByRole('heading', { name: card }).length).toBeGreaterThan(0)
    }
  })
})
