// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReferralCodeEntry } from '../../src/components/ui/ReferralCodeEntry'

// Payments & Pricing round 2 (B2): "applied" copy must hang on discountApplied, not
// on referralApplied (attribution), and a partner's own code must say so.
const show = pricing => render(<ReferralCodeEntry referralCode="COACH20" pricing={pricing} onApply={() => {}} disabled={false} />)

describe('ReferralCodeEntry', () => {
  it('a code that lowers the price reads "applied"', () => {
    show({ referralApplied: true, discountApplied: true })
    expect(screen.getByText(/applied —/)).toBeInTheDocument()
    expect(screen.queryByText(/recognised/)).toBeNull()
  })
  it('B2: a code that is attributed but saves nothing (promo already as low) does NOT claim a discount', () => {
    show({ referralApplied: true, discountApplied: false })
    expect(screen.getByText(/recognised/)).toBeInTheDocument()
    expect(screen.getByText(/doesn't change what you pay/)).toBeInTheDocument()
  })
  it('a response without the field (older/cached) keeps the original wording', () => {
    show({ referralApplied: true })
    expect(screen.getByText(/applied —/)).toBeInTheDocument()
  })
  it('an unresolvable code says it does not look right', () => {
    show({ referralApplied: false, selfReferral: false })
    expect(screen.getByText(/doesn't look right/)).toBeInTheDocument()
  })
  it('a partner\'s OWN code says so instead of implying a typo', () => {
    show({ referralApplied: false, selfReferral: true })
    expect(screen.getByText(/can't be used on your own purchases/)).toBeInTheDocument()
    expect(screen.queryByText(/doesn't look right/)).toBeNull()
  })
  it('shows no error while pricing is still loading', () => {
    show(null)
    expect(screen.queryByText(/doesn't look right|can't be used/)).toBeNull()
  })
})
