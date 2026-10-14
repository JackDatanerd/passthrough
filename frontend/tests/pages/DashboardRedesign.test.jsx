// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import DashboardIndex from '../../src/pages/dashboard/Index'
import Proof from '../../src/pages/dashboard/Proof'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
const auth = { user: { emailVerified: true, freeFixCredits: 1 }, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/OutcomeCard', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ScanForm', () => ({ default: () => <div>scan form</div> }))

// The redesigned dashboard: next step, stats, rows with stages and messages, the breakdown, and the Proof page.
const recent = new Date().toISOString()
const scan = (id, over = {}) => ({
  id, status: 'COMPLETE_FAIL', atsScore: 60, fixPurchased: false, fixAtsScore: null, fixTier: null, fixRetryCount: 0,
  verificationCode: null, verificationStatus: null, verificationUrl: null, createdAt: '2026-10-01T10:00:00Z', updatedAt: recent,
  jobTitle: `Job ${id}`, resumeOriginalName: 'cv.pdf', keywordScore: 40, formatScore: 80, sectionsScore: 70, contentScore: 60, ...over,
})
const QUOTA = { limit: 3, used: 1, remaining: 2, resetsAt: '2026-10-13T00:00:00.000Z' }

function wire({ scans, overview = scans, profile = { quota: QUOTA }, total } = {}) {
  api.get.mockImplementation(async (url, cfg) => {
    if (url === '/profile/quota') return { data: { data: profile } }
    if (url === '/scan/history') {
      const list = cfg?.params?.limit === 100 ? overview : scans
      return { data: { data: { scans: list, total: cfg?.params?.limit === 100 ? overview.length : (total ?? scans.length) } } }
    }
    throw new Error('unexpected ' + url)
  })
}
const renderIndex = (path = '/dashboard') => render(<MemoryRouter initialEntries={[path]}><DashboardIndex /></MemoryRouter>)
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.delete.mockReset() })

describe('next step card', () => {
  it('leads with the scan closest to the credential and says how far it is', async () => {
    wire({ scans: [scan('far', { status: 'COMPLETE_PASS', atsScore: 76 }), scan('near', { status: 'COMPLETE_PASS', atsScore: 79 })] })
    renderIndex()
    const card = await screen.findByRole('region', { name: 'Next step' })
    expect(within(card).getByRole('heading')).toHaveTextContent('Job near is 1 point from a verified credential')
    expect(within(card).getByRole('link', { name: /Fix with a free credit/ })).toHaveAttribute('href', '/scan/near')
    expect(within(card).getByText(/Job far/)).toBeInTheDocument()   // the "also" row
  })
  it('a scan that is paid for and being written gets no Fix button, in the card or in its row', async () => {
    wire({ scans: [scan('p', { status: 'FIX_PURCHASED', fixPurchased: true })] })
    renderIndex()
    const row = await screen.findByTestId('scan-row')
    expect(within(row).getByText('Payment received')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Fix/ })).toBeNull()
    expect(screen.getByRole('heading', { name: /Writing the fix for Job p/ })).toBeInTheDocument()
  })
  it('shows nothing before there are scans, and "All caught up" when every scan has a plan', async () => {
    wire({ scans: [] })
    const { unmount } = renderIndex()
    await screen.findByText(/No scans yet/)
    expect(screen.queryByRole('region', { name: 'Next step' })).toBeNull()
    unmount()
    wire({ scans: [scan('d', { status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 88, verificationCode: 'ABC' })] })
    renderIndex()
    expect(await screen.findByText('All caught up')).toBeInTheDocument()
  })
})

