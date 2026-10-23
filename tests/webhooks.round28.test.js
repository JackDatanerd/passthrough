// Webhooks round 28: B2 refund.failed releases the post-queue claim; G1 the stalled-refund sweep records a lost partial refund (and the real
// event later replaces it instead of double counting); G2 Contest / Accept refuse an already-answered dispute.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr })

function loadWebhooks(world, ps = {}) {
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async () => true, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': ps,
  })
  restore = l.restore
  return l.mod
}
const refundEvent = (type, data) => ({ event: type, data: { transaction_reference: 'ref1', currency: 'USD', ...data } })
function replay(world, mod, ev, key) {
  world.t.webhook_events.push({ id: 'e1', provider: 'paystack', event_key: key, event_type: ev.event, reference: 'ref1', status: 'FAILED', attempts: 1,
    payload: ev, received_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() })
  const ctx = { env: {}, executionCtx: { waitUntil() {} }, req: { param: () => 'e1' }, get: () => ({ id: 'admin1' }), json: (b, s) => ({ b, s }) }
  return mod.replayWebhookEvent(ctx)
}
function seed(extra = {}) {
  const world = createWorld({ payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', refund_claimed_at: new Date(Date.now() + 14 * 60000).toISOString() }],
    webhook_events: [], payment_refunds: [], ...extra })
  world.rpcs.record_refund_and_total = ({ p_payment_id, p_event_id }) => {
    const row = world.t.webhook_events.find(r => r.id === p_event_id)
    const amt = Number(row?.payload?.data?.amount)
    if (row && Number.isFinite(amt) && !world.t.payment_refunds.some(r => r.payment_id === p_payment_id && r.event_key === row.event_key))
      world.t.payment_refunds.push({ id: `r${world.t.payment_refunds.length}`, payment_id: p_payment_id, event_key: row.event_key, amount_cents: amt })
    return { data: world.t.payment_refunds.filter(r => r.payment_id === p_payment_id).reduce((n, r) => n + r.amount_cents, 0), error: null }
  }
  return world
}

describe('B2: refund.failed hands the claim back', () => {
  it('clears refund_claimed_at so Admin -> Payments -> Refund works straight away', async () => {
    const world = seed()
    const mod = loadWebhooks(world)
    await replay(world, mod, refundEvent('refund.failed', { refund_reference: 'rr1', amount: 2900 }), 'refund.failed:rr1')
    expect(world.t.payments[0].refund_claimed_at).toBeNull()
    expect(world.t.payments[0].refund_failed_at).toBeTruthy()
  })
})

describe('G1: a lost partial refund is recorded by the sweep and never counted twice', () => {
  const NOW = Date.now()
  const item = over => ({ id: 41, status: 'processed', amount: 1000, currency: 'USD', transaction_reference: 'ref1', updated_at: new Date(NOW - 3600e3).toISOString(), ...over })
  async function sweep(world, refunds) {
    const l = loadWithStubs('services/reconcile.service.js', { 'services/email.service.js': { sendOwnerAlert: async () => true } })
    restore = l.restore
    return l.mod.sweepStalledRefunds({ PAYSTACK_SECRET_KEY: 'sk' }, world.db, { now: NOW, list: async () => ({ data: refunds }), alert: false })
  }
  it('inserts sweep:<refund id> once, and a second run adds nothing', async () => {
    const world = seed()
    const a = await sweep(world, [item()])
    expect(a.recorded).toHaveLength(1)
    expect(world.t.payment_refunds).toEqual([expect.objectContaining({ payment_id: 'p1', event_key: 'sweep:41', amount_cents: 1000 })])
    restore()
    const b = await sweep(world, [item()])
    expect(b.recorded).toHaveLength(0); expect(b.missedPartial).toHaveLength(0)
    expect(world.t.payment_refunds).toHaveLength(1)
    expect(world.t.payments[0].status).toBe('SUCCESS')
  })
  it('skips a refund Paystack gave no id for', async () => {
    const world = seed()
    const a = await sweep(world, [item({ id: undefined })])
    expect(a.recorded).toHaveLength(0); expect(world.t.payment_refunds).toHaveLength(0)
  })
  it('the real refund.processed later replaces the sweep row: total stays 1000, no reversal', async () => {
    const world = seed()
    await sweep(world, [item()]); restore()
    const mod = loadWebhooks(world, { listRefunds: async () => ({ data: [{ status: 'processed', amount: 1000, currency: 'USD' }] }) })
    const r = await replay(world, mod, refundEvent('refund.processed', { id: 41, amount: 1000 }), 'refund.processed:41')
    expect(world.t.payment_refunds.map(x => [x.event_key, x.amount_cents])).toEqual([['refund.processed:41', 1000]])
    expect(world.t.payments[0].status).toBe('SUCCESS')
    expect(r.b.success).toBe(true)
  })
  it('replaying an already-recorded event does not delete a sweep row that belongs to another equal refund', async () => {
    const world = seed()
    world.t.payment_refunds.push({ id: 'a', payment_id: 'p1', event_key: 'refund.processed:41', amount_cents: 1000 }, { id: 'b', payment_id: 'p1', event_key: 'sweep:42', amount_cents: 1000 })
    const mod = loadWebhooks(world, { listRefunds: async () => ({ data: [{ status: 'processed', amount: 1000, currency: 'USD' }, { status: 'processed', amount: 1000, currency: 'USD' }] }) })
    await replay(world, mod, refundEvent('refund.processed', { id: 41, amount: 1000 }), 'refund.processed:41')
    expect(world.t.payment_refunds.map(x => x.event_key).sort()).toEqual(['refund.processed:41', 'sweep:42'])
  })
  it('a total holding a sweep row is checked against Paystack before it can reverse the sale', async () => {
    const world = seed()
    world.t.payment_refunds.push({ id: 'x', payment_id: 'p1', event_key: 'sweep:7', amount_cents: 2000 })
    // Paystack says only 1000 + 1000 = 2000 processed in total: the sweep row plus a 900 event would read 2900 locally.
    const mod = loadWebhooks(world, { listRefunds: async () => ({ data: [{ status: 'processed', amount: 2000, currency: 'USD' }] }) })
    await replay(world, mod, refundEvent('refund.processed', { refund_reference: 'rr9', amount: 900 }), 'refund.processed:rr9')
    expect(world.t.payments[0].status).toBe('SUCCESS')
  })
})

describe('G2: contest / accept refuse an answered dispute', () => {
  it('409 before any Paystack call', async () => {
    const world = createWorld({ payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', amount_cents: 900, currency: 'USD', scan_id: 's1', dispute_id: '7', dispute_answered_at: new Date().toISOString(), dispute_answer: 'contested' }], webhook_events: [] })
    const boom = () => { throw new Error('Paystack must not be called') }
    const mod = loadWebhooks(world, { fetchDispute: boom, acceptDispute: boom, listDisputes: boom, declineDispute: boom })
    const ctx = { env: {}, req: { param: () => 'ref1', json: async () => ({}) }, get: () => ({ id: 'a' }), json: (b, s) => ({ b, s }) }
    for (const fn of [mod.acceptPaymentDispute, mod.contestPaymentDispute]) {
      const r = await fn(ctx)
      expect(r.s).toBe(409); expect(r.b.message).toMatch(/already answered \(contested\)/)
    }
  })
})
