import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 22: a failed resend says the previous payout link is dead, and an email change reports whether the
// new links reached the new address (handing them back when not).

let t
afterEach(() => t?.restore())

const ctxOf = (body = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123' },
  get: () => ({ id: 'admin-1' }),
  req: { param: () => 'p1', json: async () => body, query: () => undefined },
  header: () => {}, json: (b, status = 200) => ({ body: b, status }),
})

describe('adminResendPayoutLink — failed send (round 22)', () => {
  function load(sendOk) {
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { name: 'Ann', email: 'ann@x.co', dashboard_token: 'd1' }, error: null }
      if (q.table === 'partners' && q.op === 'update') return { data: { id: 'p1' }, error: null }
      return undefined
    })
    return loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPartnerPayoutDetailsRequest: async () => sendOk },
    })
  }
  it('says the previous link no longer works and flags it, while still handing back the new link', async () => {
    t = load(false)
    const res = await t.mod.adminResendPayoutLink(ctxOf())
    expect(res.body.success).toBe(false)
    expect(res.body.previousLinkRevoked).toBe(true)
    expect(res.body.message).toMatch(/previous payout link no longer works/i)
    expect(res.body.payoutUrl).toMatch(/\/partner\/payout-details\?token=[0-9a-f]{20,}$/)
  })
  it('a delivered resend carries neither the flag nor the link', async () => {
    t = load(true)
    const res = await t.mod.adminResendPayoutLink(ctxOf())
    expect(res.body.success).toBe(true)
    expect(res.body.previousLinkRevoked).toBeUndefined()
    expect(res.body.payoutUrl).toBeUndefined()
  })
})

describe('adminUpdatePartner — email change reports link delivery (round 22)', () => {
  function load({ payoutOk = true, dashOk = true, throws = false } = {}) {
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { email: 'old@x.co', name: 'Ann' }, error: null }
      if (q.table === 'partners' && q.op === 'update') return { data: { id: 'p1', name: 'Ann', email: 'new@x.co' }, error: null }
      return undefined
    })
    const ok = v => async () => { if (throws) throw new Error('mail down'); return v }
    return loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendPartnerLinkRegenerated: ok(payoutOk),
        sendPartnerDashboardLinkRegenerated: ok(dashOk),
        sendPartnerEmailChanged: async () => true,
        sendOwnerAlert: async () => true,
      },
    })
  }
  it('both links delivered: linksEmailed true and no links in the response', async () => {
    t = load()
    const res = await t.mod.adminUpdatePartner(ctxOf({ email: 'new@x.co' }))
    expect(res.body.linksEmailed).toBe(true)
    expect(res.body.payoutUrl).toBeUndefined()
    expect(res.body.dashboardUrl).toBeUndefined()
  })
  it.each([
    ['the payout-link mail returns false', { payoutOk: false }],
    ['the dashboard-link mail returns false', { dashOk: false }],
    ['the mailer throws', { throws: true }],
  ])('%s: linksEmailed false and both fresh links handed back', async (_n, opts) => {
    t = load(opts)
    const res = await t.mod.adminUpdatePartner(ctxOf({ email: 'new@x.co' }))
    expect(res.body.success).toBe(true)
    expect(res.body.linksEmailed).toBe(false)
    expect(res.body.payoutUrl).toMatch(/\/partner\/payout-details\?token=[0-9a-f]{20,}$/)
    // Round 27: dashboard links are derived (<partner id>.<HMAC>), nothing is stored.
    expect(res.body.dashboardUrl).toMatch(/\/partner\/dashboard\?token=[^.]+\.[0-9a-f]{128}$/)
  })
  it('no email change: the response carries no link fields at all', async () => {
    t = load()
    const res = await t.mod.adminUpdatePartner(ctxOf({ name: 'Ann B' }))
    expect(res.body.linksEmailed).toBeUndefined()
    expect(res.body.payoutUrl).toBeUndefined()
  })
})
