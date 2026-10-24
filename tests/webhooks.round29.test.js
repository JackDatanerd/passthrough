// Webhooks round 29 (B1): refunds are matched by Paystack refund id, not by amount - two equal partial refunds on one sale.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr })
const NOW = Date.now()
const item = over => ({ id: 41, status: 'processed', amount: 250, currency: 'USD', transaction_reference: 'ref1', updated_at: new Date(NOW - 3600e3).toISOString(), ...over })
function seed(extra = {}) {
  const world = createWorld({ payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', status: 'SUCCESS', amount_cents: 1000, currency: 'USD' }], webhook_events: [], payment_refunds: [], ...extra })
  world.rpcs.record_refund_and_total = ({ p_payment_id, p_event_id }) => {
    const row = world.t.webhook_events.find(r => r.id === p_event_id)
    const amt = Number(row?.payload?.data?.amount)
    if (row && Number.isFinite(amt) && !world.t.payment_refunds.some(r => r.payment_id === p_payment_id && r.event_key === row.event_key))
      world.t.payment_refunds.push({ id: `r${world.t.payment_refunds.length}`, payment_id: p_payment_id, event_key: row.event_key, amount_cents: amt })
    return { data: world.t.payment_refunds.filter(r => r.payment_id === p_payment_id).reduce((n, r) => n + r.amount_cents, 0), error: null }
  }
  return world
}
async function sweep(world, refunds) {
  const l = loadWithStubs('services/reconcile.service.js', { 'services/email.service.js': { sendOwnerAlert: async () => true } })
  restore = l.restore
  const r = await l.mod.sweepStalledRefunds({ PAYSTACK_SECRET_KEY: 'sk' }, world.db, { now: NOW, list: async () => ({ data: refunds }), alert: false })
  restore(); restore = null
  return r
}
function replayRefund(world, data, key, listRefunds) {
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db }, 'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async () => true, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': { listRefunds } })
  restore = l.restore
  const ev = { event: 'refund.processed', data: { transaction_reference: 'ref1', currency: 'USD', ...data } }
  world.t.webhook_events.push({ id: 'e1', provider: 'paystack', event_key: key, event_type: ev.event, reference: 'ref1', status: 'FAILED', attempts: 1, payload: ev, received_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() })
  const ctx = { env: {}, executionCtx: { waitUntil() {} }, req: { param: () => 'e1' }, get: () => ({ id: 'a' }), json: (b, s) => ({ b, s }) }
  return l.mod.replayWebhookEvent(ctx).finally(() => { restore(); restore = null })
}
const twoEqual = async () => ({ data: [{ status: 'processed', amount: 250, currency: 'USD' }, { status: 'processed', amount: 250, currency: 'USD' }] })

describe('B1: equal-amount partial refunds are told apart by refund id', () => {
  it('a lost webhook for the second of two equal refunds is recorded by the sweep', async () => {
    const world = seed()
    world.t.payment_refunds.push({ id: 'a', payment_id: 'p1', event_key: 'refund.processed:41', amount_cents: 250 })
    const r = await sweep(world, [item({ id: 41 }), item({ id: 42 })])
    expect(r.recorded).toHaveLength(1)
    expect(world.t.payment_refunds.map(x => x.event_key).sort()).toEqual(['refund.processed:41', 'sweep:42'])
  })
  it('the real event for refund 42 absorbs sweep:42 and leaves the sweep row of refund 41 alone', async () => {
    const world = seed()
    world.t.payment_refunds.push({ id: 'x', payment_id: 'p1', event_key: 'sweep:41', amount_cents: 250 }, { id: 'y', payment_id: 'p1', event_key: 'sweep:42', amount_cents: 250 })
    await replayRefund(world, { id: 42, amount: 250 }, 'refund.processed:42', twoEqual)
    expect(world.t.payment_refunds.map(x => x.event_key).sort()).toEqual(['refund.processed:42', 'sweep:41'])
    expect(world.t.payment_refunds.reduce((n, x) => n + x.amount_cents, 0)).toBe(500)
  })
  it('the real event for 42 does not eat sweep:41 when 42 has no sweep row', async () => {
    const world = seed()
    world.t.payment_refunds.push({ id: 'x', payment_id: 'p1', event_key: 'sweep:41', amount_cents: 250 })
    await replayRefund(world, { id: 42, amount: 250 }, 'refund.processed:42', twoEqual)
    expect(world.t.payment_refunds.map(x => x.event_key).sort()).toEqual(['refund.processed:42', 'sweep:41'])
  })
  it('an event with no refund id (refund_reference only) still replaces an equal-amount sweep row', async () => {
    const world = seed()
    world.t.payment_refunds.push({ id: 'x', payment_id: 'p1', event_key: 'sweep:41', amount_cents: 250 })
    await replayRefund(world, { refund_reference: 'rr1', amount: 250 }, 'refund.processed:rr1', async () => ({ data: [{ status: 'processed', amount: 250, currency: 'USD' }] }))
    expect(world.t.payment_refunds.map(x => x.event_key)).toEqual(['refund.processed:rr1'])
  })
  it('a refund_reference-keyed row covers exactly one Paystack refund; the equal one is still recorded', async () => {
    const world = seed()
    world.t.payment_refunds.push({ id: 'a', payment_id: 'p1', event_key: 'refund.processed:rr1', amount_cents: 250 })
    const r = await sweep(world, [item({ id: 41 }), item({ id: 42 })])
    expect(r.recorded).toHaveLength(1)
    expect(world.t.payment_refunds).toHaveLength(2)
  })
  it('an ambiguous inbox event covers one refund only', async () => {
    const world = seed()
    world.t.webhook_events.push({ id: 'i1', provider: 'paystack', event_type: 'refund.processed', status: 'PROCESSED', reference: 'ref1', payload: { event: 'refund.processed', data: { refund_reference: null, amount: 250 } } })
    const r = await sweep(world, [item({ id: 41 }), item({ id: 42 })])
    expect(r.recorded).toHaveLength(1)
    expect(world.t.payment_refunds).toHaveLength(1)
  })
  it('a healthy ledger reports nothing and a second sweep adds nothing', async () => {
    const world = seed()
    world.t.payment_refunds.push({ id: 'a', payment_id: 'p1', event_key: 'refund.processed:41', amount_cents: 250 }, { id: 'b', payment_id: 'p1', event_key: 'sweep:42', amount_cents: 250 })
    const r = await sweep(world, [item({ id: 41 }), item({ id: 42 })])
    expect(r.recorded).toHaveLength(0); expect(r.missedPartial).toHaveLength(0)
    expect(world.t.payment_refunds).toHaveLength(2)
  })
})
