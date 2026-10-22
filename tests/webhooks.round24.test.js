// Webhooks round 24 (section 8, independent pass).
//   B1  a dispute event that matches no payment is IGNORED (replayable), not PROCESSED (Replay answered 409 right after the alert said "Replay").
//   B2  the stored copy of an event is cleaned of NUL / lone surrogates, and a body the database still refuses is dropped rather than refused for ever.
//   B3  the Resend "deliveries refused" notice allows for the throttled Resend health stamp.
//   B4  delivery health judges a sale by when it was PAID, not when checkout began.
//   B5  the old-open-disputes sweep rotates on payments.dispute_checked_at, not the reversal sweep's last_reconciled_at.
//   G1  refund.failed stamps payments.refund_failed_at; Admin -> Payments surfaces it; the full refund clears it.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr })
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString()
const minsAgo = m => new Date(Date.now() - m * 60 * 1000).toISOString()
const daysAgo = d => hoursAgo(d * 24)

function load(world, paystack = {}) {
  const alerts = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { alerts.push({ subject, message }); return true }, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': paystack,
  })
  restore = l.restore
  return { mod: l.mod, alerts }
}
const replayCtx = id => ({ env: {}, executionCtx: { waitUntil() {} }, req: { param: () => id }, get: () => ({ id: 'admin1' }), json: (b, s) => ({ b, s }) })
const storedRow = (over = {}) => ({ id: 'e1', provider: 'paystack', status: 'FAILED', attempts: 1, received_at: new Date().toISOString(), last_attempt_at: new Date().toISOString(), ...over })

// ── B1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B1: a dispute with no payment is IGNORED and stays replayable', () => {
  const create = { event: 'charge.dispute.create', data: { id: 5, status: 'awaiting-merchant-feedback', due_at: new Date(Date.now() + 36e5).toISOString(), transaction: { reference: 'late-ref' } } }
  const row = () => storedRow({ event_key: 'charge.dispute.create:5', event_type: 'charge.dispute.create', reference: 'late-ref', payload: create })

  it('ends IGNORED with the note, like a refund with no payment', async () => {
    const w = createWorld({ payments: [], webhook_events: [row()] })
    const { mod } = load(w)
    const r = await mod.replayWebhookEvent(replayCtx('e1'))
    expect(r.b.data).toMatchObject({ status: 'IGNORED', note: 'payment not found' })
    expect(w.t.webhook_events[0].status).toBe('IGNORED')
  })

  it('Replay works again once the payment row exists, and marks it DISPUTED', async () => {
    const w = createWorld({ payments: [], webhook_events: [row()] })
    const { mod } = load(w)
    await mod.replayWebhookEvent(replayCtx('e1'))
    w.t.payments.push({ id: 'p1', paystack_ref: 'late-ref', status: 'SUCCESS', amount_cents: 900, currency: 'USD', scan_id: 's1', user_id: 'u1' })
    const second = await mod.replayWebhookEvent(replayCtx('e1'))
    expect(second.s).toBeUndefined()   // not the 409 "already did its work"
    expect(second.b.data.status).toBe('PROCESSED')
    expect(w.t.payments[0].status).toBe('DISPUTED')
  })

  it('a dispute WITH a payment is still PROCESSED (nothing about the matched case changed)', async () => {
    const w = createWorld({ payments: [{ id: 'p1', paystack_ref: 'late-ref', status: 'SUCCESS', amount_cents: 900, currency: 'USD', scan_id: 's1', user_id: 'u1' }], webhook_events: [row()] })
    const { mod } = load(w)
    const r = await mod.replayWebhookEvent(replayCtx('e1'))
    expect(r.b.data.status).toBe('PROCESSED')
    expect(w.t.payments[0].status).toBe('DISPUTED')
  })

  it('a resolve for an unknown payment is IGNORED too', async () => {
    const resolve = { event: 'charge.dispute.resolve', data: { id: 6, status: 'resolved', resolution: 'merchant-accepted', transaction: { reference: 'late-ref' } } }
    const w = createWorld({ payments: [], webhook_events: [storedRow({ event_key: 'charge.dispute.resolve:6', event_type: 'charge.dispute.resolve', reference: 'late-ref', payload: resolve })] })
    const { mod } = load(w)
    expect((await mod.replayWebhookEvent(replayCtx('e1'))).b.data.status).toBe('IGNORED')
  })
})

