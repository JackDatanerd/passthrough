// Scan/ATS round 9 (B4): the "being rejected" headline used a hardcoded 75 although the shared constant exists.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'

vi.mock('../../src/hooks/usePricing', () => ({
  fmtPrice: (cents) => `$${(cents / 100).toFixed(0)}`,
  usePricing: () => ({
    byTier: () => ({ amount: 2900, originalAmount: 2900, referralApplied: false, discountApplied: false }),
    pricing: { currency: 'USD' }, pricingFailed: false, refresh: () => {}, clockOffsetMs: 0,
  }),
}))
vi.mock('../../src/lib/scoreThresholds', () => ({ ATS_PASS_THRESHOLD: 60, ATS_BADGE_THRESHOLD: 80, MAX_FIX_RETRIES: 2 }))

import FixBanner from '../../src/components/scan/FixBanner'

const render = scan => renderToStaticMarkup(<FixBanner scan={{ id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, inputMode: 'brain_dump', ...scan }} onPay={() => {}} onRedeemCredit={() => {}} />)

describe('FixBanner headline follows the shared pass threshold, not a typed-in 75', () => {
  it('a score between the (mocked) pass line and the badge line is not told it is being rejected', () => {
    const html = render({ atsScore: 70, passed: undefined, badgeEligible: false })
    expect(html).toContain('Boost your score and unlock Verified status')
    expect(html).not.toContain('being rejected')
  })
  it('a score under the pass line is told it is being rejected', () => {
    expect(render({ atsScore: 50, passed: undefined, badgeEligible: false })).toContain('being rejected')
  })
  it('the server verdict (scan.passed) wins over the local comparison', () => {
    expect(render({ atsScore: 70, passed: false, badgeEligible: false })).toContain('being rejected')
  })
})
