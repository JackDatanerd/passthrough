// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

// Payments & Pricing round 4, G4: the paid cards' buttons depend on who is looking.
let api, Pricing, AuthContext
beforeEach(async () => {
  vi.resetModules()
  api = (await import('../../src/lib/api')).default
  Pricing = (await import('../../src/pages/Pricing')).default
  AuthContext = (await import('../../src/context/AuthContext')).AuthContext
  api.get.mockReset()
  api.get.mockRejectedValue(new Error('offline'))
})

describe('Pricing — paid-card buttons', () => {
  it('an anonymous visitor is sent to scan first (home)', async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>)
    const links = await screen.findAllByRole('link', { name: 'Scan first →' })
    expect(links).toHaveLength(3)
    links.forEach(l => expect(l).toHaveAttribute('href', '/'))
  })

  it('a signed-in visitor is sent to their dashboard, where their scans are', async () => {
    render(
      <AuthContext.Provider value={{ user: { id: 'u1', email: 'a@b.co' } }}>
        <MemoryRouter><Pricing /></MemoryRouter>
      </AuthContext.Provider>
    )
    const links = await screen.findAllByRole('link', { name: 'Choose one of your scans →' })
    expect(links).toHaveLength(3)
    links.forEach(l => expect(l).toHaveAttribute('href', '/dashboard'))
    expect(screen.queryByRole('link', { name: 'Scan first →' })).toBeNull()
  })
})