// ── B2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B2: poison characters never reach the database, and a refusal never loops', () => {
  it('redactEvent strips NUL and lone surrogates from kept text, and still drops customer / authorization', () => {
    const { mod } = load(createWorld({}))
    // Round 25 (B1): refunds keep an allow-list, so the free-text notes are dropped outright; the kept scalars are still cleaned.
    const ev = { event: 'refund.processed', data: { id: 9, amount: '100', status: 'pro\u0000cessed', refund_reference: 'x\ud800y', transaction_reference: 'r1', merchant_note: 'ok\u0000bad', customer_note: 'x\ud800y', customer: { email: 'a@b.co' }, authorization: { last4: '4081' } } }
    const out = mod.redactEvent(ev)
    expect(out.data.status).toBe('processed')
    expect(out.data.refund_reference).toBe('xy')
    expect(out.data.merchant_note).toBeUndefined()
    expect(out.data.customer_note).toBeUndefined()
    expect(out.data.customer).toBeUndefined()
    expect(out.data.authorization).toBeUndefined()
    expect(JSON.stringify(out)).not.toMatch(/\\u0000|\\ud800/i)
    expect(out.data.amount).toBe('100')   // what the handlers read is untouched
  })
  it('a dispute payload (the allow-list copy) is cleaned too', () => {
    const { mod } = load(createWorld({}))
    const out = mod.redactEvent({ event: 'charge.dispute.create', data: { id: 5, category: 'fraud\u0000', transaction: { reference: 'r\u0000ef' } } })
    expect(JSON.stringify(out)).not.toMatch(/\\u0000/)
  })
  it('recordEvent cleans the key, type and reference it stores', async () => {
    const w = createWorld({ webhook_events: [] })
    const { mod } = load(w)
    await mod.recordEvent(w.db, { eventKey: 'charge.success:a\u0000b', eventType: 'charge.success', reference: 're\u0000f', payload: { event: 'charge.success' } })
    expect(w.t.webhook_events[0]).toMatchObject({ event_key: 'charge.success:ab', reference: 'ref' })
  })
  it('a payload the database still refuses is recorded without its body instead of failing the delivery', async () => {
    const w = createWorld({ webhook_events: [] })
    const { mod } = load(w)
    w.failNext('webhook_events', 'insert', { code: '22P05', message: 'unsupported Unicode escape sequence' })
    const r = await mod.recordEvent(w.db, { eventKey: 'charge.success:z', eventType: 'charge.success', reference: 'ref', payload: { event: 'charge.success', data: {} } })
    expect(r.mode).toBe('new')
    expect(w.t.webhook_events).toHaveLength(1)
    expect(w.t.webhook_events[0].payload).toBeNull()
  })
  it('an unrelated insert error is still thrown (nothing is swallowed)', async () => {
    const w = createWorld({ webhook_events: [] })
    const { mod } = load(w)
    w.failNext('webhook_events', 'insert', { code: '57014', message: 'canceling statement due to statement timeout' })
    await expect(mod.recordEvent(w.db, { eventKey: 'k', eventType: 'charge.success', reference: 'r', payload: {} })).rejects.toBeTruthy()
  })
  it('the Resend minimal copy is cleaned', () => {
    const resend = require_('../src/controllers/resend-webhook.controller.js')
    const out = resend.minimalResendEvent({ type: 'email.bounced', created_at: '2026-10-20T10:00:00Z', data: { to: ['a\u0000@b.co'], bounce: { type: 'Permanent', message: 'bad\ud800' } } })
    expect(JSON.stringify(out)).not.toMatch(/\\u0000|\\ud800/i)
  })
})

