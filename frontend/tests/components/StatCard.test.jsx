// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import StatCard from '../../src/components/ui/StatCard'

describe('StatCard', () => {
  it('renders a label and value', () => {
    render(<StatCard label="Clicks" value={42} />)
    expect(screen.getByText('Clicks')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('renders an optional sub line', () => {
    render(<StatCard label="Revenue" value="$100" sub="vs $80 last week" />)
    expect(screen.getByText('vs $80 last week')).toBeInTheDocument()
  })

  it('omits the sub line when not given', () => {
    render(<StatCard label="Revenue" value="$100" />)
    expect(screen.queryByText(/vs /)).toBeNull()
  })

  it('size="lg" (the default) uses the larger value text, size="md" the smaller', () => {
    const { rerender } = render(<StatCard label="X" value="1" />)
    expect(screen.getByText('1').className).toContain('text-2xl')
    rerender(<StatCard label="X" value="1" size="md" />)
    expect(screen.getByText('1').className).toContain('text-xl')
  })

  it('valueClassName overrides the default color', () => {
    render(<StatCard label="Total pending" value="$50" valueClassName="text-amber-600" />)
    expect(screen.getByText('$50').className).toContain('text-amber-600')
    expect(screen.getByText('$50').className).not.toContain('text-gray-900')
  })

  it('children replaces the plain value line entirely', () => {
    render(
      <StatCard label="Payout details">
        <button>Manage payout</button>
      </StatCard>
    )
    expect(screen.getByRole('button', { name: 'Manage payout' })).toBeInTheDocument()
  })
})
