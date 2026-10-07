import { describe, it, expect } from 'vitest'
import { ATTRIBUTION_WINDOW_DAYS, ATTRIBUTION_TERMS } from '../src/lib/partnerTerms'

// The window partners are TOLD about is the window useReferralCapture ENFORCES (it imports this
// constant); useReferralCapture.test.js pins the enforcement at exactly 30 days.
describe('partnerTerms', () => {
  it('states the 30-day window the capture hook enforces', () => {
    expect(ATTRIBUTION_WINDOW_DAYS).toBe(30)
    expect(ATTRIBUTION_TERMS[0]).toContain('30 days')
  })
  it('covers window, repeat purchases and refunds', () => {
    expect(ATTRIBUTION_TERMS).toHaveLength(3)
  })
})
