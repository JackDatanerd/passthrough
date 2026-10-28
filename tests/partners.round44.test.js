import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 44: attribution writes are conditional, an ended partner re-applying is flagged to the owner,
// and the admin partner list degrades (instead of failing) when there are too many unpaid ledger rows to total.

let t
afterEach(() => t?.restore())
const GOOD = { id: 'c', code: 'K20', active: true, expires_at: null, usage_limit: null, uses_so_far: 0, partners: { status: 'ACTIVE', email: 'k@x.co' } }
const USER = { id: 'u1', email: 'buyer@x.co' }

function attribution(current, writeResults) {
  const updates = []
  t = loadWithStubs('services/referral.service.js', {})
  const db = createFakeSupabase(q => {
    if (q.table === 'referral_codes') return { data: GOOD, error: null }
    if (q.table === 'users' && q.op === 'update') { updates.push(q); return { data: writeResults.length ? writeResults.shift() : [{ id: 'u1' }], error: null } }
    if (q.table === 'users') return { data: current, error: null }
    return undefined
  })
  return { svc: t.mod, db, updates }
}

describe('setUserAttribution writes only over the state it read', () => {
  it('guards the update on the code and capture time it read', async () => {
    const at = new Date(Date.now() - 86400000).toISOString()
    const { svc, db, updates } = attribution({ referred_by_code: 'OLD', referred_at: new Date(Date.now() - 5 * 86400000).toISOString() }, [])
    const out = await svc.setUserAttribution(db, USER, 'K20', at)
    expect(out.stored).toBe(true)
    expect(updates[0].filters).toContainEqual(['eq', 'referred_by_code', 'OLD'])
    expect(updates[0].filters.some(f => f[0] === 'eq' && f[1] === 'referred_at')).toBe(true)
  })
  it('uses IS NULL guards for an account with no attribution yet', async () => {
    const { svc, db, updates } = attribution(null, [])
    await svc.setUserAttribution(db, USER, 'K20')
    expect(updates[0].filters).toContainEqual(['is', 'referred_by_code', null])
    expect(updates[0].filters).toContainEqual(['is', 'referred_at', null])
  })
  it('re-reads and retries when a concurrent sync won, then gives up as busy', async () => {
    const a = attribution(null, [[], []])
    const ok = await a.svc.setUserAttribution(a.db, USER, 'K20')
    expect(ok.stored).toBe(true)
    expect(a.updates).toHaveLength(3)
    t.restore()
    const b = attribution(null, [[], [], []])
    expect(await b.svc.setUserAttribution(b.db, USER, 'K20')).toEqual({ stored: false, reason: 'busy' })
  })
})

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://x.co', JWT_SECRET: 's'.repeat(40), PAYSTACK_CURRENCY: 'USD' },
  get: () => ({ id: 'admin-1' }),
  req: { param: () => 'p', query: () => undefined, json: async () => over.body ?? {}, header: () => undefined },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})

describe('applyAsPartner and an ENDED partner', () => {
  const run = async status => {
    const alerts = []
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: [{ id: 'p9', name: 'Old Pal', status }], error: null }
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async (...a) => { alerts.push(a) } },
      'lib/turnstile.js': { verifyTurnstile: async () => true },
    })
    const res = await t.mod.applyAsPartner(ctxOf({ body: { name: 'Old Pal', email: 'old@x.co', termsVersion: '2026-10b', acceptTerms: true } }))
    await new Promise(r => setTimeout(r, 0))
    return { res, alerts, db }
  }
  it('gives the normal thank-you but tells the owner', async () => {
    const { res, alerts, db } = await run('ENDED')
    expect(res.body.success).toBe(true)
    expect(alerts).toHaveLength(1)
    expect(alerts[0][1]).toMatch(/rejoin/i)
    expect(db.calls.some(c => c.table === 'partner_applications' && c.op === 'insert')).toBe(false)
  })
  it('stays silent for a partner who is still active', async () => {
    const { res, alerts } = await run('ACTIVE')
    expect(res.body.success).toBe(true)
    expect(alerts).toHaveLength(0)
  })
})

describe('adminListPartners with too many unpaid ledger rows', () => {
  it('returns the partners with ledgerUnavailable instead of failing', async () => {
    let n = 0
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: [{ id: 'p1', name: 'A', email: 'a@x.co', status: 'ACTIVE', commission_rate: 0.2 }], error: null }
      if (q.table === 'commission_ledger') return { data: Array.from({ length: 1000 }, () => ({ id: String(++n).padStart(8, '0') + '-0000-4000-8000-000000000000', partner_id: 'p1', commission_amount_cents: 1, created_at: '2026-01-01T00:00:00Z' })), error: null }
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const res = await t.mod.adminListPartners(ctxOf())
    expect(res.status).toBe(200)
    expect(res.body.ledgerUnavailable).toBe(true)
    expect(res.body.data).toHaveLength(1)
  })
})
