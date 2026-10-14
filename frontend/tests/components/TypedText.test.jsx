// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import TypedText from '../../src/components/home/TypedText'

// The hero's second line types itself out once. These pin the parts that must never regress: the sentence is always one
// clean piece of real text for assistive tech and crawlers, nothing animates for reduced motion or on a repeat visit,
// and the animated copy never takes the line out of the layout.
const TEXT = 'Get the interview.'
const letters = c => [...c.querySelectorAll('[aria-hidden="true"] > span')]
const hiddenCount = c => letters(c).filter(l => l.style.opacity === '0').length
const mockMotion = reduce => { window.matchMedia = q => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }) }

beforeEach(() => { window.sessionStorage.clear(); vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0); mockMotion(false) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete window.matchMedia })

describe('TypedText', () => {
  it('always exposes the full sentence as real text, and hides the animated copy from assistive tech', () => {
    const { container } = render(<TypedText text={TEXT} />)
    expect(screen.getByText(TEXT)).toHaveClass('sr-only')
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(letters(container).map(l => l.textContent).join('')).toBe(TEXT)
  })

  it('types the letters out (every letter keeps its place) and ends on the finished line with the caret gone', () => {
    const { container } = render(<TypedText text={TEXT} />)
    // armed before first paint: every letter hidden, but still in the DOM, so the line keeps its width
    expect(hiddenCount(container)).toBe(TEXT.length)
    expect(container.querySelector('.animate-caret-blink')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(500 + 45 * 5) })
    const mid = hiddenCount(container)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(TEXT.length)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(hiddenCount(container)).toBe(0)
    expect(container.querySelector('.animate-caret-done')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(container.querySelector('.animate-caret-done')).toBeNull()
    expect(container.querySelector('.animate-caret-blink')).toBeNull()
  })

  it('does not animate when the visitor asks for reduced motion', () => {
    mockMotion(true)
    const { container } = render(<TypedText text={TEXT} />)
    expect(hiddenCount(container)).toBe(0)
    expect(container.querySelector('[class*="animate-caret"]')).toBeNull()
  })

  it('plays once per session: a second mount shows the finished line straight away', () => {
    const first = render(<TypedText text={TEXT} />)
    expect(hiddenCount(first.container)).toBe(TEXT.length)
    first.unmount()
    const second = render(<TypedText text={TEXT} />)
    expect(hiddenCount(second.container)).toBe(0)
    expect(second.container.querySelector('[class*="animate-caret"]')).toBeNull()
  })

  it('still animates (once per load) when session storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const { container } = render(<TypedText text={TEXT} />)
    expect(hiddenCount(container)).toBe(TEXT.length)
  })

  it('stops its timers when it unmounts mid-line (no state updates after unmount)', () => {
    const { unmount } = render(<TypedText text={TEXT} />)
    act(() => { vi.advanceTimersByTime(600) })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
