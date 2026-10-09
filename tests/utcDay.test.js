import { describe, it, expect } from 'vitest'
import { utcMidnight } from '../src/lib/utcDay'
import { scanQuota } from '../src/controllers/profile.controller'

describe('utcMidnight: the quota day is a UTC day whatever the process timezone', () => {
  it("is 00:00:00.000 UTC of the instant's UTC date", () => {
    expect(utcMidnight(new Date('2026-10-09T23:59:59.999Z')).toISOString()).toBe('2026-10-09T00:00:00.000Z')
    expect(utcMidnight(new Date('2026-10-09T00:00:00.000Z')).toISOString()).toBe('2026-10-09T00:00:00.000Z')
  })
  it("agrees with the dashboard's resetsAt (next UTC midnight)", () => {
    const now = new Date('2026-10-09T21:30:00Z')
    expect(scanQuota({ scans_today: 1, scans_day_reset: '2026-10-09T08:00:00Z' }, now).resetsAt)
      .toBe(new Date(utcMidnight(now).getTime() + 86_400_000).toISOString())
  })
})
