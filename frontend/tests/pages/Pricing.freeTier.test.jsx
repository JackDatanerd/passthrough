// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

// Payments & Pricing round 3, G2: the free-tier limits come from /api/pricing, not hardcoded copy.
// usePricing's cache is module-level, so each test gets a fresh module graph.
let api, Pricing
beforeEach(async () => {
  vi.resetModules()
  api = (await import('../../src/lib/api')).default
  Pricing = (await import('../../src/pages/Pricing')).default
  api.get.mockReset()
})
const tiers = [{ tier: 'FIX', amount: 4900, originalAmount: 4900 }, { tier: 'BADGE', amount: 3900, originalAmount: 3900 }, { tier: 'FIX_PLAIN', amount: 3900, originalAmount: 3900 }]

describe('Pricing — free-tier copy', () => {
  it('shows the limits the server reports', async () => {
    api.get.mockResolvedValue({ data: { data: { tiers, currency: 'USD', freeScansPerDay: 5, anonScansPerHour: 2, serverTime: Date.now() } } })
    render(<MemoryRouter><Pricing /></MemoryRouter>)
    expect(await screen.findByText(/2 scans\/hour with no account, or 5\/day with a free account/)).toBeInTheDocument()
  })

  it('falls back to the mirrored defaults before / without a response', async () => {
    api.get.mockRejectedValue(new Error('offline'))
    render(<MemoryRouter><Pricing /></MemoryRouter>)
    expect(await screen.findByText(/1 scan\/hour with no account, or 3\/day with a free account/)).toBeInTheDocument()
  })
})
