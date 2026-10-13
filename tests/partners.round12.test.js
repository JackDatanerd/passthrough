import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 12: the account-kept attribution no longer stretches the 30-day window.

let t
afterEach(() => t?.restore())
const DAY = 24 * 3600 * 1000
const GOOD = { id: 'c', code: 'K20', active: true, expires_at: null, usage_limit: null, uses_so_far: 0, tier_prices: { FIX: 3900 }, partners: { status: 'ACTIVE', email: 'k@x.co' } }
const USER = { id: 'u1', email: 'buyer@x.co' }

function setup(current = null) {
  const updates = []
  t = loadWithStubs('services/referral.service.js', {})
  const db = createFakeSupabase(q => {
    if (q.table === 'referral_codes') return { data: GOOD, error: null }
    if (q.table === 'users' && q.op === 'update') { updates.push(q.patch); return { data: null, error: null } }
    if (q.table === 'users' && q.op === 'select') return { data: current, error: null }
    return undefined
  })
  return { svc: t.mod, db, updates }
}

describe('setUserAttribution keeps the original capture time', () => {
  it('stamps referred_at with when the browser captured the code, not with now', async () => {
    const { svc, db, updates } = setup()
    const at = new Date(Date.now() - 20 * DAY).toISOString()
    const out = await svc.setUserAttribution(db, USER, 'K20', at)
    expect(out).toEqual({ stored: true, code: 'K20' })
    expect(updates[0].referred_at).toBe(at)
  })
  it('falls back to now for a missing, garbage or future capture time', async () => {
    for (const bad of [undefined, 'nonsense', new Date(Date.now() + 5 * DAY).toISOString()]) {
      t?.restore()
      const { svc, db, updates } = setup()
      await svc.setUserAttribution(db, USER, 'K20', bad)
      expect(Math.abs(Date.parse(updates[0].referred_at) - Date.now())).toBeLessThan(5000)
    }
  })
  it('refuses a capture older than the 30-day window', async () => {
    const { svc, db, updates } = setup()
    const out = await svc.setUserAttribution(db, USER, 'K20', new Date(Date.now() - 31 * DAY).toISOString())
    expect(out).toEqual({ stored: false, reason: 'expired' })
    expect(updates).toHaveLength(0)
  })
  it('never moves a code the account already holds BACKWARDS in time', async () => {
    const newer = new Date(Date.now() - 2 * DAY).toISOString()
    const { svc, db, updates } = setup({ referred_by_code: 'K20', referred_at: newer })
    const out = await svc.setUserAttribution(db, USER, 'K20', new Date(Date.now() - 20 * DAY).toISOString())
    expect(out).toEqual({ stored: true, code: 'K20', unchanged: true })
    expect(updates).toHaveLength(0)
  })
  it('a fresher click on the same code still refreshes the window', async () => {
    const older = new Date(Date.now() - 10 * DAY).toISOString()
    const { svc, db, updates } = setup({ referred_by_code: 'K20', referred_at: older })
    const at = new Date(Date.now() - 1000).toISOString()
    await svc.setUserAttribution(db, USER, 'K20', at)
    expect(updates[0].referred_at).toBe(at)
  })
})

// ── a ledger-settlement chunk failure is retried before anyone is alarmed ──────────────────────────────────────────
describe('recordPayoutCore — settlement retry', () => {
  const PARTNER = { id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', dashboard_token: 'dtok', payout_details_token: 'ptok',
    commission_rate: 0.1, payout_method: 'BANK', payout_details: { bankName: 'B', accountName: 'N', accountNumber: '1234567890' },
    payout_details_submitted_at: '2020-01-01T00:00:00.000Z', currency: 'USD' }
  const ctxOf = body => ({
    env: { FRONTEND_URL: 'https://passthrough.dev', PAYSTACK_CURRENCY: 'USD' },
    get: () => ({ id: 'admin-1', email: 'a@x.co' }),
    req: { param: () => 'p1', query: () => undefined, json: async () => body, header: () => undefined },
    header: () => {}, json: (b, status = 200) => ({ body: b, status }), executionCtx: { waitUntil: () => {} },
  })
  function run(updateResults) {
    const alerts = []
    let n = 0
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: PARTNER, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select')
        return { data: [{ id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, kind: 'SALE', payments: { status: 'SUCCESS' }, created_at: '2020-01-02T00:00:00.000Z' },
                        { id: 'l2', commission_amount_cents: 500, reverses_ledger_id: null, kind: 'SALE', payments: { status: 'SUCCESS' }, created_at: '2020-01-03T00:00:00.000Z' }], error: null }
      if (q.table === 'payouts' && q.op === 'insert') return { data: { id: 'po1', ...q.values }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'update') return updateResults[Math.min(n++, updateResults.length - 1)](q)
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async (...a) => { alerts.push(a) }, sendPayoutSent: async () => true },
    })
    return { alerts, call: () => t.mod.adminRecordPayout(ctxOf({ amountCents: 1000 })) }
  }
  const ok = q => ({ data: (q.filters.find(f => f[0] === 'in') || [])[2].map(id => ({ id, commission_amount_cents: 500 })), error: null })
  const boom = () => ({ data: null, error: { message: 'db blip' } })

  it('a one-off failure is retried and the books end up settled with no alert', async () => {
    const { alerts, call } = run([boom, ok])
    const res = await call()
    expect(res.body.ledgerSettlementFailed).toBeFalsy()
    expect(alerts).toHaveLength(0)
  })
  it('a persistent failure still raises the alert', async () => {
    const { alerts, call } = run([boom, boom])
    const res = await call()
    expect(res.body.ledgerSettlementFailed).toBe(true)
    expect(alerts).toHaveLength(1)
  })
})
