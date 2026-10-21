// Partners / referral round 23: one test per fix.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')

describe('canonicalEmail (bug 3)', () => {
  const { canonicalEmail } = require('../src/services/referral.service.js')
  it('a local part that is only a +tag is left alone, so unrelated addresses stay distinct', () => {
    expect(canonicalEmail('+x@evil.com')).not.toBe(canonicalEmail('+y@evil.com'))
  })
  it('still strips +tags and gmail dots', () => {
    expect(canonicalEmail('Jo.Hn+shop@Gmail.com')).toBe('john@gmail.com')
    expect(canonicalEmail('a+b@corp.io')).toBe('a@corp.io')
  })
})

describe('frontend wiring', () => {
  const admin = read('frontend/src/pages/admin/AdminPartners.jsx')
  const dash = read('frontend/src/pages/PartnerDashboard.jsx')
  it('terms-notice count and filter leave out ENDED partners (bug 2)', () => {
    expect(admin).toMatch(/termsOutstanding = partners\.filter\(p => p\.termsNoticePending !== false && p\.termsCurrent === false && p\.status !== 'ENDED'/)
    expect(admin).toMatch(/terms:\s+\{[^}]*status !== 'ENDED'/)
  })
  it('the payout-run export reads full details from the step-up endpoint, not the list (G1)', () => {
    expect(admin).toMatch(/api\.get\('\/partners\/payout-export'\)/)
    expect(admin).not.toMatch(/const d = p\.payoutDetails/)
  })
  it('the payout statement trusts the server total, not a full last page (bug 4)', () => {
    expect(dash).toMatch(/all\.length < res\.data\.total/)
  })
  it('sign-ups are labelled with their 30-day window (G4)', () => {
    expect(dash).toMatch(/last \$\{ATTRIBUTION_WINDOW_DAYS\} days/)
    expect(read('frontend/src/pages/admin/PartnerDetail.jsx')).toMatch(/sign-ups?.*last 30 days|last 30 days/)
  })
})
