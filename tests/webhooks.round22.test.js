// Webhooks round 22: B1 a second dispute (different id) on an already-DISPUTED payment starts unanswered; B2 the stalled-refund sweep does not
// report a partial refund as "never recorded" when this app received it (an ambiguous refund event is deliberately not added to payment_refunds).
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr })
const hoursAhead = h => new Date(Date.now() + h * 3600 * 1000).toISOString()

function loadWebhooks(world) {
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async () => true, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': {},
  })
  restore = l.restore
  return l.mod
}
const answeredPayment = (over = {}) => ({ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', amount_cents: 900, currency: 'USD', scan_id: 's1', user_id: 'u1',
  dispute_id: '777', dispute_due_at: hoursAhead(-5), dispute_answered_at: new Date().toISOString(), dispute_answer: 'contested', ...over })
const createEvent = id => ({ event: 'charge.dispute.create', data: { id, status: 'awaiting-merchant-feedback', due_at: hoursAhead(10), transaction: { reference: 'ref1', amount: 900, currency: 'USD' } } })
describe('B1: a second dispute on an already-DISPUTED payment is not inherited as answered', () => {
  // Drive processDispute through the stored-event path an admin Replay uses (the same handler a live delivery reaches).
  async function process(world, ev) {
    const mod = loadWebhooks(world)
    world.t.webhook_events.push({ id: 'e1', provider: 'paystack', event_key: `charge.dispute.create:${ev.data.id}`, event_type: 'charge.dispute.create',
      reference: 'ref1', status: 'FAILED', attempts: 1, payload: ev, received_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() })
    const ctx = { env: {}, executionCtx: { waitUntil() {} }, req: { param: () => 'e1' }, get: () => ({ id: 'admin1' }), json: (b, s) => ({ b, s }) }
    return mod.replayWebhookEvent(ctx)
  }
  it('a create for a different dispute id resets the answer; the same id (a redelivery) does not', async () => {
    const world = createWorld({ payments: [answeredPayment()], webhook_events: [] })
    await process(world, createEvent(888))
    expect(world.t.payments[0].dispute_id).toBe('888')
    expect(world.t.payments[0].dispute_answered_at).toBeNull()
    expect(world.t.payments[0].dispute_answer).toBeNull()
    restore(); restore = null
    const same = createWorld({ payments: [answeredPayment()], webhook_events: [] })
    await process(same, createEvent(777))
    expect(same.t.payments[0].dispute_answered_at).toBeTruthy()
    expect(same.t.payments[0].dispute_answer).toBe('contested')
  })
})

describe('B2: sweepStalledRefunds and ambiguous (unrecorded-by-design) partial refunds', () => {
  const NOW = Date.now()
  function rig({ paymentRefunds = [], events = [] } = {}) {
    const world = createWorld({
      payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD' }],
      payment_refunds: paymentRefunds, webhook_events: events,
    })
    const alerts = []
    const l = loadWithStubs('services/reconcile.service.js', { 'services/email.service.js': { sendOwnerAlert: async (e, s, m) => { alerts.push({ s, m }); return true } } })
    restore = l.restore
    const env = { PAYSTACK_SECRET_KEY: 'sk' }
    const refunds = [{ id: 1, status: 'processed', amount: 1000, currency: 'USD', transaction_reference: 'ref1', updated_at: new Date(NOW).toISOString() }]
    return { world, alerts, run: () => l.mod.sweepStalledRefunds(env, world.db, { now: NOW, list: async () => ({ data: refunds }) }) }
  }
  it('is not reported when a PROCESSED refund.processed inbox row for that reference carries the amount', async () => {
    const r = rig({ events: [{ id: 'w1', provider: 'paystack', event_key: 'refund.processed:ref1:1000', event_type: 'refund.processed', reference: 'ref1', status: 'PROCESSED', payload: { event: 'refund.processed', data: { transaction_reference: 'ref1', amount: '1000' } } }] })
    const a = await r.run()
    expect(a.missedPartial).toHaveLength(0)
    expect(r.alerts).toHaveLength(0)
  })
  it('is still reported when neither payment_refunds nor the inbox has seen it (a genuinely lost webhook)', async () => {
    const r = rig({ events: [{ id: 'w2', provider: 'paystack', event_key: 'refund.processed:ref1:500', event_type: 'refund.processed', reference: 'ref1', status: 'PROCESSED', payload: { event: 'refund.processed', data: { amount: 500 } } },
      { id: 'w3', provider: 'paystack', event_key: 'refund.processed:ref1:1000', event_type: 'refund.processed', reference: 'ref1', status: 'FAILED', payload: { data: { amount: 1000 } } }] })
    const a = await r.run()
    expect(a.missedPartial).toHaveLength(1)
    expect(a.missedPartial[0]).toMatchObject({ reference: 'ref1', paystack: 1000, recorded: 0 })
  })
})
