// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { formatDate, dateStamp, formatUsd } from '../src/lib/utils'
import Modal from '../src/components/ui/Modal'
import Menu from '../src/components/ui/Menu'

afterEach(cleanup)

describe('utils (Section 11, round 17)', () => {
  const realTZ = process.env.TZ
  beforeAll(() => { process.env.TZ = 'Africa/Nairobi' })
  afterAll(() => { if (realTZ === undefined) delete process.env.TZ; else process.env.TZ = realTZ })

  it('formatDate({utc:true}) shows the calendar day a UTC instant names, east of UTC', () => {
    expect(formatDate('2026-03-05T23:59:59.999Z', { utc: true })).toBe('Mar 5, 2026')
    expect(formatDate('2026-03-05T23:59:59.999Z')).toBe('Mar 6, 2026')
    expect(formatDate('2026-03-05', { utc: true })).toBe('Mar 5, 2026')
  })
  it('dateStamp is the local calendar day, and empty for junk', () => {
    expect(dateStamp(new Date('2026-03-05T22:30:00Z'))).toBe('2026-03-06')
    expect(dateStamp('not a date')).toBe('')
  })
  it('formatUsd groups, handles negatives and unknowns', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(0.0042, { decimals: 4 })).toBe('$0.0042')
    expect(formatUsd(-0.001)).toBe('$0.00')
    expect(formatUsd(-3)).toBe('-$3.00')
    for (const v of [null, undefined, '', 'abc', NaN, true]) expect(formatUsd(v)).toBe('—')
  })
})

describe('Modal (Section 11, round 17)', () => {
  it('publishes the scroll-lock gap while open and removes it on close', () => {
    const { rerender } = render(<Modal open onClose={() => {}} title="T"><button>x</button></Modal>)
    expect(document.documentElement.style.getPropertyValue('--scroll-lock-gap')).not.toBe('')
    rerender(<Modal open={false} onClose={() => {}} title="T"><button>x</button></Modal>)
    expect(document.documentElement.style.getPropertyValue('--scroll-lock-gap')).toBe('')
  })
  it('opened with <body> focused, closing hands focus to <main>, not <body>', () => {
    render(<main><p>page</p></main>)
    document.body.focus()
    const { rerender } = render(<Modal open onClose={() => {}} title="T"><button>x</button></Modal>)
    rerender(<Modal open={false} onClose={() => {}} title="T"><button>x</button></Modal>)
    expect(document.activeElement).toBe(document.querySelector('main'))
  })
})

describe('Menu (Section 11, round 17)', () => {
  it('caps its height to the viewport so a short window scrolls inside the list', () => {
    const orig = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: 220, configurable: true })
    try {
      render(<Menu label="Actions"><button type="button" role="menuitem">One</button><button type="button" role="menuitem">Two</button></Menu>)
      fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
      expect(screen.getByRole('menu').style.maxHeight).toBe('204px')
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: orig, configurable: true })
    }
  })
})
