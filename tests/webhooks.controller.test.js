import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { hmacSha512Hex } from '../src/lib/crypto.js'

const SECRET = 'sk_test_secret'
const OLD = new Date(Date.now() - 60 * 60_000).toISOString()

// A realistic little world: one paid-for scan, one PENDING payment, an owner.
function seed(over = {}) {
  const world = createWorld({
    users:    [{ id: 'u1', deleted_at: null }],
    scans:    [{ id: 'scan1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false, fix_payment_id: null, updated_at: OLD, verification_code: 'AB3XY7', verification_status: 'ACTIVE' }],
    payments: [{ id: 'pay1', paystack_ref: 'ref-1', status: 'PENDING', amount_cents: 2900, currency: 'USD', scan_id: 'scan1', fix_tier: 'FIX', referral_code_id: null }],
    webhook_events: [], commission_ledger: [],
    ...over,
  })
  world.unique.webhook_events = [['provider', 'event_key']]
  world.partialUnique.commission_ledger = [
    { cols: ['payment_id'],        where: r => !r.reverses_ledger_id },
    { cols: ['reverses_ledger_id'], where: r => !!r.reverses_ledger_id },
  ]
  // ROUND 4 (B1/B3): stand-in for record_refund_and_total (migration 0053) — records this event's
  // amount ONCE in payment_refunds (unique payment_id + event_key), returns the persisted total, and
  // never touches webhook_events.status. p_count:false returns the total without recording.
  world.t.payment_refunds = world.t.payment_refunds || []
  world.rpcs.record_refund_and_total = ({ p_payment_id, p_event_id, p_count = true }) => {
    const row = world.t.webhook_events.find(r => r.id === p_event_id)
    const amt = Number(row?.payload?.data?.amount)
    if (p_count && row && Number.isFinite(amt) &&
        !world.t.payment_refunds.some(r => r.payment_id === p_payment_id && r.event_key === row.event_key))
      world.t.payment_refunds.push({ payment_id: p_payment_id, event_key: row.event_key, amount_cents: amt })
    const total = world.t.payment_refunds.filter(r => r.payment_id === p_payment_id).reduce((n, r) => n + r.amount_cents, 0)
    return { data: total, error: null }
  }
  return world
}

function harness(world, opts = {}) {
  const state = { queue: [], alerts: [], conversions: [], kv: new Map(), order: [], refunds: opts.refunds || [], refundLookups: 0, buyerNotices: [] }
  const { mod, restore } = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message, opts) => { state.alerts.push({ subject, message, opts }); return true },
      sendPaymentReversed: async (env, db, to, name, p) => { state.buyerNotices.push({ to, name, ...p }); return true } },
    'services/referral.service.js': { recordConversion: async (db, payment) => { state.order.push('commission'); state.conversions.push(payment.id); return { ok: true } } },
    // Paystack's refund list (the authoritative total processRefund consults when the local one falls short).
    'services/paystack.service.js': { listRefunds: async () => { state.refundLookups++; if (opts.refundListError) throw opts.refundListError; return { data: state.refunds } } },
  })

  async function fire(event, { signature, headers = {}, rawBody } = {}) {
    const text = rawBody ?? (typeof event === 'string' ? event : JSON.stringify(event))
    const bytes = new TextEncoder().encode(text)
    const sig = signature ?? await hmacSha512Hex(SECRET, bytes)
    const pending = []
    const hdr = { 'x-paystack-signature': sig, ...headers }
    const c = {
      env: {
        ...(opts.noSecret ? {} : { PAYSTACK_SECRET_KEY: SECRET }),
        ...(opts.env || {}),
        FIX_QUEUE: { send: async m => { if (opts.queueError) throw opts.queueError; state.order.push('queue'); state.queue.push(m) } },
        RATE_LIMIT_KV: { get: async k => state.kv.get(k) ?? null, put: async (k, v) => { state.kv.set(k, v) } },
      },
      req: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), header: h => hdr[h.toLowerCase()] },
      executionCtx: { waitUntil: p => pending.push(p) },
      text: (t, s) => ({ text: t, status: s }),
    }
    const res = await mod.handlePaystack(c)
    await Promise.all(pending)
    return res
  }
  return { fire, state, restore }
}

const chargeSuccess = (over = {}, id = 111) => ({
  event: 'charge.success',
  data: { id, reference: 'ref-1', amount: 2900, currency: 'USD', metadata: { scanId: 'scan1' },
          authorization: { authorization_code: 'AUTH_x' }, customer: { email: 'a@b.c' }, ...over },
})

// The pure helpers need the module loaded, not a world: only the DB client is stubbed.
const pure = () => loadWithStubs('controllers/webhooks.controller.js', { 'config/supabase.js': { getSupabase: () => null } })

let realConsoleError, t
beforeEach(() => { realConsoleError = console.error; console.error = () => {} })
afterEach(() => { console.error = realConsoleError; t?.restore() })

describe('signature, size and source checks', () => {
  it('rejects a bad signature with 401 and touches nothing', async () => {
    const w = seed(); t = harness(w)
    const res = await t.fire(chargeSuccess(), { signature: 'deadbeef' })
    expect(res.status).toBe(401)
    expect(w.calls).toHaveLength(0)
    expect(w.t.payments[0].status).toBe('PENDING')
  })
  it('rejects a missing signature', async () => {
    const w = seed(); t = harness(w)
    const res = await t.fire(chargeSuccess(), { signature: '' })
    expect(res.status).toBe(401)
  })
  it('emails the owner about a signature mismatch only ONCE per cooldown window', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess(), { signature: 'x' }); await t.fire(chargeSuccess(), { signature: 'y' }); await t.fire(chargeSuccess(), { signature: 'z' })
    expect(t.state.alerts.filter(a => /signature mismatch/i.test(a.subject))).toHaveLength(1)
  })
  it('fails CLOSED and LOUD when PAYSTACK_SECRET_KEY is not configured (500 + alert, never processes)', async () => {
    const w = seed(); t = harness(w, { noSecret: true })
    const res = await t.fire(chargeSuccess())
    expect(res.status).toBe(500)
    expect(t.state.alerts.some(a => /secret not configured/i.test(a.subject))).toBe(true)
    expect(w.t.payments[0].status).toBe('PENDING')
  })
  it('rejects an oversized body (declared) with 413 before any crypto or DB work', async () => {
    const w = seed(); t = harness(w)
    const res = await t.fire(chargeSuccess(), { headers: { 'content-length': String(10 * 1024 * 1024) } })
    expect(res.status).toBe(413)
    expect(w.calls).toHaveLength(0)
  })
  it('rejects an oversized body even when content-length lies', async () => {
    const w = seed(); t = harness(w)
    const res = await t.fire(null, { rawBody: 'x'.repeat(300 * 1024) })
    expect(res.status).toBe(413)
  })
  it('signs the RAW bytes: a payload whose text() round-trip would differ still verifies', async () => {
    const w = seed(); t = harness(w)
    // Leading BOM: Request.text() strips it, so signing text() would never match Paystack's signature.
    const body = '\uFEFF' + JSON.stringify(chargeSuccess())
    const res = await t.fire(null, { rawBody: body })
    // Signature verified (not 401); the BOM makes the JSON unparseable so it is acknowledged and ignored.
    expect(res.status).toBe(200)
  })
  it('optional IP allowlist: blocks other sources, admits listed ones', async () => {
    const w = seed(); t = harness(w, { env: { PAYSTACK_WEBHOOK_IPS: '52.31.139.75, 52.49.173.169' } })
    expect((await t.fire(chargeSuccess(), { headers: { 'cf-connecting-ip': '6.6.6.6' } })).status).toBe(403)
    expect(w.t.payments[0].status).toBe('PENDING')
    expect((await t.fire(chargeSuccess(), { headers: { 'cf-connecting-ip': '52.49.173.169' } })).status).toBe(200)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('answers 200 to an unparseable or non-event body (nothing sensible for Paystack to retry)', async () => {
    const w = seed(); t = harness(w)
    expect((await t.fire(null, { rawBody: '{not json' })).status).toBe(200)
    expect((await t.fire({ hello: 'world' })).status).toBe(200)
    expect(w.calls).toHaveLength(0)
  })
})

