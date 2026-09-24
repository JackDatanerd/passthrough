import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  return world
}

function harness(world, opts = {}) {
  const state = { queue: [], alerts: [], conversions: [], kv: new Map(), order: [] }
  const { mod, restore } = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message, opts) => { state.alerts.push({ subject, message, opts }); return true } },
    'services/referral.service.js': { recordConversion: async (db, payment) => { state.order.push('commission'); state.conversions.push(payment.id); return { ok: true } } },
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
  it('dispute.resolve alerts with the resolution and leaves the DISPUTED status for the admin action', async () => {
    const w = paidWorld(); t = harness(w)
    await t.fire(dispute('charge.dispute.create'))
    await t.fire(dispute('charge.dispute.resolve', { status: 'resolved', resolution: 'merchant-accepted' }))
    expect(w.t.payments[0].status).toBe('DISPUTED')
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
  it('merchant-accepted → Reverse', async () => {
    const w = disputedWorld(); t = harness(w)
    await t.fire(resolve('merchant-accepted', 1))
    const m = t.state.alerts.find(a => /dispute\.resolve/.test(a.subject)).message
    expect(m).toMatch(/Reverse/); expect(m).toMatch(/ACCEPTED/)
    expect(w.t.payments[0].status).toBe('DISPUTED')     // still a human's call
  })
  it('declined → Clear dispute', async () => {
    const w = disputedWorld(); t = harness(w)
    await t.fire(resolve('declined', 2))
    const m = t.state.alerts.find(a => /dispute\.resolve/.test(a.subject)).message
    expect(m).toMatch(/Clear dispute/); expect(m).toMatch(/WON/)
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
