import { describe, it, expect } from 'vitest'
import { describeQuota } from '../src/lib/quota'

const q = (over = {}) => ({ limit: 3, used: 1, remaining: 2, resetsAt: '2026-10-06T00:00:00.000Z', ...over })

describe('describeQuota', () => {
  it('says how many are left and when they reset', () => {
    const r = describeQuota(q())
    expect(r.exhausted).toBe(false)
    expect(r.text).toMatch(/^2 of 3 free scans left today · resets at /)
  })
  it('singular when the limit is one', () => {
    expect(describeQuota(q({ limit: 1, remaining: 1 })).text).toMatch(/^1 of 1 free scan left today/)
  })
  it('exhausted: says so and when they come back', () => {
    const r = describeQuota(q({ used: 3, remaining: 0 }))
    expect(r.exhausted).toBe(true)
    expect(r.text).toMatch(/used all 3 free scans for today\. They come back at /)
  })
  it('an unusable reset time drops the time instead of printing "Invalid Date"', () => {
    const r = describeQuota(q({ resetsAt: 'garbage' }))
    expect(r.text).toBe('2 of 3 free scans left today')
    expect(r.text).not.toMatch(/Invalid/)
  })
  it('clamps nonsense and returns null when there is nothing trustworthy to say', () => {
    expect(describeQuota(q({ remaining: 9 })).text).toMatch(/^3 of 3/)
    expect(describeQuota(q({ remaining: -2 })).exhausted).toBe(true)
    expect(describeQuota(null)).toBeNull()
    expect(describeQuota({})).toBeNull()
    expect(describeQuota({ limit: 3 })).toBeNull()
  })
})