describe('charge.success — fulfilment', () => {
  it('flips the payment, claims the scan for THIS payment, and enqueues generateFix exactly once', async () => {
    const w = seed(); t = harness(w)
    const res = await t.fire(chargeSuccess())
    expect(res.status).toBe(200)
    expect(w.t.payments[0]).toMatchObject({ status: 'SUCCESS', paystack_auth_code: 'AUTH_x' })
    expect(w.t.scans[0]).toMatchObject({ fix_purchased: true, fix_tier: 'FIX', status: 'FIX_PURCHASED', fix_payment_id: 'pay1' })
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 'scan1' }])
  })
  it('a BADGE payment enqueues generateBadge and stores fix_tier BADGE', async () => {
    const w = seed(); w.t.payments[0].fix_tier = 'BADGE'; t = harness(w)
    await t.fire(chargeSuccess())
    expect(w.t.scans[0].fix_tier).toBe('BADGE')
    expect(t.state.queue).toEqual([{ type: 'generateBadge', scanId: 'scan1' }])
  })
  it('defaults a missing fix_tier on the payment row to FIX', async () => {
    const w = seed(); w.t.payments[0].fix_tier = null; t = harness(w)
    await t.fire(chargeSuccess())
    expect(w.t.scans[0].fix_tier).toBe('FIX')
  })
  it('REGRESSION (B8-4): a signed charge.success with NO metadata is still fulfilled — the payment row knows its scan', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess({ metadata: undefined }))
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.queue).toHaveLength(1)
  })
  it('trusts the payment ROW scan_id over the event metadata scanId', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess({ metadata: { scanId: 'someone-elses-scan' } }))
    expect(t.state.queue[0].scanId).toBe('scan1')
  })
  it('B8-5: the customer is fulfilled BEFORE the partner commission is recorded', async () => {
    const w = seed(); w.t.payments[0].referral_code_id = 'rc1'; t = harness(w)
    await t.fire(chargeSuccess())
    expect(t.state.order).toEqual(['queue', 'commission'])
    expect(t.state.conversions).toEqual(['pay1'])
  })
  it('records the webhook in the inbox as PROCESSED, with card/customer detail stripped', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess())
    const ev = w.t.webhook_events[0]
    expect(ev).toMatchObject({ event_type: 'charge.success', reference: 'ref-1', status: 'PROCESSED' })
    expect(ev.payload.data.authorization).toBeUndefined()
    expect(ev.payload.data.customer).toBeUndefined()
    expect(ev.payload.data.reference).toBe('ref-1')
  })

  it('B8-1: a TRANSIENT DB error answers 500 (so Paystack retries) and the redelivery then succeeds', async () => {
    const w = seed(); t = harness(w)
    w.failNext('payments', 'select', { message: 'fetch failed' })
    const first = await t.fire(chargeSuccess())
    expect(first.status).toBe(500)
    expect(w.t.payments[0].status).toBe('PENDING')
    expect(w.t.webhook_events[0].status).toBe('FAILED')
    expect(t.state.alerts.some(a => /will retry/i.test(a.subject))).toBe(true)

    const second = await t.fire(chargeSuccess())          // Paystack redelivers the same event
    expect(second.status).toBe(200)
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.queue).toHaveLength(1)
    expect(w.t.webhook_events).toHaveLength(1)             // same inbox row, attempts bumped
    expect(w.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED', attempts: 2 })
  })
  it('a failure on the very first inbox write also answers 500', async () => {
    const w = seed(); t = harness(w)
    w.failNext('webhook_events', 'insert', { message: 'connection reset' })
    expect((await t.fire(chargeSuccess())).status).toBe(500)
    expect(w.t.payments[0].status).toBe('PENDING')
  })
  it('a queue failure AFTER the claim answers 500; the redelivery re-enqueues the lost job', async () => {
    const w = seed(); t = harness(w, { queueError: new Error('queue down') })
    expect((await t.fire(chargeSuccess())).status).toBe(500)
    expect(w.t.scans[0]).toMatchObject({ fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_PURCHASED' })
    t.restore()
    t = harness(w)                                          // queue is back…
    w.t.scans[0].updated_at = OLD                           // …and Paystack's retry arrives minutes later
    expect((await t.fire(chargeSuccess())).status).toBe(200)
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 'scan1' }])
  })
  it('is idempotent: a redelivered event is acknowledged from the inbox and fulfils nothing twice', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess()); await t.fire(chargeSuccess())
    expect(t.state.queue).toHaveLength(1)
  })
  it('is idempotent even with NO inbox record: a second event id for the same payment does not re-enqueue', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess({}, 111)); await t.fire(chargeSuccess({}, 222))
    expect(t.state.queue).toHaveLength(1)
    expect(t.state.conversions).toHaveLength(1)   // commission only for the delivery that won the flip
  })

  it('does NOT fulfil, and alerts, on an amount mismatch; the payment stays PENDING and the event is HELD', async () => {
    const w = seed(); t = harness(w)
    expect((await t.fire(chargeSuccess({ amount: 100 }))).status).toBe(200)
    expect(w.t.payments[0].status).toBe('PENDING')
    expect(t.state.queue).toHaveLength(0)
    expect(w.t.webhook_events[0].status).toBe('HELD')
    expect(t.state.alerts.some(a => /mismatch/i.test(a.subject) && /recheck/i.test(a.message))).toBe(true)
  })
  it('does NOT fulfil on a currency mismatch', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess({ currency: 'NGN' }))
    expect(t.state.queue).toHaveLength(0)
    expect(w.t.payments[0].status).toBe('PENDING')
  })
  it('ignores — but ALERTS about — a reference with no payment row (once per reference)', async () => {
    // ROUND-2 AUDIT: this used to assert ONE alert for two different unknown
    // references (a single global cooldown) — i.e. the second customer's
    // "money arrived for a payment we cannot find" alert was silently dropped.
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess({ reference: 'ghost-1' }, 1)); await t.fire(chargeSuccess({ reference: 'ghost-2' }, 2))
    expect(t.state.queue).toHaveLength(0)
    const unknown = t.state.alerts.filter(a => /unknown reference/i.test(a.subject))
    expect(unknown).toHaveLength(2)
    expect(unknown[0].message).toContain('ghost-1')
    expect(unknown[1].message).toContain('ghost-2')
    expect(w.t.webhook_events.every(e => e.status === 'IGNORED')).toBe(true)
  })

  it('REGRESSION: an ABANDONED payment (stale-checkout cleanup) that then really gets paid is still fulfilled', async () => {
    const w = seed(); w.t.payments[0].status = 'ABANDONED'; t = harness(w)
    await t.fire(chargeSuccess())
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.queue).toHaveLength(1)
  })
  it('REGRESSION: a FAILED attempt followed by a successful retry on the same reference is fulfilled', async () => {
    // (FAILED rows come from other paths — Paystack sends no `charge.failed` event, see below.)
    const w = seed(); w.t.payments[0].status = 'FAILED'; t = harness(w)
    await t.fire(chargeSuccess())
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.queue).toHaveLength(1)
  })
  it('never re-fulfils a REFUNDED payment on a late duplicate event', async () => {
    const w = seed(); w.t.payments[0].status = 'REFUNDED'; t = harness(w)
    await t.fire(chargeSuccess())
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(t.state.queue).toHaveLength(0)
  })

  it('B8-2: a SECOND payment for an already-purchased scan is NOT re-generated, earns no commission, and alerts', async () => {
    const w = seed()
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay-first', status: 'FIX_DELIVERED' })
    w.t.payments.push({ id: 'pay2', paystack_ref: 'ref-2', status: 'PENDING', amount_cents: 2900, currency: 'USD', scan_id: 'scan1', fix_tier: 'FIX', referral_code_id: 'rc1' })
    t = harness(w)
    await t.fire(chargeSuccess({ reference: 'ref-2' }, 222))
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.conversions).toHaveLength(0)
    expect(w.t.scans[0]).toMatchObject({ status: 'FIX_DELIVERED', fix_payment_id: 'pay-first' })
    expect(t.state.alerts.some(a => /DUPLICATE/.test(a.subject) && /refund/i.test(a.message))).toBe(true)
  })
  it('a payment for a scan that no longer exists is not enqueued — the owner is told to refund', async () => {
    const w = seed(); w.t.scans.length = 0; t = harness(w)
    await t.fire(chargeSuccess())
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.alerts.some(a => /SCAN_MISSING/.test(a.subject))).toBe(true)
  })
  it('a payment for a DELETED account is not enqueued — the owner is told to refund', async () => {
    const w = seed(); w.t.users[0].deleted_at = OLD; t = harness(w)
    await t.fire(chargeSuccess())
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.alerts.some(a => /ACCOUNT_DELETED/.test(a.subject))).toBe(true)
  })
  it('works when the webhook_events table has not been migrated yet (processes, and says so)', async () => {
    const w = seed(); t = harness(w)
    w.failNext('webhook_events', 'insert', { code: '42P01', message: 'relation "webhook_events" does not exist' })
    expect((await t.fire(chargeSuccess())).status).toBe(200)
    expect(t.state.queue).toHaveLength(1)
    expect(t.state.alerts.some(a => /webhook_events table missing/i.test(a.subject))).toBe(true)
  })
})

