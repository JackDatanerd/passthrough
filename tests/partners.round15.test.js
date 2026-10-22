import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 15: payout-due reminder re-checks and includes paused partners, erasure renames referral codes,
// a newer attribution is not displaced by an older one, the cycle upper bound is exact, limiter wiring.

let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD', OWNER_ALERT_EMAIL: 'owner@x.co' },
  get: () => ({ id: 'admin-1' }),
  req: { param: () => 'p1', query: () => undefined, json: async () => over.body ?? {}, header: () => undefined },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()
const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } } }

function load(o = {}) {
  const st = { alerts: [], queries: [], updates: [] }
  const db = createFakeSupabase(q => {
    st.queries.push(q)
    if (q.table === 'partners' && q.op === 'select') return { data: o.partners ?? [], error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: o.ledger ?? [], error: null }
    if (q.table === 'referral_codes' && q.op === 'select') return { data: o.codes ?? [], error: null }
    if (q.op === 'update') { st.updates.push(q); return { data: null, error: null } }
    return undefined
  })
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (...a) => { st.alerts.push(a); return true } },
  })
  return { ...m, st, db }
}

describe('sweepPayoutDue (round 15)', () => {
  const ROW = { id: 'l1', partner_id: 'p1', commission_amount_cents: 2500, payout_id: null, reverses_ledger_id: null, kind: 'SALE', created_at: daysAgo(40), payments: { status: 'COMPLETED' } }

  it('includes a PAUSED partner who is still owed money', async () => {
    t = load({ partners: [{ id: 'p1', email: 'k@x.co', payout_method: 'BANK', status: 'PAUSED' }], ledger: [ROW] })
    const out = await t.mod.sweepPayoutDue({ OWNER_ALERT_EMAIL: 'o@x.co', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv() }, t.db)
    expect(out).toMatchObject({ sent: true, ready: 1, readyCents: 2500 })
  })

  it('does not close the cycle when nothing is ready yet: it re-checks after the short marker lapses', async () => {
    const store = kv()
    const env = { OWNER_ALERT_EMAIL: 'o@x.co', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: store }
    t = load({ partners: [{ id: 'p1', email: 'k@x.co', payout_method: 'BANK' }], ledger: [] })
    expect((await t.mod.sweepPayoutDue(env, t.db)).sent).toBe(false)
    const keys = [...store.m.keys()]
    expect(keys.some(k => k.startsWith('partner-payout-due-checked:'))).toBe(true)
    expect(keys.some(k => k.startsWith('partner-payout-due:'))).toBe(false)
    for (const k of keys) store.m.delete(k)                       // the 6-hour marker lapsed
    t.restore()
    t = load({ partners: [{ id: 'p1', email: 'k@x.co', payout_method: 'BANK' }], ledger: [ROW] })   // commission has become payable
    expect((await t.mod.sweepPayoutDue(env, t.db)).sent).toBe(true)
  })
})

describe('adminAnonymizePartner renames referral codes (round 15)', () => {
  it('forgets the code text on accounts and payments, then renames the code to a placeholder', async () => {
    t = load({
      partners: { id: 'p1', email: 'anna@x.co', previous_emails: [] },
      codes: [{ id: 'abcdef12-0000-0000-0000-000000000000', code: 'ANNA20' }],
    })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'erasure request' } }))
    expect(res.status).toBe(200)
    const ups = t.st.updates
    const iUsers = ups.findIndex(u => u.table === 'users' && u.patch.referred_by_code === null)
    const iPay = ups.findIndex(u => u.table === 'payments' && u.patch.referral_code === 'REMOVED-ABCDEF12')
    const iRename = ups.findIndex(u => u.table === 'referral_codes' && u.patch.code === 'REMOVED-ABCDEF12')
    const iRow = ups.findIndex(u => u.table === 'partners' && u.patch.name === 'Removed partner')
    expect(iUsers).toBeGreaterThanOrEqual(0)
    expect(iUsers).toBeLessThan(iPay)
    expect(iPay).toBeLessThan(iRename)
    expect(iRename).toBeLessThan(iRow)                           // the partner row is still changed LAST
  })
})

describe('setUserAttribution refuses an older different code (round 15)', () => {
  const run = async (current, capturedAt) => {
    t = loadWithStubs('services/referral.service.js', {})
    const db = createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: { id: 'c1', code: 'NEW', active: true, tier_prices: { FIX: 1 }, partner_id: 'p', partners: { status: 'ACTIVE', email: 'p@x.co' } }, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: current, error: null }
      return { data: null, error: null }
    })
    return t.mod.setUserAttribution(db, { id: 'u1', email: 'b@x.co' }, 'new', capturedAt)
  }
  it('keeps a newer held code when an older one is pushed', async () => {
    const out = await run({ referred_by_code: 'HELD', referred_at: daysAgo(1) }, daysAgo(10))
    expect(out).toEqual({ stored: false, reason: 'older' })
  })
  it('lets a newer code replace an older held one', async () => {
    const out = await run({ referred_by_code: 'HELD', referred_at: daysAgo(10) }, daysAgo(1))
    expect(out.stored).toBe(true)
  })
})

describe('wiring (round 15)', () => {
  it('cycle payouts use an exclusive bound one millisecond after the period end', async () => {
    const src = (await import('node:fs')).readFileSync('src/controllers/partners.controller.js', 'utf8')
    expect(src).toMatch(/\.lt\('created_at', new Date\(Date\.parse\(body\.periodEnd\) \+ 1\)/)
    expect(src).not.toMatch(/\.lte\('created_at', body\.periodEnd\)/)
  })
  it('terms page and payout statements have their own limiter buckets', async () => {
    const routes = (await import('node:fs')).readFileSync('src/routes/partners.routes.js', 'utf8')
    expect(routes).toMatch(/'\/program',\s*rl\.partnerProgram/)
    expect(routes).toMatch(/query\('payoutId'\) \? rl\.partnerExport/)
  })
})
