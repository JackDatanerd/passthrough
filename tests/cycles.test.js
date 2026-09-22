import { describe, it, expect } from 'vitest'
import { cycleBounds, cycleKey, cycleLabel, recentCycles } from '../src/lib/cycles.js'

describe('cycleBounds', () => {
  it('buckets the first half of a month (1st-15th)', () => {
    const { start, end } = cycleBounds('2026-01-01T00:00:00Z')
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-01-15T23:59:59.999Z')
  })

  it('buckets the second half of a month (16th-end)', () => {
    const { start, end } = cycleBounds('2026-01-16T00:00:00.000Z')
    expect(start.toISOString()).toBe('2026-01-16T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-01-31T23:59:59.999Z')
  })

  it('handles the exact 15th/16th boundary correctly on both sides', () => {
    expect(cycleBounds('2026-01-15T23:59:59.999Z').start.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(cycleBounds('2026-01-16T00:00:00.000Z').start.toISOString()).toBe('2026-01-16T00:00:00.000Z')
  })

  it('rolls a December second-half cycle over into the new year correctly', () => {
    const { start, end } = cycleBounds('2026-12-20T23:50:00Z')
    expect(start.toISOString()).toBe('2026-12-16T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-12-31T23:59:59.999Z')
  })

  it('ends a February second-half cycle on the 28th in a non-leap year', () => {
    const { end } = cycleBounds('2026-02-20T00:00:00Z')
    expect(end.toISOString()).toBe('2026-02-28T23:59:59.999Z')
  })

  it('ends a February second-half cycle on the 29th in a leap year', () => {
    const { end } = cycleBounds('2028-02-20T00:00:00Z')
    expect(end.toISOString()).toBe('2028-02-29T23:59:59.999Z')
  })

  it('is computed in UTC regardless of the input\'s local representation', () => {
    // 23:50 UTC on the 15th must stay in the first-half cycle, never bucketed
    // into the 16th cycle due to a local-timezone shift.
    const { start } = cycleBounds('2026-01-15T23:50:00.000Z')
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('cycleKey', () => {
  it('produces a stable, half-aware key', () => {
    expect(cycleKey('2026-01-01T00:00:00.000Z')).toBe('2026-01-A')
    expect(cycleKey('2026-01-16T00:00:00.000Z')).toBe('2026-01-B')
    expect(cycleKey('2026-12-01T00:00:00.000Z')).toBe('2026-12-A')
  })
})

describe('cycleLabel', () => {
  it('formats a human-readable range', () => {
    const { start, end } = cycleBounds('2026-01-01T00:00:00Z')
    expect(cycleLabel(start, end)).toBe('Jan 1\u201315, 2026')
  })
})

describe('recentCycles', () => {
  it('returns the requested count, most-recent-first, marking only the first as current', () => {
    const cycles = recentCycles(4, new Date('2026-01-10T12:00:00Z'))
    expect(cycles).toHaveLength(4)
    expect(cycles[0].isCurrent).toBe(true)
    expect(cycles.slice(1).every(c => !c.isCurrent)).toBe(true)
  })

  it('steps backward across a year boundary without gaps or duplicates', () => {
    const cycles = recentCycles(4, new Date('2026-01-10T12:00:00Z'))
    expect(cycles.map(c => c.key)).toEqual(['2026-01-A', '2025-12-B', '2025-12-A', '2025-11-B'])
  })

  it('never produces two cycles with the same key', () => {
    const cycles = recentCycles(12, new Date('2026-03-05T00:00:00Z'))
    const keys = cycles.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
