import { describe, it, expect } from 'vitest'
const { htmlToPlainText } = require('../src/services/email.service')
const { ALWAYS_SEND_TEMPLATES } = require('../src/lib/emailSuppression')

describe('cross-cutting infra round 8', () => {
  it('a link whose label is the same URL (with &) prints once in the plain-text part', () => {
    const t = htmlToPlainText('<p><a href="https://x.com/v?a=1&amp;b=2">https://x.com/v?a=1&amp;b=2</a></p>')
    expect(t).toBe('https://x.com/v?a=1&b=2')
  })
  it('a differing label still prints label (url)', () => {
    expect(htmlToPlainText('<a href="https://x.com/?a=1&amp;b=2">Open</a>')).toBe('Open (https://x.com/?a=1&b=2)')
  })
  it('partner account-security mail is never suppressed', () => {
    for (const t of ['partner_payout_details_changed', 'partner_email_changed', 'partner_link_regenerated',
      'partner_dashboard_link_regenerated', 'partner_links_recovery', 'partner_links_self_reset', 'partner_payout_details_request'])
      expect(ALWAYS_SEND_TEMPLATES.has(t)).toBe(true)
    expect(ALWAYS_SEND_TEMPLATES.has('welcome')).toBe(false)
  })
})
