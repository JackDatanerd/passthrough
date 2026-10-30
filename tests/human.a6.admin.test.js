import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { Hono } = require_('hono')

// Experts audit A6: the money routes of the operator and the expert's own earnings view.
const SETTINGS = { prices: { polish: 1, seven_day: 8900, forty_eight_hour: 11900, twenty_four_hour: 14900, cover_letter: 2900 }, pay: { polish: 1, seven_day: 5000, forty_eight_hour: 7000, twenty_four_hour: 9000, cover_letter: 1800 },
  tiers_enabled: { polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true }, turnaround_hours: { forty_eight_hour: 48 }, pilot_cap_orders: 15, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3, payout_min_cents: 2500 }
const J = '55555555-5555-4555-8555-555555555555', X = '77777777-7777-4777-8777-777777777777', OP = '88888888-8888-4888-8888-888888888888', PO = '99999999-9999-4999-8999-999999999999'
let t
afterEach(() => { t?.restore(); t = null })

function world(over = {}) {
  return createWorld({
    human_jobs: [{ id: J, job_number: 'HJ-AAAAAA', state: 'delivered', tier: 'forty_eight_hour', customer_user_id: 'u1', expert_id: X, payment_id: 'p1', price_cents: 11900, expert_pay_cents: 7000, late_credit_cents: 0, paid_at: '2026-10-01T00:00:00Z', ...over.job }],
    payments: [{ id: 'p1', status: 'SUCCESS', paystack_ref: 'r1', amount_cents: 11900, currency: 'USD', ...over.pay }],
    expert_accounts: [{ id: X, email: 'e@x.y', display_first_name: 'Ann', display_initial: 'K', status: 'active', enabled: true, totp_enabled_at: 'x', agreement_signed_at: 'x' }],
    expert_earnings: [], expert_payouts: [], system_state: [{ key: 'human_pilot', value: SETTINGS }] })
}
function build(w, { refund } = {}) {
  for (const k of Object.keys(require_.cache)) if (/[\\/]src[\\/](controllers[\\/]admin-human|routes[\\/]admin-human)/.test(k)) delete require_.cache[k]
  const stepUp = vi.fn(async (c, next) => next()); const audit = []; const alerts = []
  const adminMw = Object.assign(async (c, next) => next(), { stepUp })
  t = loadWithStubs('routes/admin-human.routes.js', {
    'config/supabase.js': { getSupabase: () => w.db }, 'middleware/adminOnly.js': adminMw, 'lib/adminAudit.js': { logAdminAction: async (c, db, action, tt, id, d) => { audit.push([action, d]) } },
    'services/humanDelivery.service.js': { buildReview: async () => ({}), deliver: async () => ({ ok: true }), logView: async () => {} },
    'services/refund.service.js': { queueRefund: refund || (async () => ({ ok: true })) },
    'services/email.service.js': { sendOwnerAlert: async (e, s, m, o) => { alerts.push(o && o.dedupeKey) } },
  })
  const app = new Hono(); app.use('*', async (c, next) => { c.set('user', { id: OP, role: 'admin' }); return next() }); app.route('/api/admin/human', t.mod)
  app.onError((err, c) => c.json({ success: false, message: err.message }, 500))
  t.stepUp = stepUp; t.audit = audit; t.alerts = alerts; return app
}
const call = (a, m, p, body) => a.request(p, { method: m, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, { EXPERTS_ENABLED: 'true' })

describe('step-up and audit on every money route (B5)', () => {
  it('accept, record, late credit, adjustments and void all require step-up, as refund and payouts already did', async () => {
    const w = world(); w.rpcs.human_job_accept = () => ({ data: { ok: true }, error: null }); const a = build(w); t.stepUp.mockClear()
    for (const [m, p, b] of [['POST', `/orders/${J}/accept`, {}], ['POST', `/orders/${J}/record`, { otherCostCents: 1 }], ['POST', `/orders/${J}/late-credit`, { amountCents: 1 }],
      ['POST', `/experts/${X}/adjustments`, { kind: 'bonus', amountCents: 1, reason: 'abc', idempotencyKey: 'adj-12345' }], ['POST', `/payouts/${PO}/void`, { reason: 'abc' }]]) await call(a, m, `/api/admin/human${p}`, b)
    expect(t.stepUp).toHaveBeenCalledTimes(5)
  })
  it('record is audited, and can no longer set the late credit by hand', async () => {
    const w = world(); const a = build(w)
    expect((await call(a, 'POST', `/api/admin/human/orders/${J}/record`, { otherCostCents: 500, note: 'n' })).status).toBe(200)
    expect(t.audit).toEqual([['human.record', { fields: ['other_cost_cents', 'operator_note'] }]]); expect(w.t.human_jobs[0].other_cost_cents).toBe(500)
    expect((await call(a, 'POST', `/api/admin/human/orders/${J}/record`, { lateCreditCents: 99999 })).status).toBe(400); expect(w.t.human_jobs[0].late_credit_cents).toBe(0)
  })
  it('accepting an order whose payment is refunded says why', async () => {
    const w = world(); w.rpcs.human_job_accept = () => ({ data: { ok: false, reason: 'payment_not_settled' }, error: null }); const a = build(w)
    const r = await call(a, 'POST', `/api/admin/human/orders/${J}/accept`, {}); expect(r.status).toBe(409); expect((await r.json()).message).toMatch(/refunded or disputed/)
  })
})

describe('payouts, adjustments, void, ledger (B3, G3)', () => {
  it('a payout key used for another expert is a 409 with a plain message', async () => {
    const w = world(); w.rpcs.expert_record_payout = () => ({ data: { ok: false, reason: 'key_conflict' }, error: null }); const a = build(w)
    const r = await call(a, 'POST', '/api/admin/human/payouts', { expertId: X, method: 'manual', reference: 'R', idempotencyKey: 'key-12345' }); expect(r.status).toBe(409); expect((await r.json()).message).toMatch(/already used/)
  })
  it('an adjustment goes to the database function with the operator and relays its refusals', async () => {
    const w = world(); const seen = []; w.rpcs.expert_record_adjustment = args => { seen.push(args); return { data: seen.length === 1 ? { ok: true, earning_id: 'e1' } : { ok: false, reason: 'bad_amount' }, error: null } }; const a = build(w)
    const body = { kind: 'penalty', amountCents: -500, reason: 'late delivery', idempotencyKey: 'adj-12345' }
    expect((await call(a, 'POST', `/api/admin/human/experts/${X}/adjustments`, body)).status).toBe(200)
    expect(seen[0]).toMatchObject({ p_expert: X, p_kind: 'penalty', p_amount: -500, p_job: null, p_reason: 'late delivery', p_key: 'adj-12345', p_actor: OP })
    expect(t.audit[0]).toEqual(['human.adjustment', { kind: 'penalty', amountCents: -500, jobId: null, already: false }])
    expect((await call(a, 'POST', `/api/admin/human/experts/${X}/adjustments`, { ...body, amountCents: 0 })).status).toBe(400)
    const r = await call(a, 'POST', `/api/admin/human/experts/${X}/adjustments`, body); expect(r.status).toBe(409); expect((await r.json()).code).toBe('bad_amount')
  })
  it('void: a reason is required, an unknown payout is 404', async () => {
    const w = world(); w.rpcs.expert_void_payout = args => ({ data: args.p_payout === PO ? { ok: true, amount_cents: 7000, already: false } : { ok: false, reason: 'not_found' }, error: null }); const a = build(w)
    expect((await call(a, 'POST', `/api/admin/human/payouts/${PO}/void`, { reason: 'x' })).status).toBe(400)
    expect((await call(a, 'POST', `/api/admin/human/payouts/${PO}/void`, { reason: 'wrong wallet' })).status).toBe(200)
    expect((await call(a, 'POST', `/api/admin/human/payouts/${J}/void`, { reason: 'wrong wallet' })).status).toBe(404)
    expect(t.audit[0]).toEqual(['human.payout_void', { amountCents: 7000, already: false }])
  })
  it('the experts list takes its numbers from expert_balances (no row cap) and shows frozen money', async () => {
    const w = world(); w.rpcs.expert_balances = () => ({ data: [{ expert_id: X, available_cents: 7000, held_cents: 500, frozen_cents: 1200, paid_cents: 9000 }], error: null }); const a = build(w)
    const e = (await (await call(a, 'GET', '/api/admin/human/experts')).json()).data.experts[0]
    expect(e).toMatchObject({ availableCents: 7000, onHoldCents: 500, frozenCents: 1200, paidCents: 9000 })
  })
  it('the ledger lists entries with their order numbers and statuses, and payouts with void marks', async () => {
    const w = world(); w.t.expert_earnings.push({ id: 'e1', expert_id: X, job_id: J, kind: 'pay', amount_cents: 7000, release_at: '2020-01-01T00:00:00Z', payout_id: null, reason: 'accepted', created_at: '2026-10-02T00:00:00Z' }, { id: 'e2', expert_id: X, job_id: null, kind: 'bonus', amount_cents: 500, release_at: '2099-01-01T00:00:00Z', payout_id: null, reason: 'fast', created_at: '2026-10-03T00:00:00Z' })
    w.t.expert_payouts.push({ id: PO, expert_id: X, amount_cents: 7000, method: 'manual', reference: 'R', paid_at: '2026-10-04T00:00:00Z', voided_at: '2026-10-05T00:00:00Z', void_reason: 'wrong wallet' }); const a = build(w)
    const d = (await (await call(a, 'GET', `/api/admin/human/experts/${X}/ledger`)).json()).data
    expect(d.earnings.map(x => [x.kind, x.jobNumber, x.status])).toEqual(expect.arrayContaining([['pay', 'HJ-AAAAAA', 'available'], ['bonus', null, 'held']]))
    expect(d.payouts[0]).toMatchObject({ voided: true, voidReason: 'wrong wallet' })
  })
})

describe('late credit (G3)', () => {
  it('sends a PARTIAL refund through the shared refund path, then records the figure', async () => {
    const w = world(); const sent = []; w.rpcs.human_job_add_late_credit = args => ({ data: { ok: true, late_credit_cents: args.p_cents }, error: null })
    const a = build(w, { refund: async (env, db, pay, o) => { sent.push([pay.id, o.amountCents]); return { ok: true } } })
    const r = await call(a, 'POST', `/api/admin/human/orders/${J}/late-credit`, { amountCents: 1000 }); expect(r.status).toBe(200); expect((await r.json()).data.lateCreditCents).toBe(1000)
    expect(sent).toEqual([['p1', 1000]]); expect(t.audit[0][0]).toBe('human.late_credit')
  })
  it('a credit that reaches the price is refused before any money moves; so is an unpaid or refunded payment', async () => {
    let called = 0; const refund = async () => { called++; return { ok: true } }
    const a = build(world({ job: { late_credit_cents: 11000 } }), { refund }); expect((await call(a, 'POST', `/api/admin/human/orders/${J}/late-credit`, { amountCents: 900 })).status).toBe(409)
    const b = build(world({ pay: { status: 'REFUNDED' } }), { refund }); expect((await call(b, 'POST', `/api/admin/human/orders/${J}/late-credit`, { amountCents: 100 })).status).toBe(409)
    const c = build(world({ job: { state: 'cancelled' } }), { refund }); expect((await call(c, 'POST', `/api/admin/human/orders/${J}/late-credit`, { amountCents: 100 })).status).toBe(409)
    expect(called).toBe(0)
  })
  it('a refused refund records nothing; a refund that went out but could not be recorded alerts the owner', async () => {
    const w1 = world(); let rec = 0; w1.rpcs.human_job_add_late_credit = () => { rec++; return { data: { ok: true }, error: null } }
    const a = build(w1, { refund: async () => ({ ok: false, code: 'OPEN_REFUND', status: 409, message: 'in progress' }) })
    expect((await call(a, 'POST', `/api/admin/human/orders/${J}/late-credit`, { amountCents: 100 })).status).toBe(409); expect(rec).toBe(0)
    const w2 = world(); w2.rpcs.human_job_add_late_credit = () => ({ data: { ok: false, reason: 'over_price' }, error: null }); const spy = console.error; console.error = () => {}
    try { const b = build(w2); expect((await call(b, 'POST', `/api/admin/human/orders/${J}/late-credit`, { amountCents: 100 })).status).toBe(502); expect(t.alerts).toHaveLength(1) } finally { console.error = spy }
  })
})
