// Webhooks round 25 (section 8, independent pass).
//   B1  refund payloads are stored through an ALLOW-list (no refunded_by / customer_note / merchant_note); older rows are scrubbed.
//   B2  a refund whose inbox row has no stored body cannot be closed as "partial" on a failed Paystack lookup (record_refund_and_total reads the body).
//   B3  the resolution of a dispute the payment no longer tracks does not clear the hold on a newer, still-open dispute.
//   G1  a refund stated in another currency than the sale is not added to the refund total.
//   m1  a payment's timeline shows its NEWEST 100 events; m2 (frontend) a missing payload is said, not shown as {}.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')
const cryptoLib = require_('../src/lib/crypto.js')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr })
const SECRET = 'sk_test_round25'

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
const payment = (over = {}) => ({ id: 'p1', paystack_ref: 'ref1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', scan_id: 's1', user_id: 'u1', refund_failed_at: null, ...over })
function refundWorld(over = {}) {
  const w = createWorld({ payments: [payment(over)], payment_refunds: [], webhook_events: [], scans: [{ id: 's1', user_id: 'u1' }], users: [{ id: 'u1', email: 'b@x.co' }], commission_ledger: [], system_state: [] })
  w.unique.webhook_events = [['provider', 'event_key']]; w.unique.system_state = [['key']]
  // Stand-in for record_refund_and_total (0053): reads the amount from the STORED body, exactly like the SQL function.
  w.rpcs.record_refund_and_total = ({ p_payment_id, p_event_id, p_count = true }) => {
    const row = w.t.webhook_events.find(r => r.id === p_event_id)
    const amt = Number(row?.payload?.data?.amount)
    if (p_count && row && Number.isFinite(amt) && !w.t.payment_refunds.some(r => r.payment_id === p_payment_id && r.event_key === row.event_key))
      w.t.payment_refunds.push({ payment_id: p_payment_id, event_key: row.event_key, amount_cents: amt })
    return { data: w.t.payment_refunds.filter(r => r.payment_id === p_payment_id).reduce((n, r) => n + r.amount_cents, 0), error: null }
  }
  return w
}
async function deliver(w, mod, event, { failBody = false } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(event))
  const hdr = { 'x-paystack-signature': await cryptoLib.hmacSha512Hex(SECRET, bytes) }
  const pending = []
  const c = { env: { PAYSTACK_SECRET_KEY: SECRET }, req: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), header: h => hdr[h.toLowerCase()] },
    executionCtx: { waitUntil: p => pending.push(p) }, text: (t, s) => ({ text: t, status: s }) }
  if (failBody) w.failNext('webhook_events', 'insert', { code: '22P05', message: 'unsupported Unicode escape sequence' })
  const res = await mod.handlePaystack(c); await Promise.all(pending)
  return res
}

describe('B1: refund payloads are an allow-list', () => {
  const ev = { event: 'refund.processed', data: { id: 1, amount: 500, currency: 'USD', status: 'processed', transaction_reference: 'r1', refund_reference: null, refunded_by: 'staff@merchant.com', customer_note: 'call 0712 345 678', merchant_note: 'internal', customer: { email: 'a@b.co' }, transaction: { id: 7, reference: 'r1', amount: 900, currency: 'USD', authorization: { last4: '4081' } }, metadata: { who: 'x@y.z' } } }
  it('keeps only what the handlers read', () => {
    const { mod } = load(createWorld({}))
    const out = mod.redactEvent(ev)
    expect(out).toEqual({ event: 'refund.processed', data: { id: 1, amount: 500, currency: 'USD', status: 'processed', transaction_reference: 'r1', refund_reference: null, transaction: { id: 7, reference: 'r1', amount: 900, currency: 'USD' } } })
  })
  it('a refund with neither id nor refund_reference is still ambiguous after the round trip', () => {
    const { mod } = load(createWorld({}))
    const out = mod.redactEvent({ event: 'refund.pending', data: { amount: 5, refund_reference: null, transaction_reference: 'r1', refunded_by: 'x@y.z' } })
    expect(mod.refundIsAmbiguous(out)).toBe(true)
  })
  it('a bare transaction string survives (referenceCandidates reads it)', () => {
    const { mod } = load(createWorld({}))
    expect(mod.redactEvent({ event: 'refund.processed', data: { id: 3, transaction: 'r9' } }).data.transaction).toBe('r9')
  })
  it('scrubRefundPayloads rewrites older rows and leaves the rest alone', async () => {
    const rows = [{ id: 'a', payload: ev }]
    const updates = []
    const q = { select() { return q }, eq() { return q }, like() { return q }, or() { return q }, limit: async () => ({ data: rows, error: null }),
      update(patch) { updates.push(patch); return { eq: async () => ({ error: null }) } } }
    const { mod } = load(createWorld({}))
    const n = await mod.scrubRefundPayloads({ from: () => q })
    expect(n).toBe(1)
    expect(JSON.stringify(updates[0])).not.toMatch(/staff@merchant|0712|internal/)
    expect(updates[0].payload.data.amount).toBe(500)
  })
  it('scrubRefundPayloads never throws', async () => {
    const { mod } = load(createWorld({}))
    expect(await mod.scrubRefundPayloads({ from: () => { throw new Error('boom') } })).toBe(0)
  })
})

