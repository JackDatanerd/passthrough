// @vitest-environment jsdom
// Section 4 round 16: channel tags on the partner dashboard (share-link tag, sales by tag, tag on each sale and in the CSV).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))

const code = { id: 'rc1', code: 'COACH', active: true, tierPrices: { FIX: 1900 }, usageLimit: null, usesSoFar: 0, clicks: 3, expiresAt: null, createdAt: '2026-09-01T00:00:00Z' }
const cv = (id, sub) => ({ id, code: 'COACH', sub, grossAmountCents: 1000, commissionRate: 0.2, commissionAmountCents: 200, paid: false, isReversal: false, createdAt: '2026-09-10T10:00:00Z' })
const base = {
  name: 'K', active: true, commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, scope: 'dashboard',
  stats: { totalClicks: 3, totalConversions: 2, pendingCents: 400, paidCents: 0 }, referralCodes: [code], payouts: [], cyclesSummary: [],
  olderUnpaidCents: 0, carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0, readyToPayCents: 0, creditCents: 0,
  trend: [], attributionMix: { link: 2, typed: 0, account: 0, unknown: 0 },
  subMix: [{ sub: 'newsletter', sales: 2, commissionCents: 400 }],
  conversions: [cv('c1', 'newsletter'), cv('c2', null)], conversionsTotal: 2,
}
beforeEach(() => { cleanup(); api.get.mockReset(); api.get.mockResolvedValue({ data: { data: base } }) })
const mount = () => render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)

describe('channel tags', () => {
  it('lists sales by tag and shows the tag on a tagged sale only', async () => {
    mount()
    expect((await screen.findByTestId('partner-sub-mix')).textContent).toMatch(/newsletter 2/)
    const tags = screen.getAllByTestId('conversion-sub')
    expect(tags).toHaveLength(1)
    expect(tags[0].textContent).toBe('#newsletter')
  })
  it('adds a valid tag to the share link, lower-cased, and leaves an invalid one off with a hint', async () => {
    mount()
    const input = await screen.findByTestId('share-sub-input')
    const link = () => screen.getByDisplayValue(/\?ref=COACH/)
    expect(link().value).toMatch(/\/\?ref=COACH$/)
    fireEvent.change(input, { target: { value: 'YouTube_Ep-4' } })
    expect(link().value).toMatch(/\?ref=COACH&sub=youtube_ep-4$/)
    fireEvent.change(input, { target: { value: 'two words' } })
    expect(link().value).not.toMatch(/sub=/)
    expect(screen.getByTestId('share-sub-hint').textContent).toMatch(/left off the link/)
  })
})
