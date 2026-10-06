// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Alert from '../../src/components/ui/Alert'

describe('Alert', () => {
  it('announces errors assertively and everything else politely', () => {
    const { rerender } = render(<Alert>Broke</Alert>)
    expect(screen.getByRole('alert')).toHaveTextContent('Broke')
    rerender(<Alert variant="warning">Careful</Alert>)
    expect(screen.getByRole('status')).toHaveTextContent('Careful')
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('renders nothing for an empty message, so callers need no `error && ...` wrapper', () => {
    for (const v of [null, undefined, false, '']) {
      const { container, unmount } = render(<Alert>{v}</Alert>)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })
  it('takes the colours of its variant and merges a caller className', () => {
    render(<Alert variant="success" className="mb-4">Done</Alert>)
    const el = screen.getByRole('status')
    expect(el.className).toMatch(/bg-green-50/)
    expect(el.className).toMatch(/mb-4/)
  })
  it('falls back to the error look for an unknown variant', () => {
    render(<Alert variant="nope">x</Alert>)
    expect(screen.getByRole('status').className).toMatch(/bg-red-50/)
  })
})
