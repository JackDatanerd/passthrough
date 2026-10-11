import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Webhooks round 11 (Section 8, independent pass): dismiss a stuck inbox event (G2), date-range filter (G4/G5),
// auto-refund retry sweep (G1), delivery-health recovery (G3), dispute-sweep fixes (B1), HELD-close paging (B4),
// recovered count (B3).

let realConsoleError
beforeEach(() => { realConsoleError = console.error; console.error = () => {} })
afterEach(() => { console.error = realConsoleError })

function setup(tables = {}, { disputes = [] } = {}) {
  const world = createWorld({ webhook_events: [], payments: [], scans: [], users: [], commission_ledger: [], ...tables })
  const alerts = []
  const { mod, restore } = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message, opts) => { alerts.push({ subject, message, opts }); return true }, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': { listRefunds: async () => ({ data: [] }), listDisputes: async () => ({ data: disputes }) },
  })
  const c = (over = {}) => ({
    env: { RATE_LIMIT_KV: { get: async () => null, put: async () => {} } },
    req: { query: k => (over.query ?? {})[k], param: () => over.id, json: async () => over.body ?? {} },
    json: (body, status = 200) => ({ body, status }),
    get: () => ({ id: 'admin1' }),
    executionCtx: { waitUntil: () => {} },
  })
  return { world, mod, restore, alerts, c }
}
const ev = (id, over = {}) => ({ id, provider: 'paystack', event_key: `k${id}`, event_type: 'charge.success', reference: 'r' + id,
  status: 'FAILED', attempts: 1, error: 'boom', note: null, received_at: `2026-09-2${id}T10:00:00Z`, processed_at: null,
  payload: { event: 'charge.success', data: { id: 1, reference: 'r' + id } }, ...over })

let t
afterEach(() => t?.restore())

describe('dismissWebhookEvent (G2)', () => {
  it('closes a FAILED event as IGNORED with the admin note and clears the error', async () => {
    t = setup({ webhook_events: [ev(1)] })
    const res = await t.mod.dismissWebhookEvent(t.c({ id: 1, body: { note: '  paid\nby hand  ' } }))
    expect(res.status).toBe(200)
    const row = t.world.t.webhook_events[0]
    expect(row.status).toBe('IGNORED')
    expect(row.error).toBeNull()
    expect(row.note).toBe('dismissed by admin: paid by hand')
    expect(row.processed_at).toBeTruthy()
  })
  it.each(['HELD', 'RECEIVED'])('accepts %s', async status => {
    t = setup({ webhook_events: [ev(1, { status })] })
    expect((await t.mod.dismissWebhookEvent(t.c({ id: 1 }))).status).toBe(200)
    expect(t.world.t.webhook_events[0].note).toBe('dismissed by admin')
  })
  it.each(['PROCESSED', 'IGNORED'])('refuses %s with 409 and leaves it alone', async status => {
    t = setup({ webhook_events: [ev(1, { status, error: null })] })
    const res = await t.mod.dismissWebhookEvent(t.c({ id: 1 }))
    expect(res.status).toBe(409)
    expect(t.world.t.webhook_events[0].status).toBe(status)
  })
  it('404s for an unknown id', async () => {
    t = setup({ webhook_events: [] })
    expect((await t.mod.dismissWebhookEvent(t.c({ id: 99 }))).status).toBe(404)
  })
  it('caps the note at 200 characters', async () => {
    t = setup({ webhook_events: [ev(1)] })
    await t.mod.dismissWebhookEvent(t.c({ id: 1, body: { note: 'x'.repeat(500) } }))
    expect(t.world.t.webhook_events[0].note.length).toBe('dismissed by admin: '.length + 200)
  })
})

describe('listWebhookEvents (G2 / G4)', () => {
  it('flags FAILED / HELD / RECEIVED rows as dismissable, nothing else', async () => {
    t = setup({ webhook_events: [ev(1), ev(2, { status: 'HELD' }), ev(3, { status: 'PROCESSED', error: null }), ev(4, { status: 'RECEIVED' })] })
    const res = await t.mod.listWebhookEvents(t.c())
    const by = id => res.body.data.find(e => e.id === id)
    expect([1, 2, 3, 4].map(i => by(i).dismissable)).toEqual([true, true, false, true])
  })
  it('filters by from / to day (inclusive) and ignores a malformed date', async () => {
    t = setup({ webhook_events: [ev(1), ev(2), ev(3)] })   // 2026-09-21, -22, -23
    const ids = async q => (await t.mod.listWebhookEvents(t.c({ query: q }))).body.data.map(e => e.id).sort()
    expect(await ids({ from: '2026-09-22', to: '2026-09-22' })).toEqual([2])
    expect(await ids({ from: '2026-09-22' })).toEqual([2, 3])
    expect(await ids({ to: '2026-09-21' })).toEqual([1])
    expect(await ids({ from: 'garbage', to: '2026-13-45' })).toEqual([1, 2, 3])
  })
})