describe('charge.failed (not a Paystack event — round 3)', () => {
  // Paystack's documented webhook list has no charge.failed. The handler for it was dead code;
  // if one ever arrives it is stored and IGNORED, and touches nothing.
  it('is stored as IGNORED and never changes a payment', async () => {
    const w = seed(); t = harness(w)
    const res = await t.fire({ event: 'charge.failed', data: { id: 5, reference: 'ref-1' } })
    expect(res.status).toBe(200)
    expect(w.t.payments[0].status).toBe('PENDING')
    expect(w.t.webhook_events[0]).toMatchObject({ event_type: 'charge.failed', status: 'IGNORED' })
    expect(t.state.alerts).toHaveLength(0)
    expect(t.state.queue).toHaveLength(0)
  })
})

describe('refunds (B8-3 / G8-1)', () => {
  function paidWorld() {
    const w = seed()
    Object.assign(w.t.payments[0], { status: 'SUCCESS', referral_code_id: 'rc1' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    w.t.commission_ledger.push({ id: 'led1', payment_id: 'pay1', partner_id: 'part1', referral_code_id: 'rc1', gross_amount_cents: 2900, commission_rate: 0.2, commission_amount_cents: 580, payout_id: null, reverses_ledger_id: null })
    return w
  }
  const refund = (over = {}, id = 900) => ({ event: 'refund.processed', data: { id, status: 'processed', transaction_reference: 'ref-1', refund_reference: 'rf-9', amount: 2900, currency: 'USD', ...over } })

  it("finds the payment via Paystack's refund shape (transaction_reference) and reverses the whole sale", async () => {
    const w = paidWorld(); t = harness(w)
    expect((await t.fire(refund())).status).toBe(200)
    expect(w.t.payments[0]).toMatchObject({ status: 'REFUNDED', refund_reference: 'rf-9' })
    const reversal = w.t.commission_ledger.find(r => r.reverses_ledger_id === 'led1')
    expect(reversal).toMatchObject({ commission_amount_cents: -580, gross_amount_cents: -2900, payment_id: 'pay1' })
    expect(w.t.commission_ledger.reduce((s, r) => s + r.commission_amount_cents, 0)).toBe(0)   // nets to zero
    expect(w.t.scans[0]).toMatchObject({ verification_status: 'REVOKED', verification_revoked_reason: 'REFUND' })
    expect(t.state.alerts.some(a => /sale reversed/i.test(a.subject) && /scanId: scan1/.test(a.message))).toBe(true)
  })
  it('a redelivery under a different event id does not double-reverse the commission', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(refund({}, 900)); await t.fire(refund({}, 901))
    expect(w.t.commission_ledger.filter(r => r.reverses_ledger_id)).toHaveLength(1)
  })
  it('an already-PAID-OUT commission is reversed with a negative row that nets against the next payout', async () => {
    const w = paidWorld(); w.t.commission_ledger[0].payout_id = 'po1'; t = harness(w)
    await t.fire(refund())
    const reversal = w.t.commission_ledger.find(r => r.reverses_ledger_id)
    expect(reversal.payout_id ?? null).toBeNull()
    expect(t.state.alerts.some(a => /ALREADY PAID OUT/.test(a.message))).toBe(true)
  })
  it("refunding a DUPLICATE payment does not tear down the credential owned by the first payment", async () => {
    const w = paidWorld()
    w.t.payments.push({ id: 'pay2', paystack_ref: 'ref-2', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', scan_id: 'scan1', fix_tier: 'FIX' })
    t = harness(w)
    await t.fire(refund({ transaction_reference: 'ref-2' }))
    expect(w.t.payments[1].status).toBe('REFUNDED')
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(w.t.scans[0].verification_status).toBe('ACTIVE')
    expect(w.t.commission_ledger.filter(r => r.reverses_ledger_id)).toHaveLength(0)
  })
  it('a PARTIAL refund is NOT actioned automatically — only alerted', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(refund({ amount: 1000 }))
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(w.t.scans[0].verification_status).toBe('ACTIVE')
    expect(t.state.alerts.some(a => /partial/i.test(a.subject))).toBe(true)
  })
  it('a refund with no stated amount is not actioned either', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(refund({ amount: undefined }))
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('refund.pending / refund.processing are recorded but do nothing', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire({ event: 'refund.pending', data: { id: 1, transaction_reference: 'ref-1' } })
    await t.fire({ event: 'refund.processing', data: { id: 2, transaction_reference: 'ref-1' } })
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.alerts).toHaveLength(0)
    expect(w.t.webhook_events.every(e => e.status === 'IGNORED')).toBe(true)
  })
  it('refund.failed alerts and changes nothing', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire({ event: 'refund.failed', data: { id: 3, transaction_reference: 'ref-1' } })
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.alerts.some(a => /refund\.failed/.test(a.subject))).toBe(true)
  })
  it('a refund that matches no payment is alerted, not silently dropped', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(refund({ transaction_reference: 'nope' }))
    expect(t.state.alerts.some(a => /payment not found/i.test(a.subject))).toBe(true)
  })
})

