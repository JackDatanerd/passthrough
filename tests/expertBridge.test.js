// Experts Phase 2A (E): the three bridge functions, each doing exactly one thing, logged, idempotent, human orders only.
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')
const J1 = '00000000-0000-4000-8000-000000000001', J2 = '00000000-0000-4000-8000-000000000002'
const SETTINGS = { prices: { polish: 49, seven_day: 99, forty_eight_hour: 119, twenty_four_hour: 149, cover_letter: 19 }, pay: { polish: 20, seven_day: 50, forty_eight_hour: 70, twenty_four_hour: 90, cover_letter: 8 },
  tiers_enabled: { polish: true, seven_day: true, forty_eight_hour: true, twenty_four_hour: true }, pilot_cap_orders: 10, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3, concurrent_cap: 2, turnaround_hours: { forty_eight_hour: 48 }, internal_buffer_hours: { forty_eight_hour: 8 } }
let t, w, queued, transitions
afterEach(() => t && t.restore())
function setup(over = {}) {
  w = createWorld({ system_state: [{ key: 'human_pilot', value: SETTINGS }], human_jobs: [{ id: J1, state: 'awaiting_payment', tier: 'forty_eight_hour', payment_id: 'p1' }, { id: J2, state: 'awaiting_payment', tier: 'polish', payment_id: 'p2' }],
    payments: [{ id: 'p1', amount_cents: 11900, currency: 'USD', status: over.status || 'SUCCESS', paystack_ref: 'r1', product_kind: 'human_forty_eight_hour' }, { id: 'p2', amount_cents: 4900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'r2', product_kind: null }] })
  w.unique.expert_bridge_calls = [['fn', 'idem_key']]; queued = []; transitions = []
  w.rpcs.human_job_transition = a => { transitions.push(a); return { data: { ok: true, state: a.p_to, version: 1, event_id: 1 }, error: null } }
  t = loadWithStubs('services/expertBridge.service.js', { 'services/refund.service.js': { queueRefund: async (_e, _s, pay, o) => { queued.push({ id: pay.id, ...o }); return { ok: true, amountCents: o.amountCents ?? pay.amount_cents, partial: false, queued: true } } } })
  return t.mod
}

describe('createJobFromPayment', () => {
  it('moves a PAID human order to offered through the engine, once, with the deadlines from settings', async () => {
    const b = setup(); const r = await b.createJobFromPayment(w.db, { jobId: J1, actorId: null }); expect(r).toMatchObject({ ok: true, state: 'offered' })
    expect(transitions).toHaveLength(1); expect(transitions[0]).toMatchObject({ p_to: 'offered', p_trigger: 'payment_confirmed', p_actor_kind: 'system', p_idem_key: 'payment:p1', p_event_kind: 'paid' })
    const promised = new Date(transitions[0].p_promised).getTime(), internal = new Date(transitions[0].p_internal).getTime(); expect(promised - internal).toBe(8 * 3600e3)
    expect((await b.createJobFromPayment(w.db, { jobId: J1 })).replay).toBe(true); expect(transitions).toHaveLength(1)
    expect(w.t.expert_bridge_calls).toHaveLength(1); expect(w.t.expert_bridge_calls[0]).toMatchObject({ fn: 'create_job_from_payment', outcome: 'ok' })
  })
  it('refuses an unpaid payment and a payment that is not a human order', async () => {
    let b = setup({ status: 'PENDING' }); expect(await b.createJobFromPayment(w.db, { jobId: J1 })).toMatchObject({ ok: false, code: 'NOT_PAID' }); expect(transitions).toHaveLength(0)
    t.restore(); b = setup(); expect(await b.createJobFromPayment(w.db, { jobId: J2 })).toMatchObject({ ok: false, code: 'NOT_A_HUMAN_ORDER' }); expect(transitions).toHaveLength(0)
  })
})

describe('readHumanOrderPayment', () => {
  it('returns the amount, currency and status and nothing that identifies the customer or the payment reference', async () => {
    const b = setup(); const r = await b.readHumanOrderPayment(w.db, { jobId: J1, actorId: 'adm' })
    expect(r.data).toEqual({ amountCents: 11900, currency: 'USD', paymentStatus: 'SUCCESS', jobState: 'awaiting_payment' }); expect(JSON.stringify(r)).not.toMatch(/r1|paystack|user/i)
    expect(w.t.expert_bridge_calls[0]).toMatchObject({ fn: 'read_human_order_payment', actor_id: 'adm' })
  })
  it('refuses a job that does not exist or is not a human order', async () => {
    const b = setup(); expect((await b.readHumanOrderPayment(w.db, { jobId: 'nope' })).code).toBe('NOT_FOUND'); expect((await b.readHumanOrderPayment(w.db, { jobId: J2 })).code).toBe('NOT_A_HUMAN_ORDER')
  })
})

describe('refundHumanOrder', () => {
  it('queues one refund through the existing refund path; the same key never queues a second', async () => {
    const b = setup(); const a = await b.refundHumanOrder({}, w.db, { jobId: J1, reason: 'duplicate', actorId: 'adm', idemKey: 'k-12345678' }); expect(a).toMatchObject({ ok: true, queued: true })
    const again = await b.refundHumanOrder({}, w.db, { jobId: J1, reason: 'duplicate', actorId: 'adm', idemKey: 'k-12345678' }); expect(again).toMatchObject({ ok: true, replay: true })
    expect(queued).toHaveLength(1); expect(queued[0].id).toBe('p1'); expect(w.t.expert_bridge_calls).toHaveLength(1)
  })
  it('needs a key, a sane amount and a human order', async () => {
    const b = setup()
    expect((await b.refundHumanOrder({}, w.db, { jobId: J1, reason: 'x', actorId: 'a' })).code).toBe('KEY_REQUIRED')
    for (const amountCents of [0, -5, 1.5, '100']) expect((await b.refundHumanOrder({}, w.db, { jobId: J1, reason: 'x', actorId: 'a', idemKey: 'k-1', amountCents })).code).toBe('BAD_AMOUNT')
    expect((await b.refundHumanOrder({}, w.db, { jobId: J2, reason: 'x', actorId: 'a', idemKey: 'k-2' })).code).toBe('NOT_A_HUMAN_ORDER'); expect(queued).toHaveLength(0)
  })
  it('records a refusal from the refund path and does not retry or throw', async () => {
    const b = setup(); t.restore()
    t = loadWithStubs('services/expertBridge.service.js', { 'services/refund.service.js': { queueRefund: async () => ({ ok: false, code: 'OPEN_REFUND', status: 409, message: 'in progress' }) } })
    const r = await t.mod.refundHumanOrder({}, w.db, { jobId: J1, reason: 'x', actorId: 'a', idemKey: 'k-3' }); expect(r).toMatchObject({ ok: false, code: 'OPEN_REFUND', status: 409 })
    expect(w.t.expert_bridge_calls[0]).toMatchObject({ outcome: 'refused', code: 'OPEN_REFUND' })
  })
  it('a crash in the refund path is recorded as failed and re-thrown', async () => {
    setup(); t.restore(); t = loadWithStubs('services/expertBridge.service.js', { 'services/refund.service.js': { queueRefund: async () => { throw new Error('boom') } } })
    await expect(t.mod.refundHumanOrder({}, w.db, { jobId: J1, reason: 'x', actorId: 'a', idemKey: 'k-4' })).rejects.toThrow('boom'); expect(w.t.expert_bridge_calls[0].outcome).toBe('failed')
  })
})
