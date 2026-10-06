import { describe, it, expect } from 'vitest'
import { totalPagesFor, clampPage } from '../src/lib/pagination.js'

describe('totalPagesFor', () => {
  it('rounds up and never goes below 1', () => {
    expect(totalPagesFor(0, 25)).toBe(1)
    expect(totalPagesFor(25, 25)).toBe(1)
    expect(totalPagesFor(26, 25)).toBe(2)
    expect(totalPagesFor(100, 25)).toBe(4)
  })
  it('treats junk as one page', () => {
    for (const t of [null, undefined, NaN, -5, 'x']) expect(totalPagesFor(t, 25)).toBe(1)
    expect(totalPagesFor(50, 0)).toBe(1)
  })
})

describe('clampPage', () => {
  it('leaves a valid page alone', () => expect(clampPage(2, 60, 25)).toBe(2))
  it('pulls a page past the end back to the last one (list shrank under the person)', () => {
    expect(clampPage(3, 50, 25)).toBe(2)
    expect(clampPage(2, 25, 25)).toBe(1)
    expect(clampPage(4, 0, 25)).toBe(1)
  })
  it('never returns less than 1, and survives junk', () => {
    expect(clampPage(0, 100, 25)).toBe(1)
    expect(clampPage(-3, 100, 25)).toBe(1)
    expect(clampPage(NaN, 100, 25)).toBe(1)
    expect(clampPage(2.7, 100, 25)).toBe(2)
  })
})
