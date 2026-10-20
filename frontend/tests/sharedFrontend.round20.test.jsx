// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import Alert from '../src/components/ui/Alert'
import Modal from '../src/components/ui/Modal'
import { formatDate, formatDateTime, csvCell, toCsv } from '../src/lib/utils'

// Shared frontend round 20.
describe('Alert focusOnShow', () => {
  function Form() {
    const [error, setError] = useState('')
    return (
      <form onSubmit={e => { e.preventDefault(); setError(''); setTimeout(() => {}, 0); setError('Please upload your resume.') }}>
        <button type="submit">Go</button>
        <Alert focusOnShow>{error}</Alert>
      </form>
    )
  }
  it('takes focus when a message appears, and not before', () => {
    render(<Form />)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.submit(screen.getByText('Go').closest('form'))
    const box = screen.getByRole('alert')
    expect(box).toHaveFocus()
    expect(box).toHaveAttribute('tabindex', '-1')
  })
  it('is focused again when the message goes away and comes back', () => {
    const { rerender } = render(<Alert focusOnShow>First</Alert>)
    const first = screen.getByRole('alert'); expect(first).toHaveFocus()
    rerender(<Alert focusOnShow>{''}</Alert>)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<Alert focusOnShow>First</Alert>)
    expect(screen.getByRole('alert')).toHaveFocus()
  })
  it('without the prop an alert never steals focus and is not made focusable', () => {
    render(<><button>x</button><Alert>Broke</Alert></>)
    const box = screen.getByRole('alert')
    expect(box).not.toHaveFocus()
    expect(box).not.toHaveAttribute('tabindex')
  })
})

describe('Modal focus trap', () => {
  it('a <summary> that is the LAST stop wraps Tab back to the first one instead of letting focus leave the dialog', () => {
    render(
      <Modal open onClose={() => {}} title="T">
        <button>First</button>
        <details><summary>More</summary><p>text</p></details>
      </Modal>
    )
    screen.getByText('More').focus()
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(screen.getByLabelText('Close'))
  })
})

describe('utils', () => {
  it('a bare number-ish string is not a date', () => {
    expect(formatDate('0')).toBe('—')
    expect(formatDate('12')).toBe('—')
    expect(formatDateTime('0')).toBe('—')
    expect(formatDateTime('7')).toBe('—')
  })
  it('real date strings still format', () => {
    expect(formatDate('2026-09-01T10:00:00Z')).toMatch(/Sep 1, 2026|Sep 2, 2026/)
    expect(formatDate('Sep 1, 2026')).toBe('Sep 1, 2026')
    expect(formatDateTime('2026-09-01')).toBe('Sep 1, 2026')
    expect(formatDateTime('2026-09-01T10:00:00Z')).toMatch(/2026/)
  })
  it('a Date in a CSV cell is an ISO timestamp, an invalid one is blank', () => {
    expect(csvCell(new Date(Date.UTC(2026, 8, 1, 10, 0, 0)))).toBe('2026-09-01T10:00:00.000Z')
    expect(csvCell(new Date('nope'))).toBe('')
  })
  it('a formula hidden behind a leading line break is neutralised too', () => {
    expect(csvCell('\n=1+1')).toBe('"\'\n=1+1"')
    expect(csvCell('\r\n@SUM(A1)')).toBe('"\'\r\n@SUM(A1)"')
    expect(csvCell('\n-5')).toBe('"\'\n-5"')
  })
  it('ordinary text and numbers are untouched', () => {
    expect(csvCell('hello\nworld')).toBe('"hello\nworld"')
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell('a-b')).toBe('a-b')
    expect(toCsv([['x', '=y']])).toBe("x,'=y")
  })
})
