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
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'J', email: 'j@x.com', emailVerified: true }, setUser: vi.fn(), refreshUser: vi.fn(), logout: vi.fn() }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/SessionsCard', () => ({ default: () => null }))

// Profile & Dashboard round 6: a multi-part export chains parts by the server's keyset cursor so
// a scan deleted between downloads cannot be lost; without cursors it behaves as before.
const part = (parts, cursor) => ({ data: new Blob(['{}']), headers: { 'x-export-parts': String(parts), ...(cursor ? { 'x-export-cursor': cursor } : {}) } })
const exportCalls = () => api.get.mock.calls.filter(c => c[0] === '/profile/export')

beforeEach(() => {
  for (const m of [api.get, api.post, api.patch, api.put, api.delete]) m.mockReset()
  URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn()
  HTMLAnchorElement.prototype.click = vi.fn()
  api.get.mockImplementation(async (url, cfg) => {
    if (url === '/profile') return { data: { data: { hasSavedProfile: false, preferences: { notifyScanResults: true } } } }
    if (url === '/profile/export') return exportImpl(cfg.params)
    throw new Error('unexpected ' + url)
  })
})
let exportImpl
const renderPage = () => render(<MemoryRouter><Settings /></MemoryRouter>)
const partBtn = n => screen.getByRole('button', { name: new RegExp(`Part ${n} of`) })

describe('Settings — multi-part export', () => {
  it('chains the parts by cursor: each later part is requested with the cursor the previous one returned, and unlocks only once its predecessor is downloaded', async () => {
    exportImpl = ({ part: p }) => p === 1 ? part(3, 'C1|id1') : p === 2 ? part(3, 'C2|id2') : part(3)
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Download my data' }))
    await screen.findByRole('button', { name: /Part 2 of/ })
    expect(exportCalls()[0][1].params).toEqual({ part: 1 })
    expect(partBtn(2)).toBeEnabled()
    expect(partBtn(3)).toBeDisabled()                       // cursor for part 3 not known yet
    await userEvent.click(partBtn(2))
    await waitFor(() => expect(partBtn(3)).toBeEnabled())
    expect(exportCalls()[1][1].params).toEqual({ part: 2, cursor: 'C1|id1' })
    await userEvent.click(partBtn(3))
    await waitFor(() => expect(exportCalls()).toHaveLength(3))
    expect(exportCalls()[2][1].params).toEqual({ part: 3, cursor: 'C2|id2' })
  })
  it('downloading part 1 again starts the chain over', async () => {
    exportImpl = ({ part: p }) => p === 1 ? part(3, `C-run${exportCalls().length}|id`) : part(3, 'Cx|id')
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Download my data' }))
    await screen.findByRole('button', { name: /Part 2 of/ })
    await userEvent.click(partBtn(2))
    await waitFor(() => expect(partBtn(3)).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Download part 1 again' }))
    await waitFor(() => expect(partBtn(3)).toBeDisabled())  // part 3's cursor is forgotten with the old chain
  })
  it('a server that sends no cursor (hidden header) keeps the old behaviour: every part available, offset paging', async () => {
    exportImpl = ({ part: p }) => part(3)
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Download my data' }))
    await screen.findByRole('button', { name: /Part 2 of/ })
    expect(partBtn(2)).toBeEnabled(); expect(partBtn(3)).toBeEnabled()
    await userEvent.click(partBtn(3))
    await waitFor(() => expect(exportCalls()).toHaveLength(2))
    expect(exportCalls()[1][1].params).toEqual({ part: 3 })
  })
  it('the copy no longer claims the resume TEXT is included', async () => {
    exportImpl = () => part(1)
    renderPage()
    const para = await screen.findByText(/Download a copy of what we hold/)
    expect(para).toHaveTextContent(/structured data extracted from your resumes/)
    expect(para).not.toHaveTextContent(/text and structured data/)
    expect(para).toHaveTextContent(/emails we've sent you at your current address/)
  })
})
