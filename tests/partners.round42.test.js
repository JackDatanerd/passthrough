import { describe, it, expect, afterEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

let t
afterEach(() => t?.restore())
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://x.co', JWT_SECRET: 's'.repeat(40), PAYSTACK_CURRENCY: 'USD' },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: { param: () => 'p', query: k => (over.query || {})[k], json: async () => over.body ?? {}, header: () => undefined },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})

describe('round 42: sweeps are independent of the stale-payments query', () => {
  it('still prunes reservations when the stale query errors', async () => {
    const pruned = vi.fn(async () => {})
    t = loadWithStubs('services/reconcile.service.js', {
      'services/referral.service.js': { pruneReferralCodeReservations: pruned, sweepExpiringCodes: async () => ({}), releaseCodeReservation: async () => {} },
      'controllers/partners.controller.js': { sweepPayoutDue: async () => ({}), sweepPayoutDetailsReminders: async () => ({}) },
    })
    const db = createFakeSupabase(q => (q.table === 'payments' ? { data: null, error: { message: 'boom' } } : { data: [], error: null }))
    const out = await t.mod.sweepStalePendingPayments({}, db)
    expect(pruned).toHaveBeenCalled()
    expect(out.error).toBe('boom')
  })
})

describe('round 42: bulk reveals fail closed when the audit entry cannot be written', () => {
  it('payout export and tax summary return 503 and read no partner data', async () => {
    const db = createFakeSupabase(q => (q.table === 'admin_audit_log' ? { data: null, error: { message: 'down' } } : { data: [], error: null }))
    t = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async () => {} },
    })
    for (const fn of [t.mod.adminPayoutRunExport, t.mod.adminTaxSummary]) {
      const res = await fn(ctxOf())
      expect(res.status).toBe(503)
    }
    expect(db.calls.map(c => c.table).filter(x => x !== 'admin_audit_log')).toEqual([])
  })
})
