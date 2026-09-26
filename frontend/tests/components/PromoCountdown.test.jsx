// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import PromoCountdown from '../../src/components/ui/PromoCountdown'

// PromoCountdown.jsx's own comment lists real, previously-shipped issues:
// no clockOffsetMs correction (a wrong device clock lied about time left),
// onExpire never firing (stale promo prices stayed on screen after the
// countdown vanished), an unparseable date rendering "NaN:NaN:NaN", and the
// interval never stopping after expiry. None of that had a regression test
// before this (Section 12 audit).
const NOW = new Date('2026-01-01T00:00:00.000Z').getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => { vi.useRealTimers() })

describe('PromoCountdown', () => {
  it('renders nothing for an unparseable date, and never calls onExpire', () => {
    const onExpire = vi.fn()
    const { container } = render(<PromoCountdown endsAt="not-a-date" onExpire={onExpire} />)
    expect(container).toBeEmptyDOMElement()
    vi.advanceTimersByTime(10_000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('renders nothing and fires onExpire once for a deadline already in the past', () => {
    const onExpire = vi.fn()
    const { container } = render(
      <PromoCountdown endsAt={new Date(NOW - 10_000).toISOString()} onExpire={onExpire} />
    )
    expect(container).toBeEmptyDOMElement()
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('shows HH:MM:SS for a same-day deadline and counts down', () => {
    render(<PromoCountdown endsAt={new Date(NOW + 3723 * 1000).toISOString()} />)
    expect(screen.getByRole('timer')).toHaveTextContent('01:02:03')
    vi.advanceTimersByTime(1000)
    expect(screen.getByRole('timer')).toHaveTextContent('01:02:02')
  })

  it('shows the multi-day "Nd HH:MM:SS" format past 24 hours', () => {
    const twoDays = 2 * 86_400_000
    const rest = 3 * 3_600_000 + 4 * 60_000 + 5000 // 03:04:05
    render(<PromoCountdown endsAt={new Date(NOW + twoDays + rest).toISOString()} />)
    expect(screen.getByRole('timer')).toHaveTextContent('2d 03:04:05')
  })

  it('a clockOffsetMs correction can push an otherwise-future deadline into the past', () => {
    const onExpire = vi.fn()
    // Device clock says 5s left, but the server (clockOffsetMs ahead) says
    // it's already 5s past the deadline.
    const { container } = render(
      <PromoCountdown endsAt={new Date(NOW + 5000).toISOString()} clockOffsetMs={10_000} onExpire={onExpire} />
    )
    expect(container).toBeEmptyDOMElement()
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('calls onExpire exactly once even though the interval would otherwise keep firing', () => {
    const onExpire = vi.fn()
    render(<PromoCountdown endsAt={new Date(NOW + 1000).toISOString()} onExpire={onExpire} />)
    vi.advanceTimersByTime(6000) // several more 1s ticks after expiry
    expect(onExpire).toHaveBeenCalledTimes(1)
  })
})
