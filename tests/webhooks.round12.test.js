import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Webhooks round 12 (Section 8, independent pass): W2 replay needs step-up (route wiring is asserted in
// crossCutting.round6.test.js), W4 dispute list camelCase fields, G2 dispute-sweep failures page the owner,
// G3 a fresh RECEIVED row cannot be dismissed. (W1 — transaction-scoped refund lookups — is in paystack.service.test.js.)

let realConsoleError
beforeEach(() => { realConsoleError = console.error; console.error = () => {} })
afterEach(() => { console.error = realConsoleError })

function setup(tables = {}, { disputes = [], processThrows = false } = {}) {
  const world = createWorld({ webhook_events: [], payments: [], scans: [], users: [], commission_ledger: [], ...tables })
  const alerts = []
  const { mod, restore } = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message, opts) => { alerts.push({ subject, message, opts }); return true }, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': { listRefunds: async () => ({ data: [] }), listDisputes: async () => ({ data: disputes }) },
  })
  const kv = new Map()
  const env = { PAYSTACK_SECRET_KEY: 'sk', RATE_LIMIT_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v) } } }
  const c = (over = {}) => ({
    env,
    req: { query: k => (over.query ?? {})[k], param: () => over.id, json: async () => over.body ?? {} },
    json: (body, status = 200) => ({ body, status }),
    get: () => ({ id: 'admin1' }),
    executionCtx: { waitUntil: () => {} },
  })
  return { world, mod, restore, alerts, c, env }
}
let t
afterEach(() => t?.restore())

const ev = (id, over = {}) => ({ id, provider: 'paystack', event_key: `k${id}`, event_type: 'charge.success', reference: 'r' + id,
  status: 'RECEIVED', attempts: 1, error: null, note: null, received_at: new Date().toISOString(), processed_at: null,
  payload: { event: 'charge.success', data: { id: 1, reference: 'r' + id } }, ...over })

describe('W4: dispute list camelCase fields', () => {
  it('keeps dueAt / resolvedAt / createdAt under the snake_case names the handlers read', () => {
    t = setup()
    const out = t.mod.redactEvent({ event: 'charge.dispute.create', data: { id: 5, status: 'awaiting-merchant-feedback', dueAt: '2026-10-13T00:00:00Z', resolvedAt: '2026-10-14T00:00:00Z', createdAt: '2026-10-12T00:00:00Z', messages: ['x'], transaction: { reference: 'r1' } } })
    expect(out.data).toMatchObject({ id: 5, due_at: '2026-10-13T00:00:00Z', resolved_at: '2026-10-14T00:00:00Z', created_at: '2026-10-12T00:00:00Z', transaction: { reference: 'r1' } })
    expect(out.data.messages).toBeUndefined()
    expect(out.data.dueAt).toBeUndefined()
  })
  it('prefers the snake_case value when both are present', () => {
    t = setup()
    const out = t.mod.redactEvent({ event: 'charge.dispute.create', data: { id: 5, due_at: 'A', dueAt: 'B' } })
    expect(out.data.due_at).toBe('A')
  })
  it('a swept dispute (camelCase list item) produces the "Respond ... by" line', async () => {
    const dueAt = new Date(Date.now() + 10 * 3600_000).toISOString()
    t = setup({ payments: [{ id: 'p1', paystack_ref: 'r1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', scan_id: null }] },
      { disputes: [{ id: 9, status: 'awaiting-merchant-feedback', resolution: null, dueAt, transaction: { reference: 'r1' } }] })
    t.world.unique.webhook_events = [['provider', 'event_key']]
    const r = await t.mod.sweepDisputes(t.env, { waitUntil: () => {} }, t.world.db)
    expect(r.actioned).toHaveLength(1)
    expect(t.alerts.some(a => /Respond in the Paystack dashboard by/.test(a.message))).toBe(true)
  })
})

describe('G2: dispute-sweep failures page the owner', () => {
  it('emails one summary when a dispute could not be processed, and throttles it', async () => {
    t = setup({ payments: [{ id: 'p1', paystack_ref: 'r1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', scan_id: null }] },
      { disputes: [{ id: 9, status: 'pending', resolution: null, transaction: { reference: 'r1' } }] })
    // make the DISPUTED flip throw: the payments update fails
    const realFrom = t.world.db.from.bind(t.world.db)
    t.world.db.from = table => {
      const q = realFrom(table)
      if (table === 'payments' && q.update) { const u = q.update.bind(q); q.update = (...a) => { const r = u(...a); r.eq = () => ({ eq: () => ({ select: async () => ({ data: null, error: { message: 'db down' } }) }) }); return r } }
      return q
    }
    const r1 = await t.mod.sweepDisputes(t.env, { waitUntil: () => {} }, t.world.db)
    expect(r1.failed).toHaveLength(1)
    expect(t.alerts.filter(a => /could not process 1 dispute/.test(a.subject))).toHaveLength(1)
    await t.mod.sweepDisputes(t.env, { waitUntil: () => {} }, t.world.db)
    expect(t.alerts.filter(a => /could not process/.test(a.subject))).toHaveLength(1)
  })
})

describe('G3: a fresh RECEIVED row is not dismissable', () => {
  it('409s for a RECEIVED row from moments ago and leaves it alone', async () => {
    t = setup({ webhook_events: [ev(1)] })
    const res = await t.mod.dismissWebhookEvent(t.c({ id: 1 }))
    expect(res.status).toBe(409)
    expect(t.world.t.webhook_events[0].status).toBe('RECEIVED')
  })
  it('accepts a RECEIVED row stuck for over 15 minutes', async () => {
    t = setup({ webhook_events: [ev(1, { received_at: new Date(Date.now() - 20 * 60_000).toISOString() })] })
    expect((await t.mod.dismissWebhookEvent(t.c({ id: 1 }))).status).toBe(200)
    expect(t.world.t.webhook_events[0].status).toBe('IGNORED')
  })
  it('FAILED is dismissable at any age', async () => {
    t = setup({ webhook_events: [ev(1, { status: 'FAILED', error: 'boom' })] })
    expect((await t.mod.dismissWebhookEvent(t.c({ id: 1 }))).status).toBe(200)
  })
  it('the list only flags a RECEIVED row dismissable once stuck', async () => {
    t = setup({ webhook_events: [ev(1), ev(2, { received_at: new Date(Date.now() - 30 * 60_000).toISOString() }), ev(3, { status: 'HELD' })] })
    const res = await t.mod.listWebhookEvents(t.c())
    const by = id => res.body.data.find(e => e.id === id)
    expect([1, 2, 3].map(i => by(i).dismissable)).toEqual([false, true, true])
  })
})
