// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import DashboardIndex from '../../src/pages/dashboard/Index'
import Settings from '../../src/pages/dashboard/Settings'
import { resetNeedsDecision } from '../../src/lib/needsDecision'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'J', email: 'j@x.com', emailVerified: true, freeFixCredits: 0 }, setUser: vi.fn(), refreshUser: vi.fn(), logout: vi.fn() }),
}))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/OutcomeCard', () => ({ default: () => null }))
vi.mock('../../src/components/account/SessionsCard', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ScanForm', () => ({ default: () => <div>scan form</div> }))

// Profile & Dashboard round 13.
//  B8: the dashboard reads its free-scan counter from /profile/quota, not /profile (which also reads every saved resume).
//  B5: "Delete my scan history" refreshes the Scans tab's count; Settings used to leave the old number up for a minute.

const QUOTA = { limit: 3, used: 1, remaining: 2, resetsAt: '2099-01-01T00:00:00.000Z' }
const SCAN = {
  id: 's1', status: 'COMPLETE_FAIL', atsScore: 60, fixPurchased: false, fixAtsScore: null, fixTier: null, fixRetryCount: 0,
  verificationCode: null, verificationStatus: null, verificationUrl: null, createdAt: '2026-10-01T10:00:00Z', updatedAt: new Date().toISOString(),
  jobTitle: 'Analyst', resumeOriginalName: 'cv.pdf', keywordScore: 40, formatScore: 80, sectionsScore: 70, contentScore: 60,
}
beforeEach(() => { for (const m of [api.get, api.post, api.patch, api.put, api.delete]) m.mockReset(); resetNeedsDecision() })

describe('B8: the dashboard asks for the quota alone', () => {
  it('calls /profile/quota, never /profile, and shows the allowance', async () => {
    api.get.mockImplementation(async (url) => {
      if (url === '/profile/quota') return { data: { data: { quota: QUOTA } } }
      if (url === '/scan/history') return { data: { data: { scans: [SCAN], total: 1 } } }
      throw new Error('unexpected ' + url)
    })
    render(<MemoryRouter><DashboardIndex /></MemoryRouter>)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/profile/quota'))
    expect(api.get.mock.calls.some(c => c[0] === '/profile')).toBe(false)
    expect(await screen.findByText('Free scans today')).toBeInTheDocument()
    expect(screen.getByText('Free scans today').parentElement).toHaveTextContent(/2\s*of 3/)
  })
})

describe('B5: Settings refreshes the Scans tab count after deleting the history', () => {
  const countReads = () => api.get.mock.calls.filter(c => c[0] === '/scan/history' && c[1]?.params?.status === 'NEEDS_DECISION').length
  it('one forced read once the purge has finished', async () => {
    api.get.mockImplementation(async (url) => {
      if (url === '/profile') return { data: { data: { hasSavedProfile: false, extraProfiles: [], maxExtraProfiles: 4, preferences: { notifyScanResults: true, notifyOutcomeFollowup: true } } } }
      if (url === '/scan/history') return { data: { data: { scans: [], total: 0 } } }
      throw new Error('unexpected ' + url)
    })
    api.delete.mockResolvedValue({ data: { data: { deleted: 3, remaining: 0 } } })
    const user = userEvent.setup()
    render(<MemoryRouter><Settings /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Delete my scan history' }))
    const dlg = within(await screen.findByRole('dialog'))
    expect(countReads()).toBe(0)
    await user.click(dlg.getByRole('button', { name: 'Delete all scans' }))
    expect(await screen.findByText('Deleted 3 scans.')).toBeInTheDocument()
    await waitFor(() => expect(countReads()).toBe(1))
  })
  it('also after a purge that failed part-way, because some scans may be gone', async () => {
    api.get.mockImplementation(async (url) => {
      if (url === '/profile') return { data: { data: { hasSavedProfile: false, extraProfiles: [], maxExtraProfiles: 4, preferences: { notifyScanResults: true, notifyOutcomeFollowup: true } } } }
      if (url === '/scan/history') return { data: { data: { scans: [], total: 0 } } }
      throw new Error('unexpected ' + url)
    })
    api.delete.mockRejectedValue({ response: { status: 500, data: { message: 'boom' } } })
    const user = userEvent.setup()
    render(<MemoryRouter><Settings /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Delete my scan history' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete all scans' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/)
    await waitFor(() => expect(countReads()).toBe(1))
  })
})
