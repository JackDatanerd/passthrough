// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import DashboardIndex from '../../src/pages/dashboard/Index'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
const auth = { user: null, refreshUser: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))
vi.mock('../../src/components/account/OutcomeCard', () => ({ default: () => null }))
vi.mock('../../src/components/scan/ScanForm', () => ({ default: () => <div>scan form</div> }))

// The welcome offer on the dashboard (it used to live only in the email and the checkout banner), and the teaser that tells an
// unverified account it is waiting behind verification.
const OLD = new Date(Date.now() - 30 * 864e5).toISOString()
const offer = { code: 'FN-7K2QH', percentOff: 30, amountCents: 2030, listAmountCents: 2900, currency: 'USD', tier: 'FIX', expiresAt: new Date(Date.now() + 5 * 864e5).toISOString() }

function wire({ welcome = offer, pricing = { welcomePercentOff: 30 } } = {}) {
  api.get.mockImplementation(async url => {
    if (url === '/profile/quota') return { data: { data: { quota: { limit: 3, used: 0, remaining: 3 } } } }
    if (url === '/scan/history') return { data: { data: { scans: [], total: 0 } } }
    if (url === '/pricing/welcome-offer') return { data: { data: { offer: welcome } } }
    if (url.startsWith('/pricing')) return { data: { data: { currency: 'USD', serverTime: Date.now(), tiers: [], ...pricing } } }
    throw new Error('unexpected ' + url)
  })
}
const renderIndex = () => render(<MemoryRouter initialEntries={['/dashboard']}><DashboardIndex /></MemoryRouter>)
beforeEach(() => { api.get.mockReset() })

describe('dashboard welcome offer', () => {
  it('shows a verified account its offer: percentage, price, expiry, the code to copy, and that it applies itself', async () => {
    auth.user = { id: 'u1', emailVerified: true, createdAt: OLD }
    wire()
    renderIndex()
    const card = await screen.findByTestId('welcome-offer-card')
    expect(within(card).getByRole('heading')).toHaveTextContent('30% off your first full fix')
    expect(card).toHaveTextContent('$20.30 instead of $29')
    expect(card).toHaveTextContent(/applied for you at checkout/)
    expect(within(card).getByTestId('welcome-offer-code')).toHaveTextContent('FN-7K2QH')
    expect(within(card).getByRole('button', { name: 'Scan a resume' })).toBeInTheDocument()
  })
  it('shows nothing when the account has no offer', async () => {
    auth.user = { id: 'u1', emailVerified: true, createdAt: OLD }
    wire({ welcome: null })
    renderIndex()
    await screen.findByText(/No scans yet/)
    expect(screen.queryByTestId('welcome-offer-card')).toBeNull()
  })
  it('an unverified account sees the teaser in the verification banner, not the card', async () => {
    auth.user = { id: 'u1', emailVerified: false, createdAt: new Date().toISOString() }
    wire({ welcome: null })
    renderIndex()
    expect(await screen.findByText(/Verifying also unlocks 30% off your first full fix/)).toBeInTheDocument()
    expect(screen.queryByTestId('welcome-offer-card')).toBeNull()
  })
})
