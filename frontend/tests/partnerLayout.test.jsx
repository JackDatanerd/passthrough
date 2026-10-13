// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerLayout from '../src/components/partner/PartnerLayout'
import PartnerDashboard from '../src/pages/PartnerDashboard'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

// The partner pages are reached by a private link, so they carry a header of their own (logo, "Partners", the partner's
// name and a strip that jumps to each section) instead of the public site's, and the dashboard lays its sections out in
// two columns from lg with the codes (what you share) ahead of the ledger on a phone.
const SECTIONS = [{ id: 'overview', label: 'Overview' }, { id: 'earnings', label: 'Earnings' }]
const renderLayout = props => render(<MemoryRouter><PartnerLayout {...props}><p>body</p></PartnerLayout></MemoryRouter>)

describe('PartnerLayout', () => {
  afterEach(cleanup)

  it('has its own header: the logo to the homepage, a Partners label, and none of the public site\'s links', () => {
    renderLayout({ name: 'Coach K' })
    const header = within(screen.getByRole('banner'))
    expect(header.getByRole('link', { name: /Passthrough/ })).toHaveAttribute('href', '/')
    expect(header.getByText('Partners')).toBeInTheDocument()
    for (const name of ['Stories', 'Hot categories', 'Pricing', 'For employers', 'Log in', 'Dashboard']) {
      expect(header.queryByRole('link', { name })).toBeNull()
    }
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('shows who is looking: an initial, and the name beside it', () => {
    renderLayout({ name: 'coach k' })
    expect(screen.getByText('C')).toBeInTheDocument()
    expect(screen.getByText('coach k')).toBeInTheDocument()
  })

  it('has a section strip only when it is given sections, each one an anchor, the first marked as current', () => {
    const { unmount } = renderLayout({ name: 'A' })
    expect(screen.queryByRole('navigation', { name: 'Dashboard sections' })).toBeNull()
    unmount()
    renderLayout({ name: 'A', sections: SECTIONS })
    const nav = screen.getByRole('navigation', { name: 'Dashboard sections' })
    const links = within(nav).getAllByRole('link')
    expect(links.map(a => [a.textContent, a.getAttribute('href')])).toEqual([['Overview', '#overview'], ['Earnings', '#earnings']])
    expect(links[0]).toHaveAttribute('aria-current', 'true')
    expect(links[1]).not.toHaveAttribute('aria-current')
  })

  it('marks the section you jump to as current', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    renderLayout({ name: 'A', sections: SECTIONS })
    await userEvent.click(screen.getByRole('link', { name: 'Earnings' }))
    expect(screen.getByRole('link', { name: 'Earnings' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
  })

  it('has a skip link and a main landmark', () => {
    renderLayout({ name: 'A' })
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main')
  })
})

describe('PartnerDashboard layout', () => {
  beforeEach(() => { cleanup(); api.get.mockReset() })
  const data = {
    name: 'Coach K', active: true, commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, scope: 'dashboard',
    stats: { totalClicks: 4, totalConversions: 1, pendingCents: 1200, paidCents: 0 },
    referralCodes: [{ id: 'c1', code: 'COACH', active: true, tierPrices: { FIX: 2900 }, clicks: 4, usesSoFar: 1 }],
    conversions: [], conversionsTotal: 0, payouts: [], cyclesSummary: [{ key: 'k', label: 'Oct 1–15', isCurrent: true, ledgerCount: 1, commissionCents: 1200, paidCents: 0, unpaidCents: 1200, heldCents: 0 }],
    olderUnpaidCents: 0, carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0,
  }
  const mount = () => {
    api.get.mockResolvedValue({ data: { data: data } })
    return render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
  }

  it('shows the partner header with a strip that jumps to the five sections, each of which exists on the page', async () => {
    mount()
    await screen.findByText(/Coach K's Passthrough dashboard/)
    const nav = screen.getByRole('navigation', { name: 'Dashboard sections' })
    const hrefs = within(nav).getAllByRole('link').map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['#overview', '#earnings', '#codes', '#payouts', '#settings'])
    for (const href of hrefs) expect(document.getElementById(href.slice(1))).not.toBeNull()
  })

  it('puts the codes ahead of the ledger on a phone (page order), and the right-hand column is where lg puts them', async () => {
    mount()
    await screen.findByText(/Coach K's Passthrough dashboard/)
    const codes = document.getElementById('codes')
    const earnings = document.getElementById('earnings')
    expect(codes.compareDocumentPosition(earnings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(codes.parentElement.className).toContain('lg:col-start-3')
    expect(earnings.parentElement.className).toContain('lg:col-span-2')
  })

  it('keeps the settings (email per sale, reset links) in the right-hand column, and the payout history under the earnings', async () => {
    mount()
    await screen.findByText(/Coach K's Passthrough dashboard/)
    const settings = document.getElementById('settings')
    expect(within(settings).getByTestId('notification-prefs')).toBeInTheDocument()
    expect(within(settings).getByTestId('reset-links')).toBeInTheDocument()
    expect(within(document.getElementById('payouts')).getByText('No payouts yet.')).toBeInTheDocument()
    expect(within(document.getElementById('earnings')).getByText('Payout cycles')).toBeInTheDocument()
  })

  it('has no narrow single column any more', async () => {
    mount()
    await screen.findByText(/Coach K's Passthrough dashboard/)
    expect(document.querySelector('.max-w-3xl')).toBeNull()
    expect(document.querySelector('.lg\\:grid-cols-3')).not.toBeNull()
  })
})

describe('Earnings by cycle chart', () => {
  beforeEach(() => { cleanup(); api.get.mockReset() })
  const base = {
    name: 'Coach K', active: true, commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, scope: 'dashboard',
    stats: { totalClicks: 4, totalConversions: 3, pendingCents: 1200, paidCents: 0 },
    referralCodes: [], conversions: [], conversionsTotal: 0, payouts: [], cyclesSummary: [], olderUnpaidCents: 0,
    carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0,
  }
  const trend = [
    { key: 'a', label: 'Sep 1–15', isCurrent: false, commissionCents: 2000, sales: 2 },
    { key: 'b', label: 'Sep 16–30', isCurrent: false, commissionCents: -500, sales: 0 },
    { key: 'c', label: 'Oct 1–15', isCurrent: true, commissionCents: 1000, sales: 1 },
  ]
  const mount = extra => {
    api.get.mockResolvedValue({ data: { data: { ...base, trend, ...extra } } })
    return render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
  }

  it('draws one column per cycle with its amount, label and sales, the current one marked "so far"', async () => {
    mount()
    const chart = await screen.findByRole('list', { name: 'Earnings by cycle' })
    expect(within(chart).getAllByRole('listitem')).toHaveLength(3)
    expect(within(chart).getByText('$20.00')).toBeInTheDocument()
    expect(within(chart).getByText('-$5.00')).toBeInTheDocument()
    const details = within(screen.getByRole('list', { name: 'Cycle details' }))
    expect(details.getByText('Oct 1–15 (so far)')).toBeInTheDocument()
    expect(details.getByText('2 sales')).toBeInTheDocument()
    expect(details.getByText('1 sale')).toBeInTheDocument()
  })

  it('scales the columns to the biggest cycle, shows a negative cycle in red and the current one darker', async () => {
    mount()
    const chart = await screen.findByRole('list', { name: 'Earnings by cycle' })
    const bars = [...chart.querySelectorAll('[aria-hidden="true"]')]
    expect(bars.map(b => b.style.height)).toEqual(['100%', '25%', '50%'])
    expect(bars[1].className).toContain('bg-red-400')
    expect(bars[2].className).toContain('bg-blue-700')
    expect(bars[0].className).toContain('bg-blue-400')
  })

  it('is left out when there is nothing to chart, and still shows how buyers reached the code', async () => {
    mount({ trend: [{ key: 'a', label: 'Sep 1–15', isCurrent: false, commissionCents: 0, sales: 0 }], attributionMix: { link: 3, typed: 1 } })
    await screen.findByText(/Coach K's Passthrough dashboard/)
    expect(screen.queryByRole('list', { name: 'Earnings by cycle' })).toBeNull()
    expect(screen.getByTestId('partner-attribution-mix')).toHaveTextContent('Shared link 3 · Typed the code 1')
  })
})
