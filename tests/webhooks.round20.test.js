// Webhooks round 20: B1 sweep rows are not proof of delivery, B2 admin "clear dispute" sticks across the sweep, B3 dispute card ignores answered disputes.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr; vi.unstubAllGlobals() })
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString()
const hoursAhead = h => new Date(Date.now() + h * 3600 * 1000).toISOString()

function load(world) {
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
const stampReceived = world => { for (const r of world.t.webhook_events || []) if (!r.received_at) r.received_at = new Date().toISOString() }   // real column: DEFAULT now()
const dispute = () => ({ id: 777, status: 'awaiting-merchant-feedback', resolution: null, refund_amount: 900, currency: 'USD', dueAt: hoursAhead(10), transaction: { reference: 'ref1', amount: 900, currency: 'USD' } })

describe('B1: a sweep-written inbox row is not a delivery from Paystack', () => {
  it('keeps "refused" lit and lastEventAt empty after the sweep', async () => {
    const world = createWorld({
      payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'SUCCESS', amount_cents: 900, currency: 'USD', scan_id: 's1', user_id: 'u1' }],
      system_state: [{ key: 'webhook_rejected_flagged:paystack', value: { last_at: hoursAgo(2), last_reason: 'signature' } }],
      webhook_events: [],
    })
    const mod = load(world)
    await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk_test_x' }, { waitUntil() {} }, world.db, { list: async () => ({ data: [dispute()] }) })
    stampReceived(world)
    expect(world.t.webhook_events.length).toBe(1)
    const h = await mod.computeWebhookHealth(world.db)
    expect(h.lastEventAt).toBeNull()
    expect(h.rejectedSinceLastEvent).toEqual(['paystack'])
  })
  it('a real delivery still counts, even with a newer sweep row beside it', async () => {
    const real = hoursAgo(3)
    const world = createWorld({
      payments: [], system_state: [],
      webhook_events: [
        { id: 1, provider: 'paystack', event_key: 'charge.success:a', event_type: 'charge.success', status: 'PROCESSED', received_at: real, note: null, payload: {} },
        { id: 2, provider: 'paystack', event_key: 'charge.dispute.create:9', event_type: 'charge.dispute.create', status: 'PROCESSED', received_at: hoursAgo(1), note: 'caught up by the dispute sweep — marked DISPUTED', payload: { swept: true } },
      ],
    })
    const h = await load(world).computeWebhookHealth(world.db)
    expect(h.lastEventAt).toBe(real)
  })
})

describe('B2: Clear dispute sticks when the create was handled live while the payment was unsettled', () => {
  it('does not re-mark DISPUTED on the sweep after the admin cleared it', async () => {
    const world = createWorld({
      payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'PENDING', amount_cents: 900, currency: 'USD', scan_id: 's1', user_id: 'u1' }],
      webhook_events: [], system_state: [],
    })
    world.unique.webhook_events = [['provider', 'event_key']]
    const mod = load(world)
    const ev = { event: 'charge.dispute.create', data: { id: 777, status: 'awaiting-merchant-feedback', refund_amount: 900, due_at: hoursAhead(10), transaction: { reference: 'ref1' } } }
    const inbox = await mod.recordEvent(world.db, { eventKey: mod.eventKeyFor(ev, 'h'), eventType: ev.event, reference: 'ref1', payload: mod.redactEvent(ev) })
    await mod.markEvent(world.db, inbox, 'PROCESSED', undefined)   // live create while PENDING: nothing marked, empty note
    world.t.payments[0].status = 'SUCCESS'                         // charge.success catches up
    const list = async () => ({ data: [dispute()] })
    const s1 = await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk_test_x' }, { waitUntil() {} }, world.db, { list })
    expect(s1.actioned.length).toBe(1)
    expect(world.t.payments[0].status).toBe('DISPUTED')
    expect(world.t.webhook_events[0].note).toMatch(/marked DISPUTED/)
    world.t.payments[0].status = 'SUCCESS'; world.t.payments[0].disputed_at = null   // admin: Clear dispute
    const s2 = await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk_test_x' }, { waitUntil() {} }, world.db, { list })
    expect(s2.actioned.length).toBe(0)
    expect(world.t.payments[0].status).toBe('SUCCESS')
  })
})

describe('B3: the dashboard dispute summary only counts disputes still awaiting us', () => {
  const fakeDb = (rows, { withAnswered = true } = {}) => ({ from: () => ({ select: (cols, opts) => {
    if (opts && opts.head) return { eq: async () => ({ count: rows.length, error: null }) }
    const wantsAnswered = /dispute_answered_at/.test(cols)
    const run = async () => (wantsAnswered && !withAnswered)
      ? { data: null, error: { code: '42703', message: 'column payments.dispute_answered_at does not exist' } }
      : { data: rows.map(r => wantsAnswered ? r : { dispute_due_at: r.dispute_due_at }), error: null }
    return { eq: () => ({ not: () => ({ order: () => ({ limit: run }) }) }) }
  } }) })
  const rows = [
    { dispute_due_at: hoursAgo(120), dispute_answered_at: hoursAgo(123) },   // contested days ago, waiting on the bank
    { dispute_due_at: hoursAhead(5), dispute_answered_at: null },
  ]
  it('skips answered disputes for next deadline and overdue', async () => {
    const s = await load(createWorld({})).openDisputeSummary(fakeDb(rows))
    expect(s).toMatchObject({ count: 2, overdue: 0, answered: 1, nextDueAt: rows[1].dispute_due_at })
  })
  it('without migration 0097 every dispute counts as awaiting (as before)', async () => {
    const s = await load(createWorld({})).openDisputeSummary(fakeDb(rows, { withAnswered: false }))
    expect(s.overdue).toBe(1)
    expect(s.answered).toBe(0)
  })
})