describe('computeWebhookHealth (G3)', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const pay = (ref, daysAgo) => ({ id: 'p' + ref, paystack_ref: ref, amount_cents: 2900, status: 'SUCCESS', created_at: new Date(now - daysAgo * 86400_000).toISOString() })
  it('an old unreceived sale no longer counts once a newer charge.success arrived for our payments', async () => {
    t = setup({ payments: [pay('old', 5), pay('new', 3)], webhook_events: [ev(1, { status: 'PROCESSED', reference: 'new', received_at: new Date(now - 3 * 86400_000 + 60000).toISOString() })] })
    const h = await t.mod.computeWebhookHealth(t.world.db, { now })
    expect(h.paidWithoutEvent).toBe(1)
    expect(h.unrecovered).toBe(0)
    expect(t.mod.deliveryProblem(h)).toBeNull()
  })
  it('a sale newer than every received charge.success is still a delivery problem', async () => {
    t = setup({ payments: [pay('old', 5), pay('late', 2)], webhook_events: [ev(1, { status: 'PROCESSED', reference: 'old', received_at: new Date(now - 5 * 86400_000 + 60000).toISOString() })] })
    const h = await t.mod.computeWebhookHealth(t.world.db, { now })
    expect(h.unrecovered).toBe(1)
    expect(h.unrecoveredReferences).toEqual(['late'])
    expect(t.mod.deliveryProblem(h)).toMatch(/late/)
  })
  it('with no charge.success at all every missing sale is unrecovered', async () => {
    t = setup({ payments: [pay('a', 4)], webhook_events: [] })
    expect((await t.mod.computeWebhookHealth(t.world.db, { now })).unrecovered).toBe(1)
  })
})

describe('closeResolvedHeldEvents paging (B4)', () => {
  it('closes resolved HELD rows even when 100+ older HELD rows still wait on a human', async () => {
    const pays = [{ id: 'pz', paystack_ref: 'rz', status: 'SUCCESS', amount_cents: 2900 }]
    const waiting = Array.from({ length: 120 }, (_, i) => ev(1000 + i, { status: 'HELD', reference: 'w' + i, event_key: 'w' + i, received_at: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z` }))
    t = setup({ payments: pays, webhook_events: [...waiting, ev(1, { status: 'HELD', reference: 'rz', received_at: '2026-09-01T00:00:00Z' })] })
    const closed = await t.mod.closeResolvedHeldEvents(t.world.db)
    expect(closed.length).toBe(1)
    expect(t.world.t.webhook_events.find(e => e.id === 1).status).toBe('PROCESSED')
  })
})

describe('sweepDisputes (B1 / partial accept)', () => {
  const base = over => ({ id: 900, status: 'resolved', resolution: 'merchant-accepted', refund_amount: 1000, transaction: { reference: 'ref-1', amount: 2900, currency: 'USD' }, ...over })
  const world = () => ({
    payments: [{ id: 'pay1', paystack_ref: 'ref-1', status: 'DISPUTED', amount_cents: 2900, currency: 'USD', scan_id: 'scan1', user_id: 'u1' }],
    scans: [{ id: 'scan1', user_id: 'u1', fix_payment_id: 'pay1', verification_status: 'ACTIVE' }],
  })
  it('a partially accepted dispute is left for a human and the owner is paged once a week', async () => {
    t = setup(world(), { disputes: [base()] })
    const kv = new Map()
    const env = { PAYSTACK_SECRET_KEY: 'sk_test', RATE_LIMIT_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v) } } }
    const r1 = await t.mod.sweepDisputes(env, null, t.world.db)
    expect(r1.needsHuman).toHaveLength(1)
    expect(t.world.t.payments[0].status).toBe('DISPUTED')
    const n = t.alerts.filter(a => /Partially accepted/.test(a.subject)).length
    expect(n).toBe(1)
    await t.mod.sweepDisputes(env, null, t.world.db)
    expect(t.alerts.filter(a => /Partially accepted/.test(a.subject)).length).toBe(1)
  })
})
