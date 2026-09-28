// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Badge from '../../src/components/ui/Badge'

// Section 12 audit: Badge had no test file at all. It's tiny, but it's the
// status pill on nearly every admin table, so the variant → colour mapping
// (and its fallback) is worth pinning.
describe('Badge', () => {
  it('renders its children as a pill', () => {
    render(<Badge>ACTIVE</Badge>)
    expect(screen.getByText('ACTIVE')).toBeInTheDocument()
    expect(screen.getByText('ACTIVE').className).toContain('rounded-full')
  })

  it('defaults to the gray variant', () => {
    render(<Badge>x</Badge>)
    expect(screen.getByText('x').className).toContain('bg-gray-100')
  })

  it.each([
    ['green', 'bg-green-100'], ['red', 'bg-red-100'], ['amber', 'bg-amber-100'],
    ['blue', 'bg-blue-100'], ['gray', 'bg-gray-100'],
  ])('variant=%s uses %s', (variant, cls) => {
    render(<Badge variant={variant}>v</Badge>)
    expect(screen.getByText('v').className).toContain(cls)
  })

  it('an unknown variant does not crash and adds no colour classes', () => {
    render(<Badge variant="purple">odd</Badge>)
    const cls = screen.getByText('odd').className
    expect(cls).not.toContain('bg-')
    expect(cls).toContain('rounded-full')
  })

  it('merges a caller className without dropping the base classes', () => {
    render(<Badge className="ml-2">m</Badge>)
    const cls = screen.getByText('m').className
    expect(cls).toContain('ml-2'); expect(cls).toContain('inline-flex')
  })
})
