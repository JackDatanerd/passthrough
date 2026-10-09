import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Round-2 audit, Section 8: the webhook inbox is visible and replayable from the admin panel.

function setup(events = []) {
  const world = createWorld({
    webhook_events: events, payments: [], scans: [], users: [],
  })
  const alerts = []
  const { mod, restore } = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message, opts) => { alerts.push({ subject, message, opts }); return true }, sendPaymentReceipt: async () => {} },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }) },
  })
  const c = (over = {}) => ({
    env: { RATE_LIMIT_KV: { get: async () => null, put: async () => {} } },
    req: { query: k => (over.query ?? {})[k], param: () => over.id },
    json: (body, status = 200) => ({ body, status }),
    executionCtx: { waitUntil: () => {} },
  })
  return { world, mod, restore, alerts, c }
}
const ev = (id, over = {}) => ({ id, provider: 'paystack', event_key: `k${id}`, event_type: 'charge.success', reference: 'r' + id,
  status: 'PROCESSED', attempts: 1, error: null, received_at: `2026-09-2${id}T00:00:00Z`, processed_at: null,
  payload: { event: 'charge.success', data: { id: 1, reference: 'r' + id, amount: 3900, currency: 'USD' } }, ...over })

let t
afterEach(() => t?.restore())

describe('listWebhookEvents', () => {
  it('lists events with a replayable flag, paged, without ever returning the payload', async () => {
    t = setup([ev(1), ev(2, { status: 'HELD' }), ev(3, { status: 'FAILED', error: 'boom' })])
    const res = await t.mod.listWebhookEvents(t.c())
    expect(res.status).toBe(200)
    const by = id => res.body.data.find(e => e.id === id)      // (memoryDb does not implement order())
    expect(res.body.data).toHaveLength(3)
    expect([by(1).replayable, by(2).replayable, by(3).replayable]).toEqual([false, true, true])
    expect(by(3)).toMatchObject({ eventType: 'charge.success', status: 'FAILED', error: 'boom' })
    expect(by(3).payload).toBeUndefined()
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 25 })   // (memoryDb has no count support)
  })
  it('filters by an allowlisted status and ignores an unknown one', async () => {
    t = setup([ev(1), ev(2, { status: 'HELD' })])
    expect((await t.mod.listWebhookEvents(t.c({ query: { status: 'HELD' } }))).body.data).toHaveLength(1)
    expect((await t.mod.listWebhookEvents(t.c({ query: { status: 'NOPE' } }))).body.data).toHaveLength(2)
  })
})