describe('B2: a refund with no stored body is judged by Paystack alone', () => {
  const half = { event: 'refund.processed', data: { id: 21, amount: 1450, currency: 'USD', transaction_reference: 'ref1' } }
  it('recordEvent reports payloadMissing when the database refused the body', async () => {
    const w = createWorld({ webhook_events: [] }); w.unique.webhook_events = [['provider', 'event_key']]
    const { mod } = load(w)
    w.failNext('webhook_events', 'insert', { code: '22P05', message: 'unsupported Unicode escape sequence' })
    const r = await mod.recordEvent(w.db, { eventKey: 'k', eventType: 'refund.processed', reference: 'r', payload: { event: 'refund.processed', data: {} } })
    expect(r).toMatchObject({ mode: 'new', payloadMissing: true })
  })
  it('a failed Paystack lookup answers 500 (retry) instead of closing the refund as partial', async () => {
    const w = refundWorld(); const { mod, alerts } = load(w, { listRefunds: async () => { throw new Error('paystack down') } })
    const res = await deliver(w, mod, half, { failBody: true })
    expect(res.status).toBe(500)
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(w.t.webhook_events[0].status).toBe('FAILED')
    expect(alerts.some(a => /partial/.test(a.subject))).toBe(false)
  })
  it('the same refund with its body stored keeps the old behaviour (partial, alerted, closed)', async () => {
    const w = refundWorld(); const { mod, alerts } = load(w, { listRefunds: async () => { throw new Error('paystack down') } })
    const res = await deliver(w, mod, half)
    expect(res.status).toBe(200)
    expect(alerts.some(a => /partial/.test(a.subject))).toBe(true)
  })
  it('when Paystack answers, a body-less refund that completes the sale reverses it', async () => {
    const w = refundWorld(); const { mod } = load(w, { listRefunds: async () => ({ data: [{ status: 'processed', amount: 1450, currency: 'USD' }, { status: 'processed', amount: 1450, currency: 'USD' }] }) })
    const res = await deliver(w, mod, half, { failBody: true })
    expect(res.status).toBe(200)
    expect(w.t.payments[0].status).toBe('REFUNDED')
  })
  it('a redelivery heals the missing body', async () => {
    const w = refundWorld(); const { mod } = load(w, { listRefunds: async () => { throw new Error('paystack down') } })
    await deliver(w, mod, half, { failBody: true })
    expect(w.t.webhook_events[0].payload).toBeNull()
    await deliver(w, mod, half)
    expect(w.t.webhook_events[0].payload).toMatchObject({ event: 'refund.processed' })
  })
})

describe('G1: a refund in another currency is not summed into the sale', () => {
  it('is alerted and left for the owner', async () => {
    const w = refundWorld(); const { mod, alerts } = load(w)
    const res = await deliver(w, mod, { event: 'refund.processed', data: { id: 31, amount: 2900, currency: 'KES', transaction_reference: 'ref1' } })
    expect(res.status).toBe(200)
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(w.t.payment_refunds).toHaveLength(0)
    expect(alerts.some(a => /different currency/.test(a.subject))).toBe(true)
  })
  it('matching currency (any case) and no stated currency are unaffected', async () => {
    const w = refundWorld(); const { mod } = load(w)
    await deliver(w, mod, { event: 'refund.processed', data: { id: 32, amount: 2900, currency: 'usd', transaction_reference: 'ref1' } })
    expect(w.t.payments[0].status).toBe('REFUNDED')
    const w2 = refundWorld(); const l2 = load(w2)
    await deliver(w2, l2.mod, { event: 'refund.processed', data: { id: 33, amount: 2900, transaction_reference: 'ref1' } })
    expect(w2.t.payments[0].status).toBe('REFUNDED')
  })
})

describe('B3: an older dispute\'s resolution does not clear a newer open one', () => {
  const resolve = (id, resolution = 'declined') => ({ event: 'charge.dispute.resolve', data: { id, status: 'resolved', resolution, refund_amount: 2900, transaction: { reference: 'ref1' } } })
  const disputedWorld = over => { const w = refundWorld({ status: 'DISPUTED', dispute_id: '200', ...over }); return w }
  it('a declined resolution for another dispute id leaves the payment DISPUTED and unanswered', async () => {
    const w = disputedWorld(); const { mod, alerts } = load(w)
    await deliver(w, mod, resolve(100))
    expect(w.t.payments[0].status).toBe('DISPUTED')
    expect(w.t.payments[0].dispute_answered_at ?? null).toBeNull()
    expect(alerts.some(a => /newer dispute/.test(a.message))).toBe(true)
  })
  it('the tracked dispute\'s own declined resolution still clears it', async () => {
    const w = disputedWorld(); const { mod } = load(w)
    await deliver(w, mod, resolve(200))
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('a payment with no stored dispute id behaves as before', async () => {
    const w = disputedWorld({ dispute_id: null }); const { mod } = load(w)
    await deliver(w, mod, resolve(100))
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
})

describe('m1: the payment timeline shows the newest events, oldest first', () => {
  it('asks for the newest 100 and returns them in time order', async () => {
    const all = Array.from({ length: 130 }, (_, i) => ({ id: `e${i}`, event_type: 'charge.dispute.remind', status: 'PROCESSED', attempts: 1, received_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }))
    let asc = null, lim = null
    // PostgREST semantics for the one query this endpoint makes (the shared test double records limit() but does not apply it).
    const q = { select() { return q }, eq() { return q }, order(_c, { ascending }) { asc = ascending; return q }, limit(n) { lim = n; const rows = [...all].sort((a, b) => (asc ? 1 : -1) * a.received_at.localeCompare(b.received_at)).slice(0, n); return Promise.resolve({ data: rows, error: null }) } }
    const { mod } = load({ db: { from: () => q } })
    const r = await mod.getPaymentTimeline({ env: {}, req: { param: () => 'ref1' }, json: b => b })
    expect(asc).toBe(false); expect(lim).toBe(100)
    expect(r.data).toHaveLength(100)
    expect(r.data[0].id).toBe('e30'); expect(r.data[99].id).toBe('e129')
  })
})