// ── B3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B3: the Resend stamp lag cannot raise a false "refused" notice', () => {
  const { rejectedSinceLastEvent, RESEND_STAMP_WINDOW_SECONDS } = require_('../src/lib/webhookRejections.js')
  const now = Date.now()
  const rej = (provider, minutesAgo) => ({ [provider]: { reason: 'signature', at: new Date(now - minutesAgo * 60000).toISOString() } })
  it('a Resend refusal newer than the stamp by less than the stamp window is not reported', () => {
    expect(rejectedSinceLastEvent(rej('resend', 2), { resend: new Date(now - 5 * 60000).toISOString() }, now)).toEqual([])
  })
  it('once the refusal is newer than the stamp by more than the window it is reported', () => {
    expect(rejectedSinceLastEvent(rej('resend', 1), { resend: new Date(now - 12 * 60000).toISOString() }, now)).toEqual(['resend'])
  })
  it('with no delivery on record it is reported at once', () => {
    expect(rejectedSinceLastEvent(rej('resend', 1), {}, now)).toEqual(['resend'])
  })
  it('Paystack (read from the inbox, exact) keeps the old strict comparison: no allowance', () => {
    const delivery = { paystack: new Date(now - 5 * 60000).toISOString() }
    expect(rejectedSinceLastEvent(rej('paystack', 6), delivery, now)).toEqual([])            // refusal BEFORE the delivery: cleared
    expect(rejectedSinceLastEvent(rej('paystack', 4), delivery, now)).toEqual(['paystack'])  // refusal 1 minute AFTER it: reported, no lag applied
  })
  it('the stamp throttle and the lag are one constant', () => {
    expect(RESEND_STAMP_WINDOW_SECONDS).toBe(600)
    const src = require_('node:fs').readFileSync(new URL('../src/controllers/resend-webhook.controller.js', import.meta.url), 'utf8')
    expect(src).toMatch(/hitQuota\(c\.env, 'resend-health-stamp', 1, rejections\.RESEND_STAMP_WINDOW_SECONDS\)/)
  })
})

// ── B4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B4: delivery health uses when the sale was paid', () => {
  const pay = (ref, over = {}) => ({ id: 'id-' + ref, paystack_ref: ref, amount_cents: 2900, status: 'SUCCESS', created_at: daysAgo(2), paid_at: daysAgo(2), ...over })
  const evt = (ref, at) => ({ id: 'e-' + ref, provider: 'paystack', event_type: 'charge.success', reference: ref, status: 'PROCESSED', received_at: at })
  const health = w => load(w).mod.computeWebhookHealth(w.db)

  it('a sale opened BEFORE another one\'s webhook but paid AFTER it, with no event of its own, is unrecovered', async () => {
    const w = createWorld({
      payments: [
        pay('opened-early', { created_at: hoursAgo(6), paid_at: hoursAgo(1) }),   // checkout 6h ago, paid 1h ago: no event
        pay('other', { created_at: hoursAgo(5), paid_at: hoursAgo(2) }),
      ],
      webhook_events: [evt('other', hoursAgo(1.5))],
    })
    const h = await health(w)
    expect(h.missingReferences).toEqual(['opened-early'])
    expect(h.unrecovered).toBe(1)
    expect(h.unrecoveredReferences).toEqual(['opened-early'])
  })
  it('a sale paid before the newest webhook that did arrive is still only "missing", not "unrecovered" (webhooks are flowing)', async () => {
    const w = createWorld({
      payments: [pay('lost', { created_at: hoursAgo(9), paid_at: hoursAgo(8) }), pay('other', { created_at: hoursAgo(5), paid_at: hoursAgo(4) })],
      webhook_events: [evt('other', hoursAgo(3.9))],
    })
    const h = await health(w)
    expect(h.paidWithoutEvent).toBe(1)
    expect(h.unrecovered).toBe(0)
  })
  it('the grace period runs from payment, not checkout: opened long ago but paid a minute ago is not counted yet', async () => {
    const w = createWorld({ payments: [pay('just-paid', { created_at: hoursAgo(3), paid_at: minsAgo(1) })], webhook_events: [] })
    const h = await health(w)
    expect(h.paidChecked).toBe(0)
    expect(h.paidWithoutEvent).toBe(0)
  })
  it('a payment with no paid_at (settled before 0064) falls back to created_at', async () => {
    const w = createWorld({ payments: [pay('legacy', { paid_at: null, created_at: hoursAgo(5) })], webhook_events: [] })
    const h = await health(w)
    expect(h).toMatchObject({ paidChecked: 1, paidWithoutEvent: 1, unrecovered: 1 })
  })
  it('a database without paid_at (0064 not applied) still answers', async () => {
    const w = createWorld({ payments: [pay('a', { created_at: hoursAgo(5) })], webhook_events: [] })
    w.failNext('payments', 'select', { code: '42703', message: 'column payments.paid_at does not exist' })
    const h = await health(w)
    expect(h.available).toBe(true)
    expect(h.paidChecked).toBe(1)
  })
})

