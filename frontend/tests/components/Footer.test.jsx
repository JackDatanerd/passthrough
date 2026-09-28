// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Footer from '../../src/components/layout/Footer'

// Section 12 audit: Footer had no test file. Its whole job is links, and a
// footer link to a route that doesn't exist fails silently (a blank page), so
// the hrefs are pinned here — each of these is a real route in App.jsx (or,
// for /#employers, the id="employers" section on Home).
describe('Footer', () => {
  const renderFooter = () => render(<MemoryRouter><Footer /></MemoryRouter>)

  it.each([
    ['Pricing', '/pricing'],
    ['For employers', '/#employers'],
    ['Check a resume', '/check'],
    ['Terms', '/terms'],
    ['Privacy', '/privacy'],
  ])('links "%s" to %s', (label, href) => {
    renderFooter()
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href)
  })

  it('offers a mailto support link', () => {
    renderFooter()
    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute('href', 'mailto:support@passthrough.dev')
  })

  it('shows the current year in the copyright line', () => {
    renderFooter()
    expect(screen.getByText(new RegExp(`© ${new Date().getFullYear()} Passthrough`))).toBeInTheDocument()
  })
})
