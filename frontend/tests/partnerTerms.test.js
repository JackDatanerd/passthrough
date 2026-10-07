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

// Guards against the regression that already happened once: a later push to these files silently
// dropped the wiring, and no behavioural test failed. These read the sources so it fails loudly.
import { readFileSync } from 'node:fs'
describe('partnerTerms stays wired in', () => {
  const src = f => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  it('the capture hook derives its window from the shared constant', () => {
    const s = src('hooks/useReferralCapture.js')
    expect(s).toMatch(/import \{ ATTRIBUTION_WINDOW_DAYS \} from '..\/lib\/partnerTerms'/)
    expect(s).toMatch(/ATTRIBUTION_TTL_MS = ATTRIBUTION_WINDOW_DAYS/)
  })
  it('both partner pages render the shared terms', () => {
    for (const f of ['pages/PartnerApply.jsx', 'pages/PartnerDashboard.jsx'])
      expect(src(f)).toContain('ATTRIBUTION_TERMS.map')
  })
})
