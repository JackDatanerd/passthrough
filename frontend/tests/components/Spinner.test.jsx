// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Spinner from '../../src/components/ui/Spinner'

// Section 12 audit: Spinner had no test file. What matters here is that it's
// announced to assistive tech (role=status + a label) and that size maps to
// the right dimensions.
describe('Spinner', () => {
  it('is exposed as a status with the default label "Loading"', () => {
    render(<Spinner />)
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
  })

  it('accepts a custom accessible label', () => {
    render(<Spinner label="Loading audit log" />)
    expect(screen.getByRole('status', { name: 'Loading audit log' })).toBeInTheDocument()
  })

  it.each([['sm', 'h-4'], ['md', 'h-6'], ['lg', 'h-10']])('size=%s renders %s', (size, cls) => {
    render(<Spinner size={size} />)
    expect(screen.getByRole('status').getAttribute('class')).toContain(cls)
  })

  it('defaults to md and always animates', () => {
    render(<Spinner />)
    const cls = screen.getByRole('status').getAttribute('class')
    expect(cls).toContain('h-6'); expect(cls).toContain('animate-spin')
  })

  it('merges a caller className', () => {
    render(<Spinner className="mx-auto" />)
    expect(screen.getByRole('status').getAttribute('class')).toContain('mx-auto')
  })
})
