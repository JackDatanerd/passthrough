import { describe, it, expect, afterEach } from 'vitest'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { isRemovedEmail, REMOVED_EMAIL_DOMAIN } from '../src/lib/removedPartner.js'

// Section 4 round 7 (found on the fresh pass of the new code): a refund or admin action on a REMOVED partner used to
// try to mail partner-<id>@removed.invalid — an address that can only fail, and logged as a failure each time.
let t
afterEach(() => t?.restore())

describe('removed-partner addresses', () => {
  it('recognises the placeholder domain, case-insensitively, and nothing else', () => {
    expect(REMOVED_EMAIL_DOMAIN).toBe('removed.invalid')
    expect(isRemovedEmail('partner-1@removed.invalid')).toBe(true)
    expect(isRemovedEmail(' Partner-1@REMOVED.INVALID ')).toBe(true)
    expect(isRemovedEmail('k@removed.invalid.example.com')).toBe(false)
    expect(isRemovedEmail('k@x.co')).toBe(false)
    expect(isRemovedEmail(null)).toBe(false)
  })

  it('email.send never attempts delivery, logs a failure, or spends quota for one', async () => {
    const sent = [], logs = [], quota = []
    t = loadWithStubs('services/email.service.js', {
      'config/email.js': { sendViaResend: async m => { sent.push(m) } },
      'middleware/rateLimiter.js': { hitQuota: async (...a) => { quota.push(a); return true }, refundQuota: async () => {} },
    })
    const db = { from: () => ({ insert: async row => { logs.push(row); return { error: null } } }) }
    const env = { FRONTEND_URL: 'https://passthrough.dev', EMAIL_FROM: 'P <hello@passthrough.dev>', RATE_LIMIT_KV: {} }
    const ok = await t.mod.sendPartnerCommissionReversed(env, db, 'partner-p1@removed.invalid', 'Removed partner', 500, 'USD', 'https://d')
    expect(ok).toBe(false)
    expect(sent).toHaveLength(0)
    expect(logs).toHaveLength(0)
    expect(quota).toHaveLength(0)
  })

  it('a normal address still sends', async () => {
    const sent = []
    t = loadWithStubs('services/email.service.js', {
      'config/email.js': { sendViaResend: async m => { sent.push(m) } },
      'middleware/rateLimiter.js': { hitQuota: async () => true, refundQuota: async () => {} },
    })
    const db = { from: () => ({ insert: async () => ({ error: null }) }) }
    const env = { FRONTEND_URL: 'https://passthrough.dev', EMAIL_FROM: 'P <hello@passthrough.dev>', RATE_LIMIT_KV: {} }
    expect(await t.mod.sendPartnerCommissionReversed(env, db, 'k@x.co', 'K', 500, 'USD', 'https://d')).toBe(true)
    expect(sent).toHaveLength(1)
  })
})