// ── B5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B5: the old-disputes sweep has its own rotation marker', () => {
  const world = (over = {}) => createWorld({
    payments: [
      { id: 'old1', paystack_ref: 'ref-old1', status: 'DISPUTED', scan_id: 's1', user_id: 'u1', amount_cents: 2900, currency: 'USD', dispute_id: '555', disputed_at: daysAgo(60), created_at: daysAgo(61), last_reconciled_at: null, dispute_checked_at: null, ...over },
    ],
    scans: [{ id: 's1', user_id: 'u1' }], webhook_events: [], commission_ledger: [], users: [{ id: 'u1', email: 'b@x.co' }],
  })
  const run = async w => {
    const { mod } = load(w, { listDisputes: async () => ({ data: [] }), fetchDispute: async () => ({ data: { id: 555, status: 'awaiting-bank-feedback', resolution: null, transaction: { reference: 'ref-old1' } } }) })
    return mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk' }, null, w.db)
  }
  it('stamps dispute_checked_at and leaves last_reconciled_at (the reversal sweep\'s skip marker) alone', async () => {
    const w = world()
    await run(w)
    expect(w.t.payments[0].dispute_checked_at).toBeTruthy()
    expect(w.t.payments[0].last_reconciled_at).toBeNull()
  })
  it('rotates on it: asks for the payment checked longest ago (never-checked first) by dispute_checked_at', async () => {
    const w = world()
    const orders = []
    const realFrom = w.db.from.bind(w.db)
    w.db.from = t => {
      const q = realFrom(t)
      if (t === 'payments' && typeof q.order === 'function') { const o = q.order.bind(q); q.order = (c, opts) => { orders.push([c, opts]); return o(c, opts) } }
      return q
    }
    await run(w)
    expect(orders).toContainEqual(['dispute_checked_at', { ascending: true, nullsFirst: true }])
    expect(orders.some(([c]) => c === 'last_reconciled_at')).toBe(false)
  })
  it('a database without the column (0103 not applied) still runs the sweep', async () => {
    const w = world()
    w.failNext('payments', 'select', { code: '42703', message: 'column payments.dispute_checked_at does not exist' })
    const r = await run(w)
    expect(r.error ?? null).toBeNull()
  })
})