describe('rows', () => {
  it('shows the stage tracker, the message and the right action for a delivered, verified scan', async () => {
    wire({ scans: [scan('v', { status: 'FIX_DELIVERED', atsScore: 48, fixPurchased: true, fixAtsScore: 88, verificationCode: 'ABC', verificationUrl: 'https://passthrough.dev/v/ABC' })] })
    renderIndex()
    const row = await screen.findByTestId('scan-row')
    expect(within(row).getAllByText('✓ Verified')).toHaveLength(2)   // the last stage, and the status tag
    expect(within(row).getByText(/48 → 88/)).toBeInTheDocument()
    const stages = within(row).getByRole('list', { name: 'Progress' })
    expect(within(stages).getAllByText(/done/)).toHaveLength(3)
    expect(within(row).getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
  })
  it('a revoked link is not shown as verified and cannot be copied', async () => {
    wire({ scans: [scan('r', { status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 90, verificationCode: 'ABC', verificationStatus: 'REVOKED' })] })
    renderIndex()
    const row = await screen.findByTestId('scan-row')
    expect(within(row).getByText('Verification removed')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Copy link' })).toBeNull()
  })
  it('free retries left are named, and the action links to the scan page where the retry runs', async () => {
    wire({ scans: [scan('f', { status: 'FIX_DELIVERED', atsScore: 55, fixPurchased: true, fixAtsScore: 78, fixTier: 'FIX', fixRetryCount: 1 })] })
    renderIndex()
    const row = await screen.findByTestId('scan-row')
    expect(within(row).getByText(/1 free retry left/)).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Use a free retry' })).toHaveAttribute('href', '/scan/f')
  })
  it('the breakdown opens from the row menu with the four category scores and a link to the full report', async () => {
    const user = userEvent.setup()
    wire({ scans: [scan('b')] })
    renderIndex()
    await screen.findByText('Job b')
    await user.click(screen.getByRole('button', { name: 'More actions for Job b' }))
    await user.click(screen.getByRole('menuitem', { name: 'See the breakdown' }))
    const dlg = within(await screen.findByRole('dialog'))
    for (const label of ['Keywords', 'Formatting', 'Sections', 'Content']) expect(dlg.getByText(label)).toBeInTheDocument()
    expect(dlg.getByRole('link', { name: 'Open the full report' })).toHaveAttribute('href', '/scan/b')
  })
})

describe('stats and the summary', () => {
  it('reads the newest scans separately from the page, so filters do not change it', async () => {
    wire({ scans: [scan('x', { atsScore: 41 })], overview: [scan('x', { atsScore: 41 }), scan('y', { status: 'COMPLETE_PASS', atsScore: 83 })] })
    renderIndex('/dashboard?status=ERROR')
    expect(await screen.findByText('Best score')).toBeInTheDocument()
    expect(screen.getByText('83')).toBeInTheDocument()
    const summaryCall = api.get.mock.calls.find(c => c[1]?.params?.limit === 100)
    expect(summaryCall[1].params.status).toBeUndefined()
  })
  it('chip counts appear when every scan fits in the summary, and are left out when it is cut off', async () => {
    wire({ scans: [scan('a')], overview: [scan('a'), scan('b', { status: 'ERROR', atsScore: null })] })
    const { unmount } = renderIndex()
    expect(await screen.findByRole('button', { name: /^Didn't finish\s*1$/ })).toBeInTheDocument()
    unmount()
    api.get.mockImplementation(async (url, cfg) => {
      if (url === '/profile/quota') return { data: { data: {} } }
      return { data: { data: { scans: [scan('a')], total: cfg?.params?.limit === 100 ? 250 : 250 } } }
    })
    renderIndex()
    await screen.findByText('Job a')
    expect(screen.queryByRole('button', { name: /^All\s*\d/ })).toBeNull()
  })
  it('"Delete these N" is not offered for the In progress chip alone (the server keeps live scans)', async () => {
    wire({ scans: [scan('a', { status: 'SCANNING' })], total: 4 })
    renderIndex('/dashboard?status=IN_PROGRESS')
    await screen.findByText('Job a')
    expect(screen.queryByRole('button', { name: /Delete these/ })).toBeNull()
  })
})

describe('new scan panel', () => {
  it('opens the real scan form in place', async () => {
    const user = userEvent.setup()
    wire({ scans: [scan('a')] })
    renderIndex()
    await screen.findByText('Job a')
    expect(screen.queryByText('scan form')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'New scan' }))
    expect(await screen.findByText('scan form')).toBeInTheDocument()
  })
})

describe('Proof page', () => {
  const renderProof = () => render(<MemoryRouter><Proof /></MemoryRouter>)
  it('lists Verified links with copy buttons and the scans that are close', async () => {
    wire({ scans: [
      scan('v', { status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 88, verificationCode: 'ABC', verificationUrl: 'https://passthrough.dev/v/ABC' }),
      scan('revoked', { status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 90, verificationCode: 'XYZ', verificationStatus: 'REVOKED' }),
      scan('near', { status: 'COMPLETE_PASS', atsScore: 78 }),
    ] })
    renderProof()
    expect(await screen.findByText('https://passthrough.dev/v/ABC')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Copy link' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Copy badge HTML' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View as an employer' })).toHaveAttribute('href', '/v/ABC')
    const almost = within(screen.getByRole('region', { name: 'Almost there' }))
    expect(almost.getByText(/Job near/)).toBeInTheDocument()
    expect(almost.getByText(/2 points away/)).toBeInTheDocument()
  })
  it('says so when there are none, and a failed load can be retried', async () => {
    wire({ scans: [scan('a')] })
    const { unmount } = renderProof()
    expect(await screen.findByText(/No Verified links yet/)).toBeInTheDocument()
    unmount()
    api.get.mockRejectedValueOnce({ response: { data: { message: 'down' } } })
    renderProof()
    expect(await screen.findByRole('alert')).toHaveTextContent('down')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText(/No Verified links yet/)).toBeInTheDocument())
  })
})
