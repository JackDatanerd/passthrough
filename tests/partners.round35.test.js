import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 35: the admin's "Resend dashboard link" has its own hourly email budget, so the public "I lost my link" form cannot use
// up a partner's budget and make the admin's resend fail.

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })
const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }

describe('partner_links_recovery budgets', () => {
  const setup = () => {
    const sent = []
    const db = createFakeSupabase()
    const loaded = loadWithStubs('services/email.service.js', {
      'config/email.js': { sendViaResend: async (env, msg) => { sent.push(msg); return { id: 'x' } } },
      'config/supabase.js': { getSupabase: () => db },
    })
    const env = { FRONTEND_URL: 'https://usepassthrough.com', EMAIL_FROM: 'P <hello@usepassthrough.com>', RATE_LIMIT_KV: kv() }
    return { ...loaded, sent, db, env }
  }
  it('three public recoveries use up the public budget but not the admin one', async () => {
    t = setup()
    const pub = []
    for (let i = 0; i < 4; i++) pub.push(await t.mod.sendPartnerLinksRecovery(t.env, t.db, 'p@x.co', 'P', 'https://x/d?token=1'))
    expect(pub).toEqual([true, true, true, false])
    expect(await t.mod.sendPartnerLinksRecovery(t.env, t.db, 'p@x.co', 'P', 'https://x/d?token=1', { quotaKey: 'partner_links_recovery:admin' })).toBe(true)
  })
  it('the admin budget is still capped (3 an hour), so it cannot be used to mail-bomb either', async () => {
    t = setup()
    const admin = []
    for (let i = 0; i < 4; i++) admin.push(await t.mod.sendPartnerLinksRecovery(t.env, t.db, 'p@x.co', 'P', 'https://x/d?token=1', { quotaKey: 'partner_links_recovery:admin' }))
    expect(admin).toEqual([true, true, true, false])
  })
})

describe('admin resend of the dashboard link', () => {
  const ctxOf = body => ({
    env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123' },
    get: () => ({ id: 'a1' }),
    req: { param: () => '0b0c8c64-1d0f-4f7e-9a49-0a6a4b1f4c11', query: () => undefined, json: async () => body, header: () => undefined },
    header: () => {}, json: (b, status = 200) => ({ body: b, status }), executionCtx: { waitUntil: () => {} },
  })
  it('sends with its own quota key and no longer claims a 4-per-hour limit', async () => {
    const calls = []
    const db = createFakeSupabase(q => q.table === 'partners' ? { data: { id: 'p1', name: 'P', email: 'p@x.co', dashboard_token: null, dashboard_token_version: 0 }, error: null } : undefined)
    t = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async () => {}, sendPartnerLinksRecovery: async (...a) => { calls.push(a[5]); return false } },
    })
    const res = await t.mod.adminResendPayoutLink(ctxOf({ scope: 'dashboard' }))
    expect(calls).toEqual([{ quotaKey: 'partner_links_recovery:admin' }])
    expect(res.body.success).toBe(false)
    expect(res.body.message).not.toMatch(/4-per-hour/)
    expect(res.body.dashboardUrl).toMatch(/partner\/dashboard\?token=/)
  })
})