describe('replayWebhookEvent', () => {
  it('ROUND 5 (B2): an IGNORED "payment not found" refund replays once the payment row exists', async () => {
    t = setup([{ ...ev(1, { status: 'IGNORED', note: 'payment not found' }), event_type: 'refund.processed',
      payload: { event: 'refund.processed', data: { id: 5, transaction_reference: 'r1', refund_reference: 'rf-5', amount: 3900, currency: 'USD' } } }])
    Object.assign(t.world.t, {
      payments: [{ id: 'p1', paystack_ref: 'r1', scan_id: null, user_id: 'u1', status: 'SUCCESS', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX', created_at: new Date().toISOString() }],
      payment_refunds: [],
    })
    t.world.rpcs.record_refund_and_total = () => ({ data: 3900, error: null })
    const res = await t.mod.replayWebhookEvent(t.c({ id: 1 }))
    expect(res.status).toBe(200)
    expect(t.world.t.payments[0].status).toBe('REFUNDED')
  })
  it('404s an unknown event and 409s one that already did its work', async () => {
    t = setup([ev(1)])
    expect((await t.mod.replayWebhookEvent(t.c({ id: 99 }))).status).toBe(404)
    const done = await t.mod.replayWebhookEvent(t.c({ id: 1 }))
    expect(done.status).toBe(409)
    expect(t.world.t.webhook_events[0].status).toBe('PROCESSED')
  })
  it('422s an event with no stored payload', async () => {
    t = setup([ev(1, { status: 'FAILED', payload: null })])
    expect((await t.mod.replayWebhookEvent(t.c({ id: 1 }))).status).toBe(422)
  })
  it('re-runs an IGNORED unknown-reference event once the payment row exists, and marks it PROCESSED', async () => {
    t = setup([ev(1, { status: 'IGNORED', error: 'unknown reference' })])
    // the operator has since created the missing payment row and its scan
    Object.assign(t.world.t, {
      payments: [{ id: 'p1', paystack_ref: 'r1', scan_id: 's1', user_id: 'u1', status: 'PENDING', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX', created_at: new Date().toISOString() }],
      scans: [{ id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false, fix_payment_id: null, updated_at: new Date().toISOString() }],
      users: [{ id: 'u1', email: 'a@b.c', name: 'A', deleted_at: null }],
    })
    t.world.t.payments[0].receipt_sent_at = null
    const res = await t.mod.replayWebhookEvent(Object.assign(t.c({ id: 1 }), { env: { FIX_QUEUE: { send: async () => {} }, RATE_LIMIT_KV: { get: async () => null, put: async () => {} } } }))
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('PROCESSED')
    expect(t.world.t.payments[0].status).toBe('SUCCESS')
    expect(t.world.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED', attempts: 2 })
  })
  it('a replay that throws marks the row FAILED and answers 500 with the reason', async () => {
    t = setup([ev(1, { status: 'FAILED' })])
    t.world.failNext('payments', 'select', { message: 'db down' })
    const res = await t.mod.replayWebhookEvent(t.c({ id: 1 }))
    expect(res.status).toBe(500)
    expect(res.body.message).toMatch(/Replay failed/)
    expect(t.world.t.webhook_events[0].status).toBe('FAILED')
  })
})

// ── Round 3 ────────────────────────────────────────────────────────────────
const kvMap = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, m } }
const ago = ms => new Date(Date.now() - ms).toISOString()
const attentionEvent = (id, over = {}) => ev(id, {
  event_type: 'refund.needs-attention', status: 'FAILED', error: 'db down', attempts: 1, redrives: 0, received_at: ago(2 * 3600_000),
  payload: { event: 'refund.needs-attention', data: { transaction_reference: 'r' + id, amount: '100' } }, ...over })

describe('round 3 — inbox visibility', () => {
  it('shows an outcome note as a note, never as an error (rows written before migration 0036 keep it in `error`)', async () => {
    t = setup([ev(1, { status: 'PROCESSED', error: null, note: 'FULFILLED' }), ev(2, { status: 'PROCESSED', error: 'reversed' })])
    const res = await t.mod.listWebhookEvents(t.c())
    const by = id => res.body.data.find(e => e.id === id)
    expect(by(1)).toMatchObject({ error: null, note: 'FULFILLED' })
    expect(by(2)).toMatchObject({ error: null, note: 'reversed' })
  })
  it('a FAILED row still surfaces its error', async () => {
    t = setup([ev(1, { status: 'FAILED', error: 'boom', note: null })])
    expect((await t.mod.listWebhookEvents(t.c())).body.data[0]).toMatchObject({ error: 'boom', note: null })
  })
  it('accepts reference / type / ATTENTION filters (values are sanitised, never trusted)', async () => {
    t = setup([ev(1)])
    const q = { status: 'ATTENTION', reference: 'ref,1);drop', type: 'refund.processed' }
    expect((await t.mod.listWebhookEvents(t.c({ query: q }))).status).toBe(200)
    const call = t.world.calls.find(x => x.table === 'webhook_events')
    expect(call.or[0]).toMatch(/status\.in\.\(FAILED,HELD\)/)
    expect(call.filters.find(f => f[0] === 'ilike')[2]).toBe('%ref1drop%')
    expect(call.filters.find(f => f[0] === 'eq' && f[1] === 'event_type')[2]).toBe('refund.processed')
  })
  it('getWebhookEvent returns the stored payload; 404 for an unknown id', async () => {
    t = setup([ev(1)])
    const ok = await t.mod.getWebhookEvent(t.c({ id: 1 }))
    expect(ok.body.data.payload).toMatchObject({ event: 'charge.success' })
    expect((await t.mod.getWebhookEvent(t.c({ id: 99 }))).status).toBe(404)
  })
  it('a replay records which admin ran it', async () => {
    t = setup([attentionEvent(1)])
    const c = { ...t.c({ id: 1 }), get: () => ({ id: 'admin-9' }) }
    expect((await t.mod.replayWebhookEvent(c)).status).toBe(200)
    expect(t.world.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED', replayed_by: 'admin-9' })
  })
})

describe('round 3 — redriveStaleEvents (dead-letter handling)', () => {
  const envWith = kv => ({ RATE_LIMIT_KV: kv })
  const ctx = { waitUntil: () => {} }

  it('re-runs a FAILED event that Paystack stopped retrying, and reports the recovery', async () => {
    t = setup([attentionEvent(1)])
    const r = await t.mod.redriveStaleEvents(envWith(kvMap()), ctx)
    expect(r.recovered).toHaveLength(1)
    expect(t.world.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED', attempts: 2, redrives: 1 })
    expect(t.alerts.some(a => /re-drive recovered 1/.test(a.subject))).toBe(true)
  })
  it('leaves a fresh FAILED event alone — Paystack is still retrying it', async () => {
    t = setup([attentionEvent(1, { received_at: ago(2 * 60_000) })])
    expect((await t.mod.redriveStaleEvents(envWith(kvMap()), ctx)).redriven).toHaveLength(0)
  })
  it('stops after the attempt cap and says so exactly ONCE', async () => {
    t = setup([attentionEvent(1, { redrives: 8 })])
    const kv = kvMap()
    const a = await t.mod.redriveStaleEvents(envWith(kv), ctx)
    const b = await t.mod.redriveStaleEvents(envWith(kv), ctx)
    expect(a.redriven).toHaveLength(0)
    expect(a.exhausted).toHaveLength(1)
    expect(b.exhausted).toHaveLength(0)
    expect(t.alerts.filter(x => /stuck/i.test(x.subject))).toHaveLength(1)
    expect(t.world.t.webhook_events[0].status).toBe('FAILED')
  })
  it('escalates a HELD event that has waited over a day — once — but never re-runs it', async () => {
    t = setup([ev(1, { status: 'HELD', received_at: ago(30 * 3600_000), note: 'amount/currency mismatch' })])
    const kv = kvMap()
    const a = await t.mod.redriveStaleEvents(envWith(kv), ctx)
    await t.mod.redriveStaleEvents(envWith(kv), ctx)
    expect(a.heldEscalated).toHaveLength(1)
    expect(a.redriven).toHaveLength(0)
    expect(t.alerts.filter(x => /held payment event/i.test(x.subject))).toHaveLength(1)
  })
})


describe('round 4 — B2: exhausted rows cannot starve the re-drive window', () => {
  const envWith = kv => ({ RATE_LIMIT_KV: kv })
  const ctx = { waitUntil: () => {} }
  it('the re-drive query only selects rows that can actually run (re-drives under the cap, payload present)', async () => {
    t = setup([attentionEvent(1)])
    await t.mod.redriveStaleEvents(envWith(kvMap()), ctx)
    const main = t.world.calls.find(q => q.table === 'webhook_events' && q.op === 'select' && q.limit === 30)
    expect(main.filters).toContainEqual(['lt', 'redrives', 8])
    expect(main.filters).toContainEqual(['not', 'payload', 'is', null])
  })
  it('a fresh failure is recovered even with exhausted rows sitting in the table, and each exhausted row is reported once', async () => {
    const stuck = n => attentionEvent(n, { redrives: 8, attempts: 8, received_at: ago(5 * 24 * 3600_000) })
    t = setup([stuck(1), stuck(2), stuck(3), attentionEvent(4, { redrives: 2, attempts: 2 })])
    const kv = kvMap()
    const a = await t.mod.redriveStaleEvents(envWith(kv), ctx)
    const b = await t.mod.redriveStaleEvents(envWith(kv), ctx)
    expect(a.redriven).toEqual([4])
    expect(a.exhausted).toHaveLength(3)
    expect(b.exhausted).toHaveLength(0)
    expect(t.world.t.webhook_events.find(e => e.id === 4).status).toBe('PROCESSED')
  })
})

describe('round 4 — G1: a HELD event is closed out once its payment is settled', () => {
  const envWith = kv => ({ RATE_LIMIT_KV: kv })
  const ctx = { waitUntil: () => {} }
  const held = (id, ref, over = {}) => ev(id, { status: 'HELD', reference: ref, received_at: ago(30 * 3600_000), note: 'amount/currency mismatch', ...over })

  it('closes HELD rows whose payment is SUCCESS / DISPUTED / REFUNDED, leaves the ones still waiting', async () => {
    t = setup([held(1, 'r1'), held(2, 'r2'), held(3, 'r3'), held(4, 'r4')])
    t.world.t.payments.push(
      { id: 'p1', paystack_ref: 'r1', status: 'SUCCESS' }, { id: 'p2', paystack_ref: 'r2', status: 'PENDING' },
      { id: 'p3', paystack_ref: 'r3', status: 'REFUNDED' }, { id: 'p4', paystack_ref: 'r4', status: 'DISPUTED' })
    const closed = await t.mod.closeResolvedHeldEvents(t.world.db)
    expect(closed.sort()).toEqual([1, 3, 4])
    const row = id => t.world.t.webhook_events.find(e => e.id === id)
    expect(row(1)).toMatchObject({ status: 'PROCESSED', error: null, note: 'resolved — payment is SUCCESS' })
    expect(row(2).status).toBe('HELD')
  })
  it('scoped to one reference when given (what the admin Recheck does)', async () => {
    t = setup([held(1, 'r1'), held(2, 'r2')])
    t.world.t.payments.push({ id: 'p1', paystack_ref: 'r1', status: 'SUCCESS' }, { id: 'p2', paystack_ref: 'r2', status: 'SUCCESS' })
    expect(await t.mod.closeResolvedHeldEvents(t.world.db, { reference: 'r1' })).toEqual([1])
    expect(t.world.t.webhook_events.find(e => e.id === 2).status).toBe('HELD')
  })
  it('the hourly job closes a resolved HELD row and does NOT escalate it as "a customer may have paid and received nothing"', async () => {
    t = setup([held(1, 'r1'), held(2, 'r2')])
    t.world.t.payments.push({ id: 'p1', paystack_ref: 'r1', status: 'SUCCESS' }, { id: 'p2', paystack_ref: 'r2', status: 'PENDING' })
    const r = await t.mod.redriveStaleEvents(envWith(kvMap()), ctx)
    expect(r.heldClosed).toEqual([1])
    expect(r.heldEscalated).toEqual([2])
    expect(t.alerts.filter(x => /held payment event/i.test(x.subject))).toHaveLength(1)
    expect(t.alerts.find(x => /held payment event/i.test(x.subject)).message).toMatch(/r2/)
  })
  it('escalation is capped per run and walks past rows already inside their cooldown', async () => {
    const rows = Array.from({ length: 14 }, (_, i) => held(i + 1, `r${i + 1}`))
    t = setup(rows)
    t.world.t.payments.push(...rows.map(r => ({ id: 'p' + r.id, paystack_ref: r.reference, status: 'PENDING' })))
    const kv = kvMap()
    for (let i = 1; i <= 10; i++) await kv.put(`webhook-alert-cooldown:held-escalate:${i}`, '1')   // the first ten were alerted recently
    const r = await t.mod.redriveStaleEvents(envWith(kv), ctx)
    expect(r.heldEscalated.sort((a, b) => a - b)).toEqual([11, 12, 13, 14])
  })
  it('never throws when the payments lookup fails', async () => {
    t = setup([held(1, 'r1')])
    t.world.failNext('payments', 'select', { message: 'boom' })
    expect(await t.mod.closeResolvedHeldEvents(t.world.db)).toEqual([])
  })
})

describe('round 6 — G1: replay is written to the admin audit log', () => {
  it('records who replayed what and the result; a failed replay is recorded too', async () => {
    t = setup([ev(1, { status: 'IGNORED', event_type: 'refund.pending', payload: { event: 'refund.pending', data: { transaction_reference: 'r1' } } })])
    t.world.t.admin_audit_log = []
    const c = Object.assign(t.c({ id: 1 }), { get: k => (k === 'user' ? { id: 'admin-1' } : undefined) })
    const res = await t.mod.replayWebhookEvent(c)
    expect(res.status).toBe(200)
    expect(t.world.t.admin_audit_log).toHaveLength(1)
    expect(t.world.t.admin_audit_log[0]).toMatchObject({ actor_id: 'admin-1', action: 'webhook.replay', target_type: 'webhook_event', target_id: '1' })
    expect(t.world.t.admin_audit_log[0].detail).toMatchObject({ eventType: 'refund.pending', from: 'IGNORED', result: 'IGNORED' })
  })
  it('a replay that is refused (already PROCESSED) is not audited — nothing ran', async () => {
    t = setup([ev(1)]); t.world.t.admin_audit_log = []
    expect((await t.mod.replayWebhookEvent(t.c({ id: 1 }))).status).toBe(409)
    expect(t.world.t.admin_audit_log).toHaveLength(0)
  })
})

// ── Round 7 (section 8, independent pass) ─────────────────────────────────────
describe('round 7 — B3: re-drives are counted apart from Paystack redeliveries', () => {
  const envWith = kv => ({ RATE_LIMIT_KV: kv })
  const ctx = { waitUntil: () => {} }
  it('an event Paystack redelivered many times is still re-driven (its own budget is untouched)', async () => {
    t = setup([attentionEvent(1, { attempts: 14, redrives: 0 })])
    const r = await t.mod.redriveStaleEvents(envWith(kvMap()), ctx)
    expect(r.redriven).toEqual([1])
    expect(t.world.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED', attempts: 15, redrives: 1 })
    expect(t.alerts.filter(x => /stuck/i.test(x.subject))).toHaveLength(0)
  })
  it('the "stuck" alert says the RE-DRIVE gave up, and does not claim Paystack stopped', async () => {
    t = setup([attentionEvent(1, { redrives: 8, attempts: 20 })])
    await t.mod.redriveStaleEvents(envWith(kvMap()), ctx)
    const a = t.alerts.find(x => /stuck/i.test(x.subject))
    expect(a.message).toMatch(/re-drive has run this event 8 times/)
    expect(a.message).not.toMatch(/Paystack has stopped retrying/)
  })
  it('before migration 0064 (no redrives column) it falls back to the attempts budget instead of dying', async () => {
    t = setup([attentionEvent(1, { attempts: 2 })])
    t.world.failNext('webhook_events', 'select', { code: '42703', message: 'column webhook_events.redrives does not exist' })
    const r = await t.mod.redriveStaleEvents(envWith(kvMap()), ctx)
    expect(r.error).toBeNull()
    expect(r.redriven).toEqual([1])
  })
})

describe('round 7 — B2: Replay is only offered where there is something to replay', () => {
  const envWith = kv => ({ RATE_LIMIT_KV: kv })
  it('a payload-less IGNORED row (a non-actionable type) is not replayable; one with a payload is', async () => {
    t = setup([ev(1, { status: 'IGNORED', event_type: 'transfer.success', payload: null }), ev(2, { status: 'IGNORED' })])
    const res = await t.mod.listWebhookEvents(t.c())
    const by = id => res.body.data.find(e => e.id === id)
    expect([by(1).replayable, by(2).replayable]).toEqual([false, true])
  })
  it('a Resend row is replayable through its own top-level key (type), and the list names the provider', async () => {
    t = setup([ev(1, { provider: 'resend', status: 'FAILED', event_type: 'email.bounced', reference: null, payload: { type: 'email.bounced', data: { to: ['a@b.co'], bounce: { type: 'Transient' } } } })])
    const row = (await t.mod.listWebhookEvents(t.c())).body.data[0]
    expect(row).toMatchObject({ provider: 'resend', replayable: true })
  })
  it('the list asks the database for the payload keys, never the payload itself, and can filter by provider', async () => {
    t = setup([ev(1)])
    await t.mod.listWebhookEvents(t.c({ query: { provider: 'resend' } }))
    const q = t.world.calls.find(x => x.table === 'webhook_events' && x.op === 'select')
    expect(q.cols).toMatch(/has_event:payload->>event/)
    expect(q.cols).not.toMatch(/(^|, )payload(,|$)/)
    expect(q.filters).toContainEqual(['eq', 'provider', 'resend'])
  })
  it('the hourly re-drive closes a stuck payload-less RECEIVED row of a non-actionable type — and leaves an actionable one', async () => {
    t = setup([
      ev(1, { status: 'RECEIVED', event_type: 'transfer.success', payload: null, received_at: ago(3600_000) }),
      ev(2, { status: 'RECEIVED', event_type: 'charge.success', payload: null, received_at: ago(3600_000) }),
      ev(3, { status: 'RECEIVED', event_type: 'transfer.success', payload: null, received_at: ago(60_000) }),
    ])
    const r = await t.mod.redriveStaleEvents(envWith(kvMap()), { waitUntil: () => {} })
    expect(r.unrunnableClosed).toEqual([1])
    const st = id => t.world.t.webhook_events.find(e => e.id === id).status
    expect([st(1), st(2), st(3)]).toEqual(['IGNORED', 'RECEIVED', 'RECEIVED'])
  })
})

describe('round 7 — G1: a stored Resend event is re-run by the same Replay / re-drive', () => {
  it('replays a FAILED Resend event through the Resend handler (not the Paystack one)', async () => {
    t = setup([ev(1, { provider: 'resend', status: 'FAILED', event_type: 'email.bounced', reference: null, event_key: 'msg_1',
      payload: { type: 'email.bounced', data: { to: ['dana@acme.com'], bounce: { type: 'Transient' } } } })])
    const res = await t.mod.replayWebhookEvent(t.c({ id: 1 }))
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'IGNORED', note: 'transient bounce' })
    expect(t.world.t.webhook_events[0]).toMatchObject({ status: 'IGNORED', attempts: 2, payload: null })   // addresses cleared once finished
  })
  it('422s a Resend row whose payload has no `type`', async () => {
    t = setup([ev(1, { provider: 'resend', status: 'FAILED', payload: { event: 'charge.success' } })])
    expect((await t.mod.replayWebhookEvent(t.c({ id: 1 }))).status).toBe(422)
  })
})

describe('round 7 — G4: a dispute event keeps only what the handler uses', () => {
  it('drops the conversation, history, attachments and customer; keeps id, status, resolution, amount and the transaction reference', () => {
    t = setup([])
    const out = t.mod.redactEvent({ event: 'charge.dispute.create', data: {
      id: 77, status: 'awaiting-merchant-feedback', resolution: null, refund_amount: 2900, currency: 'USD', category: 'chargeback',
      messages: [{ body: 'I never got it, my card is ****1234' }], history: [{ by: 'x' }], attachments: [{ url: 'u' }],
      customer: { email: 'a@b.c' }, transaction: { id: 5, reference: 'ref-1', amount: 2900, currency: 'USD', authorization: { authorization_code: 'AUTH' }, customer: { email: 'a@b.c' } } } })
    expect(out).toEqual({ event: 'charge.dispute.create', data: { id: 77, status: 'awaiting-merchant-feedback', refund_amount: 2900, currency: 'USD', category: 'chargeback',
      transaction: { id: 5, reference: 'ref-1', amount: 2900, currency: 'USD' } } })
  })
  it('a redacted dispute still resolves its payment for a replay (reference under transaction)', () => {
    t = setup([])
    const out = t.mod.redactEvent({ event: 'charge.dispute.resolve', data: { id: 1, resolution: 'declined', transaction: { reference: 'ref-9' }, messages: ['x'] } })
    expect(out.data.transaction.reference).toBe('ref-9')
    expect(out.data.messages).toBeUndefined()
  })
})
