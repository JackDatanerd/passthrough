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
  event_type: 'refund.needs-attention', status: 'FAILED', error: 'db down', attempts: 1, received_at: ago(2 * 3600_000),
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
    expect(t.world.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED', attempts: 2 })
    expect(t.alerts.some(a => /re-drive recovered 1/.test(a.subject))).toBe(true)
  })
  it('leaves a fresh FAILED event alone — Paystack is still retrying it', async () => {
    t = setup([attentionEvent(1, { received_at: ago(2 * 60_000) })])
    expect((await t.mod.redriveStaleEvents(envWith(kvMap()), ctx)).redriven).toHaveLength(0)
  })
  it('stops after the attempt cap and says so exactly ONCE', async () => {
    t = setup([attentionEvent(1, { attempts: 8 })])
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