describe('disputes (B8-3 / G8-1)', () => {
  function paidWorld() {
    const w = seed()
    Object.assign(w.t.payments[0], { status: 'SUCCESS' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    return w
  }
  // Paystack nests the original charge under data.transaction
  const dispute = (type, over = {}, id = 700) => ({ event: type, data: { id, status: 'awaiting-merchant-feedback', transaction: { reference: 'ref-1', amount: 2900 }, ...over } })

  it("resolves the payment from Paystack's NESTED transaction.reference, marks it DISPUTED, and names the scan in the alert", async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(dispute('charge.dispute.create'))
    expect(w.t.payments[0].status).toBe('DISPUTED')
    expect(w.t.payments[0].disputed_at).toBeTruthy()
    const a = t.state.alerts.find(x => /dispute\.create/.test(x.subject))
    expect(a.message).toMatch(/scanId: scan1/)
    expect(a.message).not.toMatch(/could not resolve/)
  })
  it('does NOT revoke access, the credential, or the commission on dispute.create (a human decides)', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(dispute('charge.dispute.create'))
    expect(w.t.scans[0]).toMatchObject({ verification_status: 'ACTIVE', fix_purchased: true })
    expect(w.t.commission_ledger).toHaveLength(0)
  })
  it('repeated reminders each alert (they are distinct events) without changing state', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(dispute('charge.dispute.create'))
    await t.fire(dispute('charge.dispute.remind', { due_at: 'a' }))
    await t.fire(dispute('charge.dispute.remind', { due_at: 'b' }))
    expect(t.state.alerts.filter(a => /dispute\.remind/.test(a.subject))).toHaveLength(2)
    expect(w.t.payments[0].status).toBe('DISPUTED')
  })
  it('dispute.resolve alerts with the resolution, and (round 5) a lost dispute now reverses the sale itself', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(dispute('charge.dispute.create'))
    await t.fire(dispute('charge.dispute.resolve', { status: 'resolved', resolution: 'merchant-accepted' }))
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(t.state.alerts.find(a => /dispute\.resolve/.test(a.subject)).message).toMatch(/merchant-accepted/)
  })
  it('an unmatched dispute still alerts (and says it could not resolve)', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(dispute('charge.dispute.create', { transaction: { reference: 'ghost' } }))
    expect(t.state.alerts.find(a => /dispute\.create/.test(a.subject)).message).toMatch(/could not resolve/)
  })
  // SECTION 8 AUDIT FIX (bug): the alert used to say "The payment is now
  // marked DISPUTED" on every charge.dispute.create event regardless of
  // whether the guarded update actually ran — a false state claim in the
  // one email a human uses to decide whether to act. It must only say that
  // when the payment really was (re-)marked.
  it('an unmatched dispute does NOT falsely claim the payment was marked DISPUTED', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(dispute('charge.dispute.create', { transaction: { reference: 'ghost' } }))
    const a = t.state.alerts.find(x => /dispute\.create/.test(x.subject))
    expect(a.message).not.toMatch(/now marked DISPUTED/)
    expect(a.message).toMatch(/nothing was marked/i)
  })
  it('a second, genuinely-new dispute id against an already-DISPUTED payment does NOT falsely re-claim it was marked', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(dispute('charge.dispute.create'))            // id 700 — genuinely marks DISPUTED
    await t.fire(dispute('charge.dispute.create', {}, 701))    // a real, distinct dispute id from Paystack
    const alerts = t.state.alerts.filter(x => /dispute\.create/.test(x.subject))
    expect(alerts).toHaveLength(2)
    expect(alerts[0].message).toMatch(/now marked DISPUTED/)
    expect(alerts[1].message).not.toMatch(/now marked DISPUTED/)
    expect(alerts[1].message).toMatch(/nothing was marked/i)
    expect(w.t.payments[0].status).toBe('DISPUTED')
  })
})

describe('other events', () => {
  it('ignores unrelated event types but still records them', async () => {
    const w = seed(); t = harness(w)
    expect((await t.fire({ event: 'transfer.success', data: { id: 9 } })).status).toBe(200)
    expect(w.t.webhook_events[0]).toMatchObject({ event_type: 'transfer.success', status: 'IGNORED' })
    expect(t.state.queue).toHaveLength(0)
  })
})

