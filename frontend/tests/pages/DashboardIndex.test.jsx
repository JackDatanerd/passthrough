// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import DashboardIndex from '../../src/pages/dashboard/Index'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
const refreshUser = vi.fn()
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { emailVerified: true, freeFixCredits: 0 }, refreshUser }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))

// Profile & Dashboard round 5: quota line, an invalid ?status= is no filter, and a delete that
// finds the scan already gone is not an error.
const scan = (id, over = {}) => ({
  id, status: 'COMPLETE_PASS', atsScore: 80, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z',
  jobTitle: `Job ${id}`, resumeOriginalName: 'cv.pdf', ...over,
})
const QUOTA = { limit: 3, used: 1, remaining: 2, resetsAt: '2026-10-06T00:00:00.000Z' }

function wire({ scans = [scan('a')], total, profile = { hasSavedProfile: false, quota: QUOTA } } = {}) {
  api.get.mockImplementation(async url => {
    if (url === '/profile') { if (profile instanceof Error) throw profile; return { data: { data: profile } } }
    if (url === '/scan/history') return { data: { data: { scans, total: total ?? scans.length } } }
    throw new Error('unexpected ' + url)
  })
}
const renderAt = (path = '/dashboard') => render(<MemoryRouter initialEntries={[path]}><DashboardIndex /></MemoryRouter>)
const historyCalls = () => api.get.mock.calls.filter(c => c[0] === '/scan/history')

beforeEach(() => { api.get.mockReset(); api.delete.mockReset(); refreshUser.mockReset() })

describe('dashboard — free-scan allowance', () => {
  it('shows how many scans are left today', async () => {
    wire(); renderAt()
    expect(await screen.findByTestId('scan-quota')).toHaveTextContent(/2 of 3 free scans left today/)
  })
  it('an exhausted allowance is called out', async () => {
    wire({ profile: { hasSavedProfile: false, quota: { ...QUOTA, used: 3, remaining: 0 } } }); renderAt()
    expect(await screen.findByTestId('scan-quota')).toHaveTextContent(/used all 3 free scans for today/)
  })
  it('shows nothing, and breaks nothing, when the profile read fails or has no quota', async () => {
    wire({ profile: new Error('down') }); renderAt()
    await screen.findByText('Job a')
    expect(screen.queryByTestId('scan-quota')).toBeNull()
  })
})

describe('dashboard — filters from the URL', () => {
  it('a hand-edited ?status=FOO is no filter at all: not sent, dropdown says All, no "clear filters" empty state', async () => {
    wire(); renderAt('/dashboard?status=FOO')
    await screen.findByText('Job a')
    expect(historyCalls()[0][1].params.status).toBeUndefined()
    expect(screen.getByLabelText('Status')).toHaveValue('')
  })
  it('a real status is sent and selected', async () => {
    wire(); renderAt('/dashboard?status=FIX_DELIVERED')
    await screen.findByText('Job a')
    expect(historyCalls()[0][1].params.status).toBe('FIX_DELIVERED')
    expect(screen.getByLabelText('Status')).toHaveValue('FIX_DELIVERED')
  })
})

describe('dashboard — deleting a scan', () => {
  async function openDelete(user) {
    await screen.findByText('Job a')
    await user.click(screen.getByRole('button', { name: /Delete Job a/ }))
    await user.click(screen.getByRole('button', { name: 'Delete scan' }))
  }
  it('a scan already deleted elsewhere (404) is not an error: the dialog closes and the list is re-read', async () => {
    const user = userEvent.setup()
    wire(); api.delete.mockRejectedValue({ response: { status: 404, data: { message: 'Scan not found.' } } })
    renderAt()
    await openDelete(user)
    await waitFor(() => expect(historyCalls().length).toBeGreaterThanOrEqual(2))
    expect(screen.queryByText('Scan not found.')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('any other failure is shown', async () => {
    const user = userEvent.setup()
    wire(); api.delete.mockRejectedValue({ response: { status: 409, data: { message: 'This scan is still being processed.' } } })
    renderAt()
    await openDelete(user)
    expect(await screen.findByText('This scan is still being processed.')).toBeInTheDocument()
  })
  it('success re-reads the list', async () => {
    const user = userEvent.setup()
    wire(); api.delete.mockResolvedValue({ data: { success: true } })
    renderAt()
    await openDelete(user)
    await waitFor(() => expect(historyCalls().length).toBeGreaterThanOrEqual(2))
    expect(api.delete).toHaveBeenCalledWith('/scan/a')
  })
})
