// Webhooks round 26 (section 8, independent pass).
//   B1  sweepDisputes does not re-run the resolution of a dispute the payment no longer tracks (a newer one is open), hour after hour.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')
let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr })

function setup(over = {}) {
  const w = createWorld({ payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', dispute_id: '200', amount_cents: 2900, currency: 'USD', scan_id: 's1', user_id: 'u1', ...over }],
    webhook_events: [], system_state: [], scans: [], users: [], commission_ledger: [] })
  w.unique.webhook_events = [['provider', 'event_key']]
  const alerts = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => w.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async (e, s) => { alerts.push(s); return true } },
    'services/paystack.service.js': { listDisputes: async () => ({ data: [] }), fetchDispute: async () => ({ data: {} }) },
  })
  restore = l.restore
  return { w, mod: l.mod, alerts }
}
const sweep = (mod, w, d) => mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'k' }, { waitUntil() {} }, w.db, { list: async () => ({ data: [d] }) })
const resolved = (id, resolution = 'declined') => ({ id, status: 'resolved', resolution, refund_amount: 2900, transaction: { reference: 'ref1' } })

describe('B1: the sweep leaves an older dispute\'s resolution alone', () => {
  it('does nothing, however many times it runs, and sends no email', async () => {
    const { w, mod, alerts } = setup()
    for (let i = 0; i < 3; i++) { const r = await sweep(mod, w, resolved(100)); expect(r.actioned).toHaveLength(0) }
    expect(alerts).toHaveLength(0)
    expect(w.t.payments[0].status).toBe('DISPUTED')
  })
  it('the tracked dispute\'s own declined resolution is still caught up', async () => {
    const { w, mod } = setup()
    const r = await sweep(mod, w, resolved(200))
    expect(r.actioned).toHaveLength(1)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('a payment with no stored dispute id behaves as before', async () => {
    const { w, mod } = setup({ dispute_id: null })
    const r = await sweep(mod, w, resolved(100))
    expect(r.actioned).toHaveLength(1)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
})
