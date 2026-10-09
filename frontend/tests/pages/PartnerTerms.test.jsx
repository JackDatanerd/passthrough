// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import PartnerTerms from '../../src/pages/PartnerTerms'

// Section 4 round 6: the program's terms page. The numbers come from the server so they cannot drift from what the
// payout run enforces; when the request fails the page still renders and does not invent figures.
const h = vi.hoisted(() => ({ impl: null }))
vi.mock('../../src/lib/api', () => ({ default: { get: (...a) => h.impl(...a) } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

const renderIt = () => render(<MemoryRouter><PartnerTerms /></MemoryRouter>)
const program = (over = {}) => ({ termsVersion: '2026-10', currency: 'USD', holdDays: 14, minPayoutCents: 2500, payoutDetailsHoldHours: 48, reapplyCooldownDays: 30, ...over })
beforeEach(() => { h.impl = () => Promise.resolve({ data: { success: true, data: program() } }) })

describe('PartnerTerms', () => {
  it('states the live hold, minimum, details-change hold and reapply cooldown from the server', async () => {
    renderIt()
    const page = await screen.findByTestId('partner-terms')
    await screen.findByText(/version 2026-10/i)
    expect(page).toHaveTextContent('held for 14 days')
    expect(page).toHaveTextContent('below $25.00 are carried forward')
    expect(page).toHaveTextContent('at least 48 hours')
    expect(page).toHaveTextContent('after 30 days')
  })

  it('says there is no hold / minimum when the server says zero, instead of staying silent', async () => {
    h.impl = () => Promise.resolve({ data: { success: true, data: program({ holdDays: 0, minPayoutCents: 0, payoutDetailsHoldHours: 0 }) } })
    renderIt()
    await screen.findByText(/version 2026-10/i)
    expect(screen.getByTestId('partner-terms')).toHaveTextContent('no extra holding period')
    expect(screen.getByTestId('partner-terms')).toHaveTextContent('no minimum payout amount')
  })

  it('still renders, with no invented figures, when the program request fails', async () => {
    h.impl = () => Promise.reject(new Error('down'))
    renderIt()
    const page = await screen.findByTestId('partner-terms')
    expect(page).toHaveTextContent('Partner Program Terms')
    expect(page).toHaveTextContent('your dashboard shows what is being held')
    expect(page).not.toHaveTextContent(/held for \d+ day/)
  })

  it('carries the shared attribution terms and links back to the application', async () => {
    renderIt()
    const page = await screen.findByTestId('partner-terms')
    expect(page).toHaveTextContent(/30 days after their most recent click/)
    expect(screen.getByRole('link', { name: /apply to become a partner/i })).toHaveAttribute('href', '/partner/apply')
  })
})