// ── ROUND-2 AUDIT (sections 7/8) ────────────────────────────────────────────
describe('round 2 — refunds', () => {
  function paidWorld() {
    const w = seed()
    Object.assign(w.t.payments[0], { status: 'SUCCESS', referral_code_id: 'rc1' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    return w
  }
  it('refund.needs-attention is ALERTED (Paystack stalls it until bank details are supplied), payment untouched', async () => {
    const w = paidWorld(); t = harness(w)
    const res = await t.fire({ event: 'refund.needs-attention', data: { status: 'needs-attention', transaction_reference: 'ref-1', refund_reference: null, amount: '2900', currency: 'USD' } })
    expect(res.status).toBe(200)
    const a = t.state.alerts.find(x => /needs attention/i.test(x.subject))
    expect(a).toBeDefined()
    expect(a.message).toMatch(/bank/i)
    expect(a.message).toMatch(/scanId: scan1/)
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(w.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED' })
  })
  it('refund.pending / processing are still just recorded (IGNORED), no alert', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire({ event: 'refund.pending', data: { transaction_reference: 'ref-1', amount: '2900' } })
    expect(t.state.alerts).toHaveLength(0)
    expect(w.t.webhook_events[0].status).toBe('IGNORED')
  })
  it('REGRESSION: two DIFFERENT partial refunds on one transaction are two events, not one', async () => {
    const w = paidWorld(); t = harness(w)
    const partial = (amount, rf) => ({ event: 'refund.processed', data: { transaction_reference: 'ref-1', refund_reference: rf, amount, currency: 'USD' } })
    await t.fire(partial('1000', 'rf-1')); await t.fire(partial('800', 'rf-2'))
    expect(w.t.webhook_events.filter(e => e.event_type === 'refund.processed')).toHaveLength(2)
    expect(t.state.alerts.filter(a => /partial/i.test(a.subject))).toHaveLength(2)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('ROUND 3: partial refunds are SUMMED — the one that brings the total to the amount paid reverses the sale', async () => {
    const w = paidWorld(); t = harness(w)
    const partial = (amount, rf) => ({ event: 'refund.processed', data: { transaction_reference: 'ref-1', refund_reference: rf, amount, currency: 'USD' } })
    await t.fire(partial('1000', 'rf-1'))
    expect(w.t.payments[0].status).toBe('SUCCESS')
    await t.fire(partial('1900', 'rf-2'))                       // 1000 + 1900 = 2900 = the amount paid
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(t.state.alerts.some(a => /sale reversed/i.test(a.subject))).toBe(true)
  })
  it('SECTION 8 AUDIT FIX: two DISTINCT partial refunds fired CONCURRENTLY still sum to a full reversal', async () => {
    // The bug this closes: refundedSoFar read the total in JS with no lock, so two
    // DIFFERENT partial-refund events for the same transaction, processed by two
    // concurrent Worker invocations, could each read the total before the other's
    // row was marked PROCESSED and both conclude "not full" — never reversing a
    // sale that, together, they did fully refund. record_refund_and_total locks the
    // payment row and marks its own event PROCESSED before summing, so this comes
    // out right regardless of dispatch order.
    const w = paidWorld(); t = harness(w)
    const partial = (amount, rf) => ({ event: 'refund.processed', data: { transaction_reference: 'ref-1', refund_reference: rf, amount, currency: 'USD' } })
    await Promise.all([t.fire(partial('1000', 'rf-1')), t.fire(partial('1900', 'rf-2'))])
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(t.state.alerts.some(a => /sale reversed/i.test(a.subject))).toBe(true)
  })
  it('ROUND 3: a redelivered partial refund is NOT counted twice toward the total', async () => {
    const w = paidWorld(); t = harness(w)
    const ev = { event: 'refund.processed', data: { transaction_reference: 'ref-1', refund_reference: 'rf-1', amount: '1500', currency: 'USD' } }
    await t.fire(ev); await t.fire(ev)                          // 1500 + 1500 would be 3000 >= 2900
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('ROUND 3: id-less refund events on DIFFERENT transactions with the same amount do not collide', () => {
    const { mod: mod0, restore } = pure()
    const a = h => mod0.eventKeyFor({ event: 'refund.processed', data: { amount: '1000' } }, h)
    expect(a('aaaaaaaaaaaaaaaaaaaa')).not.toBe(a('bbbbbbbbbbbbbbbbbbbb'))
    restore()
  })
  // SECTION 8 AUDIT FIX (bug): refund.needs-attention shares the exact same shape as a
  // `.remind` event (same refund id, genuinely repeated notification for a still-unresolved
  // state — most concretely, the merchant's own retry_with_customer_details call failing
  // again) but wasn't hour-bucketed like `.remind` events are, so a second notification for
  // the same refund id deduped as "already seen" and its alert never fired.
  it('SECTION 8 AUDIT FIX: a second refund.needs-attention for the SAME refund id, an hour later, is a distinct event (not deduped)', () => {
    const { mod: mod0, restore } = pure()
    const event = { event: 'refund.needs-attention', data: { id: 'rfd_1', status: 'needs-attention', transaction_reference: 'ref-1' } }
    const hour1 = mod0.eventKeyFor(event, 'somehash', Date.parse('2026-06-01T00:00:00.000Z'))
    const hour2 = mod0.eventKeyFor(event, 'somehash', Date.parse('2026-06-01T01:00:00.000Z'))
    expect(hour1).not.toBe(hour2)
  })
  it('SECTION 8 AUDIT FIX: a genuine redelivery of the SAME refund.needs-attention within the same hour still dedupes', () => {
    const { mod: mod0, restore } = pure()
    const event = { event: 'refund.needs-attention', data: { id: 'rfd_1', status: 'needs-attention', transaction_reference: 'ref-1' } }
    const a = mod0.eventKeyFor(event, 'somehash', Date.parse('2026-06-01T00:00:00.000Z'))
    const b = mod0.eventKeyFor(event, 'somehash', Date.parse('2026-06-01T00:05:00.000Z'))
    expect(a).toBe(b)
  })
  it('SECTION 8 AUDIT FIX (end-to-end): a stalled refund that needs attention twice (e.g. a failed retry) is alerted twice', async () => {
    const w = paidWorld()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'))
      t = harness(w)
      const event = { event: 'refund.needs-attention', data: { id: 'rfd_1', status: 'needs-attention', transaction_reference: 'ref-1', amount: '2900', currency: 'USD' } }
      await t.fire(event)
      vi.setSystemTime(new Date('2026-06-01T02:00:00.000Z'))          // the merchant's own retry failed again, two hours later
      await t.fire(event)
      expect(w.t.webhook_events.filter(e => e.event_type === 'refund.needs-attention')).toHaveLength(2)
      expect(t.state.alerts.filter(a => /needs attention/i.test(a.subject))).toHaveLength(2)
      expect(w.t.payments[0].status).toBe('SUCCESS')                  // still untouched — this event only alerts
    } finally {
      vi.useRealTimers()
    }
  })
  it('a redelivery of the SAME refund event is still deduped', async () => {
    const w = paidWorld(); t = harness(w)
    const ev = { event: 'refund.processed', data: { transaction_reference: 'ref-1', refund_reference: 'rf-1', amount: '2900', currency: 'USD' } }
    await t.fire(ev); await t.fire(ev)
    expect(w.t.webhook_events).toHaveLength(1)
    expect(t.state.alerts.filter(a => /sale reversed/i.test(a.subject))).toHaveLength(1)
  })
  it('money alerts carry a per-incident dedupe key (the payment reference)', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire({ event: 'refund.processed', data: { transaction_reference: 'ref-1', refund_reference: 'rf-1', amount: '2900', currency: 'USD' } })
    expect(t.state.alerts.find(a => /sale reversed/i.test(a.subject)).opts).toEqual({ dedupeKey: 'ref-1' })
  })
})

describe('round 2 — dispute.resolve tells the admin which action applies', () => {
  function disputedWorld() {
    const w = seed()
    Object.assign(w.t.payments[0], { status: 'DISPUTED' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    return w
  }
  const resolve = (resolution, id) => ({ event: 'charge.dispute.resolve', data: { id, status: 'resolved', resolution, transaction: { reference: 'ref-1' } } })
  // ROUND 5: the resolution is final when it arrives, so it is actioned (it used to wait for an admin click).
  it('merchant-accepted → the sale is reversed automatically', async () => {
    const w = disputedWorld(); t = harness(w)
    await t.fire(resolve('merchant-accepted', 1))
    const m = t.state.alerts.find(a => /dispute\.resolve/.test(a.subject)).message
    expect(m).toMatch(/reversed automatically/); expect(m).toMatch(/ACCEPTED/)
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(w.t.scans[0].verification_status).toBe('REVOKED')
    expect(w.t.scans[0].verification_revoked_reason).toBe('DISPUTE')
    expect(w.t.webhook_events[0].note).toBe('dispute lost — sale reversed')
  })
  it('declined → DISPUTED goes back to SUCCESS and the credential is left alone', async () => {
    const w = disputedWorld(); t = harness(w)
    await t.fire(resolve('declined', 2))
    const m = t.state.alerts.find(a => /dispute\.resolve/.test(a.subject)).message
    expect(m).toMatch(/WON/); expect(m).toMatch(/back from DISPUTED to SUCCESS/)
    expect(w.t.payments[0].status).toBe('SUCCESS'); expect(w.t.payments[0].disputed_at).toBeNull()
    expect(w.t.scans[0].verification_status).toBe('ACTIVE')
  })
  it('a partial chargeback (refund_amount below the price) is NOT reversed automatically', async () => {
    const w = disputedWorld(); t = harness(w)
    await t.fire({ event: 'charge.dispute.resolve', data: { id: 5, status: 'resolved', resolution: 'merchant-accepted', refund_amount: 1000, transaction: { reference: 'ref-1' } } })
    expect(w.t.payments[0].status).toBe('DISPUTED')
    expect(t.state.alerts.find(a => /dispute\.resolve/.test(a.subject)).message).toMatch(/only 1000 of the 2900/)
  })
  it('a resolution for a payment that is not DISPUTED / SUCCESS changes nothing', async () => {
    const w = disputedWorld(); w.t.payments[0].status = 'REFUNDED'; t = harness(w)
    await t.fire(resolve('declined', 6)); await t.fire(resolve('merchant-accepted', 7))
    expect(w.t.payments[0].status).toBe('REFUNDED')
  })
  it('the buyer is told once when a lost dispute reverses the sale, and the revoked page is mentioned', async () => {
    const w = disputedWorld(); w.t.users[0] = { id: 'u1', deleted_at: null, email: 'a@b.c', name: 'Ann' }
    w.t.payments[0].user_id = 'u1'; t = harness(w)
    await t.fire(resolve('merchant-accepted', 8))
    await t.fire(resolve('merchant-accepted', 9))     // a second resolve event for the same payment: no second notice
    expect(t.state.buyerNotices).toHaveLength(1)
    expect(t.state.buyerNotices[0]).toMatchObject({ to: 'a@b.c', reason: 'DISPUTE', verificationRevoked: true, amountCents: 2900, reference: 'ref-1' })
  })
  it('an unrecognised resolution says so and names both actions', async () => {
    const w = disputedWorld(); t = harness(w)
    await t.fire(resolve('something-new', 3))
    const m = t.state.alerts.find(a => /dispute\.resolve/.test(a.subject)).message
    expect(m).toMatch(/not one this app recognises/); expect(m).toMatch(/Reverse/); expect(m).toMatch(/Clear dispute/)
  })
})

describe('round 2 — receipts do not delay the acknowledgement', () => {
  it('the receipt is handed to waitUntil (deferred), and still exactly one goes out', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess())
    expect(w.t.payments[0]).toMatchObject({ status: 'SUCCESS' })
    expect(w.t.payments[0].receipt_sent_at).toBeTruthy()      // claimed by the winning delivery
  })
})

describe('round 2 — alert throttle is per incident', () => {
  it('a global ceiling still bounds a flood of DIFFERENT unknown references', async () => {
    const w = seed(); t = harness(w)
    for (let i = 0; i < 25; i++) await t.fire(chargeSuccess({ reference: `ghost-${i}` }, 5000 + i))
    const n = t.state.alerts.filter(a => /unknown reference/i.test(a.subject)).length
    expect(n).toBeGreaterThan(1)
    expect(n).toBeLessThan(25)
  })
})

describe('round 3 — inbox notes, reminders, redaction', () => {
  it('a healthy outcome is stored in `note`, NOT `error` (the admin table paints `error` red)', async () => {
    const w = seed(); t = harness(w)
    await t.fire(chargeSuccess())
    expect(w.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED', note: 'FULFILLED', error: null })
  })
  it('a FAILED event keeps the failure text in `error` and no note', async () => {
    const w = seed(); t = harness(w, { queueError: new Error('queue down') })
    await t.fire(chargeSuccess())
    expect(w.t.webhook_events[0]).toMatchObject({ status: 'FAILED', error: 'queue down', note: null })
  })
  it('falls back to the old shape if migration 0036 (the note column) is not applied yet', async () => {
    const w = seed(); t = harness(w)
    w.failNext('webhook_events', 'update', { code: '42703', message: 'column "note" of relation "webhook_events" does not exist' })
    await t.fire(chargeSuccess())
    expect(w.t.webhook_events[0].status).toBe('PROCESSED')       // the status change was not lost
  })
  it('two byte-identical dispute reminders an hour apart are BOTH alerted (they used to dedupe to one)', () => {
    const { mod: mod0, restore } = pure()
    const ev = { event: 'charge.dispute.remind', data: { id: 7 } }
    const h = 'c'.repeat(64)
    expect(mod0.eventKeyFor(ev, h, 1_000_000_000_000)).not.toBe(mod0.eventKeyFor(ev, h, 1_000_000_000_000 + 3_700_000))
    expect(mod0.eventKeyFor(ev, h, 1_000_000_000_000)).toBe(mod0.eventKeyFor(ev, h, 1_000_000_000_000 + 1_000))   // same hour = same delivery
    restore()
  })
  it('redaction drops the payer\'s IP address and receipt number along with card data', () => {
    const { mod: mod0, restore } = pure()
    const out = mod0.redactEvent({ event: 'charge.success', data: { reference: 'r', amount: 1, ip_address: '1.2.3.4', receipt_number: '99', authorization: { x: 1 }, customer: { email: 'a@b.c' }, transaction: { ip_address: '5.6.7.8' } } })
    expect(out.data).toEqual({ reference: 'r', amount: 1, transaction: {} })
    restore()
  })
})


// ── Round 4 (section 8, independent pass) ─────────────────────────────────────
describe('round 4 — B1: the inbox row is not marked PROCESSED before the sale is reversed', () => {
  function paidWorld() {
    const w = seed()
    Object.assign(w.t.payments[0], { status: 'SUCCESS' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    return w
  }
  const full = { event: 'refund.processed', data: { id: 5, transaction_reference: 'ref-1', refund_reference: 'rf-1', amount: '2900', currency: 'USD' } }

  it('a reversePayment failure that ALSO defeats markEvent leaves the row re-runnable, and Paystack\'s redelivery reverses the sale', async () => {
    const w = paidWorld(); t = harness(w)
    w.failNext('payments', 'update', { message: 'db blip' })            // reversePayment's REFUNDED flip throws …
    w.failNext('webhook_events', 'update', { message: 'db blip' })      // … and so does recording FAILED
    expect((await t.fire(full)).status).toBe(500)
    expect(w.t.payments[0].status).toBe('SUCCESS')
    // The bug: the RPC had already flipped this to PROCESSED, so the redelivery below was answered "done".
    expect(w.t.webhook_events[0].status).not.toBe('PROCESSED')
    expect((await t.fire(full)).status).toBe(200)
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(w.t.webhook_events[0].status).toBe('PROCESSED')
  })
  it('the recorded refund amount survives a failed attempt without being counted twice on the retry', async () => {
    const w = paidWorld(); t = harness(w)
    const half = { event: 'refund.processed', data: { id: 6, transaction_reference: 'ref-1', refund_reference: 'rf-a', amount: '1450', currency: 'USD' } }
    w.failNext('payments', 'update', { message: 'db blip' })
    await t.fire(half)                                                  // partial path never updates payments, so this failure is consumed later
    await t.fire(half); await t.fire(half)
    expect(w.t.payment_refunds).toHaveLength(1)
  })
})

describe('round 4 — B3: the refund total does not depend on inbox rows that get pruned', () => {
  it('a second partial refund still completes the total after the first one\'s inbox row is long gone', async () => {
    const w = seed()
    Object.assign(w.t.payments[0], { status: 'SUCCESS' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    w.t.payment_refunds.push({ payment_id: 'pay1', event_key: 'refund.processed:rf-old', amount_cents: 1000 })   // webhook_events is empty (pruned)
    t = harness(w)
    await t.fire({ event: 'refund.processed', data: { id: 8, transaction_reference: 'ref-1', refund_reference: 'rf-new', amount: '1900', currency: 'USD' } })
    expect(w.t.payments[0].status).toBe('REFUNDED')
  })
})

describe('round 4 — B5: two equal partial refunds with no id of any kind', () => {
  function paidWorld() {
    const w = seed()
    Object.assign(w.t.payments[0], { status: 'SUCCESS' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    return w
  }
  // Byte-identical: no data.id, refund_reference null — exactly what Paystack's own sample shows.
  const half = { event: 'refund.processed', data: { transaction_reference: 'ref-1', refund_reference: null, amount: '1450', currency: 'USD' } }

  it('the second equal refund is run again (not swallowed as a duplicate) and the Paystack total reverses the sale', async () => {
    const w = paidWorld(); t = harness(w, { refunds: [{ status: 'processed', amount: 1450, currency: 'USD' }] })
    await t.fire(half)
    expect(w.t.payments[0].status).toBe('SUCCESS')
    t.state.refunds.push({ status: 'processed', amount: 1450, currency: 'USD' })      // the second half completes at Paystack
    await t.fire(half)                                                                // same key, same bytes
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(w.t.payment_refunds).toHaveLength(0)                                       // never added to the local total
  })
  it('a plain duplicate delivery of ONE such refund is not double-counted', async () => {
    const w = paidWorld(); t = harness(w, { refunds: [{ status: 'processed', amount: 1450, currency: 'USD' }] })
    await t.fire(half); await t.fire(half); await t.fire(half)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('with the Paystack lookup down, an ambiguous partial is only ever judged on its own amount (never over-reverses)', async () => {
    const w = paidWorld(); t = harness(w, { refundListError: new Error('Paystack down') })
    await t.fire(half); await t.fire(half)
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.alerts.some(a => /partial/i.test(a.subject))).toBe(true)
  })
  it('a FULL refund by our own books never calls Paystack', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire({ event: 'refund.processed', data: { id: 1, transaction_reference: 'ref-1', refund_reference: 'rf-1', amount: '2900', currency: 'USD' } })
    expect(t.state.refundLookups).toBe(0)
    expect(w.t.payments[0].status).toBe('REFUNDED')
  })
  it('refundIsAmbiguous: true only with neither an id nor a refund_reference', () => {
    const { mod: m, restore } = pure()
    expect(m.refundIsAmbiguous({ data: { amount: '1' } })).toBe(true)
    expect(m.refundIsAmbiguous({ data: { id: 1 } })).toBe(false)
    expect(m.refundIsAmbiguous({ data: { refund_reference: 'r' } })).toBe(false)
    restore()
  })
  it('a non-ambiguous redelivery is still answered "done" without re-running anything', async () => {
    const w = paidWorld(); t = harness(w)
    const ev = { event: 'refund.processed', data: { id: 3, transaction_reference: 'ref-1', refund_reference: 'rf-3', amount: '2900', currency: 'USD' } }
    await t.fire(ev); await t.fire(ev)
    expect(t.state.alerts.filter(a => /sale reversed/i.test(a.subject))).toHaveLength(1)
  })
})

describe('round 4 — B6: the global alert ceiling does not silence the reference it turned away', () => {
  it('a reference denied by the hourly ceiling can alert again once the ceiling has room', async () => {
    const w = seed(); t = harness(w)
    const unknown = n => chargeSuccess({ reference: `nope-${n}`, amount: 100 }, 5000 + n)
    for (let i = 1; i <= 21; i++) await t.fire(unknown(i))
    expect(t.state.alerts.filter(a => /unknown reference/i.test(a.subject))).toHaveLength(20)
    // The 21st was turned away by the ceiling — its own cooldown must not have been taken.
    expect(t.state.kv.has('webhook-alert-cooldown:unknown-reference:nope-21')).toBe(false)
    expect(t.state.kv.has('webhook-alert-cooldown:unknown-reference:nope-20')).toBe(true)
  })
})

// ── Round 5 ────────────────────────────────────────────────────────────────
describe('round 5 — B1: a full refund for a payment that was never settled closes it', () => {
  const full = (id = 31) => ({ event: 'refund.processed', data: { id, transaction_reference: 'ref-1', refund_reference: 'rf-1', amount: 2900, currency: 'USD' } })
  for (const st of ['PENDING', 'ABANDONED', 'FAILED']) {
    it(`${st} → REFUNDED, so a late charge.success can no longer fulfil the refunded sale`, async () => {
      const w = seed(); w.t.payments[0].status = st; t = harness(w)
      expect((await t.fire(full())).status).toBe(200)
      expect(w.t.payments[0]).toMatchObject({ status: 'REFUNDED', refund_reference: 'rf-1' })
      expect(w.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED' })
      expect(w.t.webhook_events[0].note).toMatch(/refunded before settlement/)
      expect(t.state.alerts.some(a => /closed before it was ever settled/.test(a.subject))).toBe(true)
      // …and then the delayed charge.success arrives:
      await t.fire(chargeSuccess())
      expect(w.t.payments[0].status).toBe('REFUNDED')
      expect(t.state.queue).toHaveLength(0)
      expect(t.state.conversions).toHaveLength(0)
      expect(w.t.scans[0].fix_purchased).toBe(false)
    })
  }
  it('a PARTIAL refund on an unsettled payment leaves it alone (and says so)', async () => {
    const w = seed(); t = harness(w, { refunds: [{ status: 'processed', amount: 1000, currency: 'USD' }] })
    await t.fire({ event: 'refund.processed', data: { id: 32, transaction_reference: 'ref-1', refund_reference: 'rf-2', amount: 1000, currency: 'USD' } })
    expect(w.t.payments[0].status).toBe('PENDING')
    expect(t.state.alerts.some(a => /partial/i.test(a.subject))).toBe(true)
  })
  it('a payment that settles between the read and the close is reversed the normal way', async () => {
    const w = seed(); t = harness(w)
    // The row is PENDING when processRefund reads it; by the time the guarded UPDATE runs, it is SUCCESS.
    const realRpc = w.rpcs.record_refund_and_total
    w.rpcs.record_refund_and_total = (args, world) => {
      Object.assign(world.t.payments[0], { status: 'SUCCESS' })
      Object.assign(world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
      return realRpc(args, world)
    }
    await t.fire(full(33))
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(w.t.scans[0].verification_status).toBe('REVOKED')
    expect(t.state.alerts.some(a => /sale reversed/i.test(a.subject))).toBe(true)
  })
  it('a payment that is not a settled-or-unsettled state is still reported, not touched', async () => {
    const w = seed(); w.t.payments[0].status = 'WEIRD'; t = harness(w)
    await t.fire(full(34))
    expect(w.t.payments[0].status).toBe('WEIRD')
    expect(t.state.alerts.some(a => /never SUCCESS/.test(a.subject))).toBe(true)
  })
})

describe('round 5 — B3: re-running an ambiguous refund is not announced as a first failure each time', () => {
  const half = { event: 'refund.processed', data: { transaction_reference: 'ref-1', refund_reference: null, amount: '1450', currency: 'USD' } }
  it('counts the re-run as an attempt and stays quiet when it fails', async () => {
    const w = seed()
    Object.assign(w.t.payments[0], { status: 'SUCCESS' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    t = harness(w, { refunds: [{ status: 'processed', amount: 1450, currency: 'USD' }] })
    await t.fire(half)                                                                  // partial: PROCESSED
    t.state.refunds.push({ status: 'processed', amount: 1450, currency: 'USD' })        // the second half completes at Paystack
    w.failNext('payments', 'update', { message: 'connection reset' })                  // the reversal blips
    const res = await t.fire(half)
    expect(res.status).toBe(500)
    expect(w.t.webhook_events[0]).toMatchObject({ status: 'FAILED', attempts: 2 })
    expect(t.state.alerts.filter(a => /Webhook processing failed/.test(a.subject))).toHaveLength(0)
    expect((await t.fire(half)).status).toBe(200)                                      // and the next delivery finishes the job
    expect(w.t.payments[0].status).toBe('REFUNDED')
  })
})

describe('round 5 — buyer notice on reversal', () => {
  it('a full refund tells the buyer once, saying whether the public page was taken down', async () => {
    const w = seed({ users: [{ id: 'u1', deleted_at: null, email: 'a@b.c', name: 'Ann' }] })
    Object.assign(w.t.payments[0], { status: 'SUCCESS', user_id: 'u1' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    t = harness(w)
    const ev = { event: 'refund.processed', data: { id: 41, transaction_reference: 'ref-1', refund_reference: 'rf-41', amount: 2900, currency: 'USD' } }
    await t.fire(ev); await t.fire(ev)
    expect(t.state.buyerNotices).toEqual([expect.objectContaining({ to: 'a@b.c', reason: 'REFUND', verificationRevoked: true, reference: 'ref-1' })])
  })
  it('a DUPLICATE payment refunded (it does not own the scan) says the page was not touched', async () => {
    const w = seed({ users: [{ id: 'u1', deleted_at: null, email: 'a@b.c', name: 'Ann' }] })
    Object.assign(w.t.payments[0], { status: 'SUCCESS', user_id: 'u1' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'other-payment', status: 'FIX_DELIVERED' })
    t = harness(w)
    await t.fire({ event: 'refund.processed', data: { id: 42, transaction_reference: 'ref-1', refund_reference: 'rf-42', amount: 2900, currency: 'USD' } })
    expect(t.state.buyerNotices[0]).toMatchObject({ verificationRevoked: false })
    expect(w.t.scans[0].verification_status).toBe('ACTIVE')
  })
  it('a buyer-notice failure never fails the reversal', async () => {
    const w = seed({ users: [{ id: 'u1', deleted_at: null, email: 'a@b.c', name: 'Ann' }] })
    Object.assign(w.t.payments[0], { status: 'SUCCESS', user_id: 'u1' })
    Object.assign(w.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    t = harness(w)
    w.failNext('users', 'select', { message: 'blip' })
    const res = await t.fire({ event: 'refund.processed', data: { id: 43, transaction_reference: 'ref-1', refund_reference: 'rf-43', amount: 2900, currency: 'USD' } })
    expect(res.status).toBe(200)
    expect(w.t.payments[0].status).toBe('REFUNDED')
  })
})

describe('round 5 — webhook delivery health', () => {
  const ago = ms => new Date(Date.now() - ms).toISOString()
  const DAY = 24 * 3600_000
  const health = async w => { const { mod, restore } = pure(); try { return await mod.computeWebhookHealth(w.db) } finally { restore() } }
  const pay = (ref, over = {}) => ({ id: 'id-' + ref, paystack_ref: ref, amount_cents: 2900, status: 'SUCCESS', created_at: ago(2 * DAY), ...over })
  const evt = (ref, over = {}) => ({ id: 'e-' + ref, event_type: 'charge.success', reference: ref, status: 'PROCESSED', received_at: ago(2 * DAY), ...over })

  it('counts recent paid sales that have no charge.success on record, ignoring credits, new sales and old ones', async () => {
    const w = createWorld({
      payments: [pay('a'), pay('b'), pay('credit:x', { amount_cents: 0 }), pay('fresh', { created_at: ago(5 * 60_000) }), pay('ancient', { created_at: ago(30 * DAY) }), pay('p', { status: 'PENDING' })],
      webhook_events: [evt('a'), evt('b', { event_type: 'refund.processed' })],
    })
    const h = await health(w)
    expect(h).toMatchObject({ available: true, paidChecked: 2, paidWithoutEvent: 1, missingReferences: ['b'] })
    expect(h.lastChargeSuccessAt).toBeTruthy()
  })
  it('is all clear when every paid sale has its event, and reports nothing seen on an empty inbox', async () => {
    expect(await health(createWorld({ payments: [pay('a')], webhook_events: [evt('a')] }))).toMatchObject({ paidChecked: 1, paidWithoutEvent: 0 })
    expect(await health(createWorld({ payments: [], webhook_events: [] }))).toMatchObject({ available: true, lastEventAt: null, lastChargeSuccessAt: null, paidChecked: 0 })
  })
  it('never throws: a read error just marks it unavailable', async () => {
    const w = createWorld({ payments: [pay('a')], webhook_events: [] })
    w.failNext('webhook_events', 'select', { message: 'down' })
    expect((await health(w)).available).toBe(false)
  })
})

describe('round 5 — fulfillment.refundUnsettledPayment', () => {
  it('only moves unsettled rows: a stale PENDING view of a SUCCESS payment comes back as not transitioned', async () => {
    const w = createWorld({ payments: [{ id: 'pay1', paystack_ref: 'r', status: 'SUCCESS', referral_reservation_id: 'res1' }] })
    const released = []
    const { mod, restore } = loadWithStubs('services/fulfillment.service.js', { 'services/referral.service.js': { releaseCodeReservation: async (db, id) => { released.push(id) } } })
    try {
      const stale = { id: 'pay1', status: 'PENDING' }
      const r = await mod.refundUnsettledPayment(w.db, stale)
      expect(r.transitioned).toBe(false); expect(r.current.status).toBe('SUCCESS'); expect(released).toEqual([])
      w.t.payments[0].status = 'PENDING'
      const r2 = await mod.refundUnsettledPayment(w.db, stale, { refundReference: 'rf' })
      expect(r2.transitioned).toBe(true); expect(released).toEqual(['res1'])
      expect(w.t.payments[0]).toMatchObject({ status: 'REFUNDED', refund_reference: 'rf' })
    } finally { restore() }
  })
})
