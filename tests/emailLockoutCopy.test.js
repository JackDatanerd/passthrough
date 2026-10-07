import { describe, it, expect } from 'vitest'
import { render } from '../src/templates/emails.js'

// Auth round 3 (B1): changePassword / updateEmail / deleteAccount lock an account after failures
// from a SINGLE address (requireDistinctIps: false), but the lockout email told the owner the
// attempts came "from multiple locations". The copy must not claim more than every caller knows.
describe('account_lockout_alert copy', () => {
  const html = render('account_lockout_alert', { NAME: 'Ada', LOCKOUT_MINUTES: '15' })
  it('does not claim the attempts came from multiple locations', () => {
    expect(html).not.toMatch(/multiple locations/i)
  })
  it('still states the duration and that the password was not changed', () => {
    expect(html).toContain('15 minutes')
    expect(html).toMatch(/password hasn't been changed/i)
  })
})