// ── G1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('G1: a failed refund is recorded on the payment', () => {
  const failed = { event: 'refund.failed', data: { id: 11, amount: '2900', currency: 'USD', transaction_reference: 'ref1' } }
  const processed = amount => ({ event: 'refund.processed', data: { id: 12, amount: String(amount), currency: 'USD', transaction_reference: 'ref1' } })
  const payment = (over = {}) => ({ id: 'p1', paystack_ref: 'ref1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', scan_id: 's1', user_id: 'u1', refund_failed_at: null, ...over })
  const deliver = async (w, mod, ev, key) => {
    w.t.webhook_events.push(storedRow({ id: key, event_key: `${ev.event}:${ev.data.id}`, event_type: ev.event, reference: 'ref1', payload: ev }))
    return mod.replayWebhookEvent(replayCtx(key))
  }
  const base = over => {
    const w = createWorld({ payments: [payment(over)], payment_refunds: [], webhook_events: [], scans: [{ id: 's1', user_id: 'u1' }], users: [{ id: 'u1', email: 'b@x.co' }], commission_ledger: [] })
    w.unique.webhook_events = [['provider', 'event_key']]
    // Stand-in for record_refund_and_total (migration 0053): records the event's amount once and returns the persisted total.
    w.rpcs.record_refund_and_total = ({ p_payment_id, p_event_id, p_count = true }) => {
      const row = w.t.webhook_events.find(r => r.id === p_event_id)
      const amt = Number(row?.payload?.data?.amount)
      if (p_count && row && Number.isFinite(amt) && !w.t.payment_refunds.some(r => r.payment_id === p_payment_id && r.event_key === row.event_key))
        w.t.payment_refunds.push({ payment_id: p_payment_id, event_key: row.event_key, amount_cents: amt })
      return { data: w.t.payment_refunds.filter(r => r.payment_id === p_payment_id).reduce((n, r) => n + r.amount_cents, 0), error: null }
    }
    return w
  }

  it('stamps refund_failed_at on a SUCCESS payment and still alerts', async () => {
    const w = base(); const { mod, alerts } = load(w)
    await deliver(w, mod, failed, 'f1')
    expect(w.t.payments[0].refund_failed_at).toBeTruthy()
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(alerts.some(a => /refund\.failed/.test(a.subject))).toBe(true)
  })
  it('stamps a DISPUTED payment too', async () => {
    const w = base({ status: 'DISPUTED' }); const { mod } = load(w)
    await deliver(w, mod, failed, 'f1')
    expect(w.t.payments[0].refund_failed_at).toBeTruthy()
  })
  it('does not stamp a REFUNDED payment (the money went back another way)', async () => {
    const w = base({ status: 'REFUNDED' }); const { mod } = load(w)
    await deliver(w, mod, failed, 'f1')
    expect(w.t.payments[0].refund_failed_at).toBeNull()
  })
  it('does not stamp an unsettled payment (no money is held)', async () => {
    const w = base({ status: 'PENDING' }); const { mod } = load(w)
    await deliver(w, mod, failed, 'f1')
    expect(w.t.payments[0].refund_failed_at).toBeNull()
  })
  it('a database without the column (0103 not applied) still handles the event', async () => {
    const w = base(); const { mod, alerts } = load(w)
    w.failNext('payments', 'update', { code: '42703', message: 'column "refund_failed_at" of relation "payments" does not exist' })
    const r = await deliver(w, mod, failed, 'f1')
    expect(r.b.success).toBe(true)
    expect(alerts.length).toBeGreaterThan(0)
  })
  it('the full refund that finally goes through clears the stamp and reverses the sale', async () => {
    const w = base({ refund_failed_at: hoursAgo(5) }); const { mod } = load(w)
    await deliver(w, mod, processed(2900), 'r1')
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(w.t.payments[0].refund_failed_at).toBeNull()
  })
  it('a PARTIAL refund leaves the stamp (money is still owed)', async () => {
    const w = base({ refund_failed_at: hoursAgo(5) }); const { mod } = load(w)
    await deliver(w, mod, processed(1000), 'r1')
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(w.t.payments[0].refund_failed_at).toBeTruthy()
  })
  it('the admin list returns refundFailedAt for SUCCESS / DISPUTED rows only', async () => {
    const at = hoursAgo(2)
    const rows = [payment({ refund_failed_at: at }), payment({ id: 'p2', paystack_ref: 'ref2', status: 'REFUNDED', refund_failed_at: at })]
    const w = createWorld({ payments: rows.map(r => ({ ...r, created_at: new Date().toISOString() })), payment_refunds: [], users: [] })
    const l = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => w.db } })
    restore = l.restore
    const out = {}
    await l.mod.adminListPayments({ env: {}, req: { query: () => undefined, param: () => undefined }, json: b => { out.body = b; return b } })
    const byId = Object.fromEntries(out.body.data.map(p => [p.id, p]))
    expect(byId.p1.refundFailedAt).toBe(at)
    expect(byId.p2.refundFailedAt).toBeNull()
  })
  it('the admin list survives a database without the column (falls back a tier)', async () => {
    const w = createWorld({ payments: [{ ...payment(), created_at: new Date().toISOString() }], payment_refunds: [], users: [] })
    const l = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => w.db } })
    restore = l.restore
    w.failNext('payments', 'select', { code: '42703', message: 'column payments.refund_failed_at does not exist' })
    const out = {}
    await l.mod.adminListPayments({ env: {}, req: { query: () => undefined, param: () => undefined }, json: b => { out.body = b; return b } })
    expect(out.body.success).toBe(true)
    expect(out.body.data).toHaveLength(1)
    expect(out.body.data[0].refundFailedAt).toBeNull()
  })
})

// ── migration + wiring ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('migration 0103 and the self-test', () => {
  const fs = require_('node:fs')
  const sql = fs.readFileSync(new URL('../supabase/migrations/0103_webhooks_round24.sql', import.meta.url), 'utf8')
  it('adds both columns nullable with no default, so it is safe before or after the Worker', () => {
    expect(sql).toMatch(/add column if not exists refund_failed_at\s+timestamptz;/)
    expect(sql).toMatch(/add column if not exists dispute_checked_at\s+timestamptz;/)
  })
  it('the self-test probes both columns', () => {
    const src = fs.readFileSync(new URL('../src/controllers/webhooks.controller.js', import.meta.url), 'utf8')
    expect(src).toMatch(/column: 'refund_failed_at', mig: '0103'/)
    expect(src).toMatch(/column: 'dispute_checked_at', mig: '0103'/)
  })
})
