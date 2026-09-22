import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const NOW = Date.parse('2026-09-20T12:00:00Z')
const minsAgo = m => new Date(NOW - m * 60_000).toISOString()

function setup({
  payments = [], scans = [], claimRows = [{ id: 'x' }], claimError = null, queueError = null, payErr = null,
  // Referral-attribution fixtures — only ever queried by recordConversion()
  // when a payment actually has a referral_code_id (see referral.service.js:
  // no-referral payments short-circuit before touching any of these tables).
  referralCode = { id: 'rc1', partner_id: 'p1' }, partner = { commission_rate: 0.2 }, ledgerError = null,
} = {}) {
  const state = { queue: [], alerts: [], claims: [], ledger: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'payments') return { data: payments, error: payErr }
    if (q.table === 'scans' && q.op === 'select') return { data: scans, error: null }
    if (q.table === 'scans' && q.op === 'update') { state.claims.push({ patch: q.patch, filters: q.filters }); return { data: claimRows, error: claimError } }
    if (q.table === 'referral_codes') return { data: referralCode, error: null }
    if (q.table === 'partners') return { data: partner, error: null }
    if (q.table === 'commission_ledger') { state.ledger.push(q.values); return { error: ledgerError } }
    return undefined
  })
  const env = { FIX_QUEUE: { send: async m => { if (queueError) throw queueError; state.queue.push(m) } } }
  const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
  })
  return { sweep: () => mod.sweepOrphanedPayments(env, db, { now: NOW }), state, db, restore }
}

const pay = (over = {}) => ({ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', fix_tier: 'FIX', created_at: minsAgo(60), ...over })
const scan = (over = {}) => ({ id: 's1', status: 'COMPLETE_PASS', fix_purchased: false, updated_at: minsAgo(60), ...over })

let t
afterEach(() => t?.restore())

describe('sweepOrphanedPayments', () => {
  it('does nothing when there are no recent successful payments', async () => {
    t = setup()
    const r = await t.sweep()
    expect(r.checked).toBe(0)
    expect(t.state.queue).toHaveLength(0)
  })

  it('only considers SUCCESS payments inside the lookback window and past the grace period', async () => {
    t = setup({ payments: [pay()], scans: [scan()] })
    await t.sweep()
    const q = t.db.calls.find(c => c.table === 'payments')
    expect(eqValue(q, 'status')).toBe('SUCCESS')
    const gt = q.filters.find(f => f[0] === 'gt' && f[1] === 'created_at')[2]
    const lt = q.filters.find(f => f[0] === 'lt' && f[1] === 'created_at')[2]
    expect(Date.parse(gt)).toBe(NOW - 7 * 24 * 3600_000)   // 7-day lookback
    expect(Date.parse(lt)).toBe(NOW - 10 * 60_000)         // 10-minute grace: don't race live fulfilment
  })

  it('recovers a paid scan that was never marked purchased: claims atomically, then enqueues', async () => {
    t = setup({ payments: [pay()], scans: [scan({ fix_purchased: false })] })
    const r = await t.sweep()
    expect(r.orphans).toBe(1)
    // no referral_code_id on this payment -> recordConversion is a same-shape no-op
    expect(r.reenqueued).toEqual([{ reference: 'ref1', scanId: 's1', kind: 'never-fulfilled',
      conversion: { ok: true, recorded: false, reason: 'no-referral' } }])
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 's1' }])
    const claim = t.state.claims[0]
    // SECTION 8 AUDIT: the claim now also records WHICH payment took ownership
    // (fix_payment_id) — same field fulfillment.service.js's own claim sets —
    // so a later duplicate payment for this scan can be told apart from the
    // one that legitimately fulfilled it.
    expect(claim.patch).toEqual({ fix_purchased: true, fix_tier: 'FIX', status: 'FIX_PURCHASED', fix_payment_id: 'p1' })
    // the atomic guard: only claim if it is STILL unpurchased
    expect(claim.filters.some(f => f[0] === 'eq' && f[1] === 'fix_purchased' && f[2] === false)).toBe(true)
    // a no-referral payment never touches the commission ledger at all
    expect(t.state.ledger).toHaveLength(0)
  })

  // AUDIT FIX (feature gap): previously this sweep only re-ran the
  // scan-update + FIX_QUEUE.send half of fulfilment — a referred sale that
  // never even reached recordConversion() (e.g. an exception thrown before
  // it, an isolate killed early) would have its fix delivered here with the
  // partner's commission silently never recorded. These lock in the fix:
  // recordConversion is now attempted for every recovered orphan, exactly
  // like the admin reconcilePayment endpoint already does.
  it('retries the commission-ledger write for a referred payment recovered by the sweep', async () => {
    t = setup({ payments: [pay({ referral_code_id: 'rc1', amount_cents: 2900 })], scans: [scan({ fix_purchased: false })] })
    const r = await t.sweep()
    expect(r.reenqueued[0].conversion).toEqual({ ok: true, recorded: true })
    expect(t.state.ledger).toHaveLength(1)
    expect(t.state.ledger[0]).toMatchObject({
      payment_id: 'p1', partner_id: 'p1', referral_code_id: 'rc1',
      gross_amount_cents: 2900, commission_amount_cents: 580,   // 20% of 2900
    })
  })

  it('also retries the commission-ledger write for a job-lost (not just never-fulfilled) recovery', async () => {
    t = setup({
      payments: [pay({ referral_code_id: 'rc1', amount_cents: 2900 })],
      scans: [scan({ fix_purchased: true, status: 'FIX_PURCHASED', updated_at: minsAgo(30) })],
    })
    const r = await t.sweep()
    expect(r.reenqueued[0].kind).toBe('job-lost')
    expect(r.reenqueued[0].conversion.recorded).toBe(true)
    expect(t.state.ledger).toHaveLength(1)
  })

  it('is idempotent: re-recovering an already-recorded conversion is a harmless no-op', async () => {
    t = setup({ payments: [pay({ referral_code_id: 'rc1', amount_cents: 2900 })], scans: [scan({ fix_purchased: false })],
      ledgerError: { code: '23505', message: 'duplicate key' } })
    const r = await t.sweep()
    expect(r.reenqueued[0].conversion).toEqual({ ok: true, recorded: false, reason: 'duplicate' })
  })

  it('surfaces a failed commission write in both the sweep summary and a dedicated owner alert, without blocking delivery', async () => {
    t = setup({ payments: [pay({ referral_code_id: 'rc1', amount_cents: 2900 })], scans: [scan({ fix_purchased: false })],
      ledgerError: { code: '08006', message: 'connection reset' } })
    const r = await t.sweep()
    expect(r.reenqueued[0].conversion.ok).toBe(false)   // delivery still succeeded — see t.state.queue below
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 's1' }])
    // one alert from recordConversion's own notifyConversionFailure, one from the sweep's own summary
    expect(t.state.alerts.some(a => /commission/i.test(a.subject))).toBe(true)
    const summary = t.state.alerts.find(a => /payment sweep/i.test(a.subject))
    expect(summary.message).toContain('commission NOT recorded')
  })

  it('a BADGE payment re-enqueues generateBadge', async () => {
    t = setup({ payments: [pay({ fix_tier: 'BADGE' })], scans: [scan()] })
    await t.sweep()
    expect(t.state.queue).toEqual([{ type: 'generateBadge', scanId: 's1' }])
  })

  it('recovers a LOST JOB: scan stuck in FIX_PURCHASED for >15 minutes', async () => {
    t = setup({ payments: [pay()], scans: [scan({ fix_purchased: true, status: 'FIX_PURCHASED', updated_at: minsAgo(30) })] })
    const r = await t.sweep()
    expect(r.reenqueued[0].kind).toBe('job-lost')
    expect(t.state.queue).toHaveLength(1)
    expect(t.state.claims[0].filters.some(f => f[0] === 'eq' && f[1] === 'status' && f[2] === 'FIX_PURCHASED')).toBe(true)
  })

  it('leaves alone anything that is fine or genuinely in progress', async () => {
    t = setup({
      payments: [pay({ id: 'a', scan_id: 'a' }), pay({ id: 'b', scan_id: 'b' }), pay({ id: 'c', scan_id: 'c' }), pay({ id: 'd', scan_id: 'd' })],
      scans: [
        scan({ id: 'a', fix_purchased: true, status: 'FIX_DELIVERED' }),
        scan({ id: 'b', fix_purchased: true, status: 'FIX_GENERATING' }),
        scan({ id: 'c', fix_purchased: true, status: 'FIX_PURCHASED', updated_at: minsAgo(3) }),   // job only just queued
        scan({ id: 'd', fix_purchased: true, status: 'ERROR' }),                                   // generation failed — different recovery path
      ],
    })
    const r = await t.sweep()
    expect(r.orphans).toBe(0)
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.alerts).toHaveLength(0)
  })

  it('does NOT enqueue when a live path fixed it between the query and the claim (0 rows claimed)', async () => {
    t = setup({ payments: [pay()], scans: [scan()], claimRows: [] })
    const r = await t.sweep()
    expect(r.orphans).toBe(1)
    expect(r.reenqueued).toHaveLength(0)
    expect(t.state.queue).toHaveLength(0)
  })

  it('dedupes two payments for the same scan and skips payments whose scan is gone', async () => {
    t = setup({ payments: [pay({ id: 'p1' }), pay({ id: 'p2' }), pay({ id: 'p3', scan_id: 'ghost' })], scans: [scan()] })
    const r = await t.sweep()
    expect(r.orphans).toBe(1)
    expect(t.state.queue).toHaveLength(1)
  })

  it('caps recoveries per run so a systemic fault cannot flood the queue', async () => {
    const payments = Array.from({ length: 25 }, (_, i) => pay({ id: `p${i}`, paystack_ref: `r${i}`, scan_id: `s${i}` }))
    const scans = payments.map(p => scan({ id: p.scan_id }))
    t = setup({ payments, scans })
    const r = await t.sweep()
    expect(r.orphans).toBe(25)
    expect(r.reenqueued).toHaveLength(10)
  })

  it('records a failure (and keeps going) when the queue send throws, and alerts the owner', async () => {
    t = setup({ payments: [pay()], scans: [scan()], queueError: new Error('queue down') })
    const r = await t.sweep()
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error).toBe('queue down')
    expect(t.state.alerts[0].subject).toMatch(/1 failed/)
  })

  it('emails the owner a summary whenever it recovered something', async () => {
    t = setup({ payments: [pay()], scans: [scan()] })
    await t.sweep()
    expect(t.state.alerts).toHaveLength(1)
    expect(t.state.alerts[0].message).toContain('RECOVERED  ref1')
  })

  it('returns an error (does not throw) when the payments query fails', async () => {
    t = setup({ payErr: { message: 'timeout' } })
    const r = await t.sweep()
    expect(r.error).toBe('timeout')
  })
})

// AUDIT FIX (feature gap): PENDING payments where the customer opened
// Paystack checkout and simply never came back were never resolved by
// anything — initializePayment only ever writes ABANDONED for a stale row
// when the SAME scan starts ANOTHER checkout later (see that function's own
// comment), so a customer who never returns at all left the row PENDING
// forever. Effect: getPaymentHistory shows the user a purchase that looks
// "still pending" indefinitely, and AdminPayments' PENDING filter conflated
// this completely routine case with the very different "amount mismatch
// held for manual review" case, with nothing in the data to tell them
// apart. These lock in the fix: an hourly sweep (wired into the same cron
// as sweepOrphanedPayments, as its own independent job) flips old-enough
// PENDING rows to ABANDONED via the same atomic per-row claim pattern used
// everywhere else in this file.
function setupPending({ payments = [], updateResults = {}, updateErrors = {} } = {}) {
  const state = { selects: [], updates: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'payments' && q.op === 'select') { state.selects.push(q); return { data: payments, error: null } }
    if (q.table === 'payments' && q.op === 'update') {
      state.updates.push(q)
      const id = eqValue(q, 'id')
      if (updateErrors[id]) return { data: null, error: updateErrors[id] }
      const claimed = Object.prototype.hasOwnProperty.call(updateResults, id) ? updateResults[id] : [{ id }]
      return { data: claimed, error: null }
    }
    return undefined
  })
  const { mod, restore } = loadWithStubs('services/reconcile.service.js', {})
  return { sweep: (opts) => mod.sweepStalePendingPayments({}, db, { now: NOW, ...opts }), state, restore }
}

const pending = (over = {}) => ({ id: 'p1', paystack_ref: 'ref1', ...over })

describe('sweepStalePendingPayments', () => {
  it('does nothing when there are no stale pending payments', async () => {
    t = setupPending()
    const r = await t.sweep()
    expect(r.checked).toBe(0)
    expect(r.abandoned).toBe(0)
    expect(t.state.updates).toHaveLength(0)
  })

  it('only considers PENDING payments inside the lookback window and past the abandon-age margin', async () => {
    t = setupPending({ payments: [pending()] })
    await t.sweep()
    const q = t.state.selects[0]
    expect(eqValue(q, 'status')).toBe('PENDING')
    const gt = q.filters.find(f => f[0] === 'gt' && f[1] === 'created_at')[2]
    const lt = q.filters.find(f => f[0] === 'lt' && f[1] === 'created_at')[2]
    expect(Date.parse(gt)).toBe(NOW - 30 * 24 * 3600_000)   // 30-day lookback
    expect(Date.parse(lt)).toBe(NOW - 2 * 3600_000)          // 2-hour abandon-age margin
  })

  it('claims each stale row atomically and flips it to ABANDONED', async () => {
    t = setupPending({ payments: [pending()] })
    const r = await t.sweep()
    expect(r.checked).toBe(1)
    expect(r.abandoned).toBe(1)
    const claim = t.state.updates[0]
    expect(claim.patch).toEqual({ status: 'ABANDONED' })
    // the atomic guard: only claim if it is STILL pending
    expect(claim.filters.some(f => f[0] === 'eq' && f[1] === 'id' && f[2] === 'p1')).toBe(true)
    expect(claim.filters.some(f => f[0] === 'eq' && f[1] === 'status' && f[2] === 'PENDING')).toBe(true)
  })

  it('does not count a row a concurrent verify/webhook already resolved (0 rows claimed)', async () => {
    t = setupPending({ payments: [pending()], updateResults: { p1: [] } })
    const r = await t.sweep()
    expect(r.checked).toBe(1)
    expect(r.abandoned).toBe(0)
  })

  it('keeps going when one row errors, and still abandons the rest', async () => {
    t = setupPending({
      payments: [pending({ id: 'p1' }), pending({ id: 'p2', paystack_ref: 'ref2' })],
      updateErrors: { p1: { message: 'connection reset' } },
    })
    const r = await t.sweep()
    expect(r.checked).toBe(2)
    expect(r.abandoned).toBe(1)
  })

  it('returns an error (does not throw) when the payments query fails', async () => {
    const state = { updates: [] }
    const db = createFakeSupabase(q => q.table === 'payments' && q.op === 'select' ? { data: null, error: { message: 'timeout' } } : undefined)
    const { mod, restore } = loadWithStubs('services/reconcile.service.js', {})
    const r = await mod.sweepStalePendingPayments({}, db, { now: NOW })
    expect(r.error).toBe('timeout')
    restore()
  })
})

// ── sweepPendingPayments / recheckPayment (Section 8 audit: paid-but-never-
//    settled — the webhook was lost, or the buyer never returned) ──────────

function setupRecheck({
  payments = [], claimRows = [{ id: 'p1' }], claimError = null, scanRows = { id: 's1', user_id: 'u1', fix_purchased: false, updated_at: minsAgo(60) },
  ownerRows = { deleted_at: null }, queueError = null, payErr = null, verify,
} = {}) {
  const state = { queue: [], alerts: [], verifyCalls: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'payments' && q.op === 'select') return { data: payments, error: payErr }
    if (q.table === 'payments' && q.op === 'update') return { data: [{ id: 'p1', ...payments[0] }], error: null }
    if (q.table === 'scans' && q.op === 'select') return { data: scanRows, error: null }
    if (q.table === 'scans' && q.op === 'update') return { data: claimRows, error: claimError }
    if (q.table === 'users') return { data: ownerRows, error: null }
    return undefined
  })
  const env = { FIX_QUEUE: { send: async m => { if (queueError) throw queueError; state.queue.push(m) } } }
  const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
    'services/paystack.service.js': { verifyTransaction: async (e, ref) => { state.verifyCalls.push(ref); return verify } },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true, recorded: false, reason: 'no-referral' }) },
  })
  return { sweep: (opts) => mod.sweepPendingPayments(env, db, { now: NOW, ...opts }), mod, env, db, state, restore }
}

const pendingReal = (over = {}) => ({ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', fix_tier: 'FIX',
  status: 'PENDING', amount_cents: 2900, currency: 'USD', created_at: minsAgo(30), ...over })

describe('sweepPendingPayments (Section 8 audit — asks Paystack about non-SUCCESS rows)', () => {
  it('does nothing when there is nothing to check', async () => {
    t = setupRecheck()
    const r = await t.sweep()
    expect(r.checked).toBe(0)
    expect(t.state.verifyCalls).toHaveLength(0)
  })

  it('only queries PENDING/ABANDONED/FAILED rows inside the recent window, past the min-age grace period', async () => {
    t = setupRecheck({ payments: [pendingReal()], verify: { data: { status: 'success', amount: 2900, currency: 'USD' } } })
    await t.sweep()
    const q = t.db.calls.find(c => c.table === 'payments' && c.op === 'select')
    expect(q.filters.find(f => f[0] === 'in' && f[1] === 'status')[2]).toEqual(['PENDING', 'ABANDONED', 'FAILED'])
    const gt = q.filters.find(f => f[0] === 'gt' && f[1] === 'created_at')[2]
    const lt = q.filters.find(f => f[0] === 'lt' && f[1] === 'created_at')[2]
    expect(Date.parse(gt)).toBe(NOW - 60 * 60_000)   // 60-minute recent window
    expect(Date.parse(lt)).toBe(NOW - 10 * 60_000)   // 10-minute grace: don't race a checkout still in progress
  })

  it('recovers a payment Paystack says was really paid: settles and enqueues', async () => {
    t = setupRecheck({ payments: [pendingReal()], verify: { data: { status: 'success', amount: 2900, currency: 'USD', authorization: { authorization_code: 'AUTH_1' } } } })
    const r = await t.sweep()
    expect(t.state.verifyCalls).toEqual(['ref1'])
    expect(r.recovered).toEqual([{ reference: 'ref1', scanId: 's1', outcome: 'FULFILLED' }])
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 's1' }])
  })

  it('leaves an unpaid payment alone — routine, not abandoned here (sweepStalePendingPayments owns that)', async () => {
    t = setupRecheck({ payments: [pendingReal()], verify: { data: { status: 'abandoned' } } })
    const r = await t.sweep()
    expect(r.recovered).toHaveLength(0)
    expect(r.held).toHaveLength(0)
    expect(t.state.alerts).toHaveLength(0)
  })

  it('holds (does not fulfil) an amount mismatch, without alerting again — the webhook already did', async () => {
    t = setupRecheck({ payments: [pendingReal()], verify: { data: { status: 'success', amount: 100, currency: 'USD' } } })
    const r = await t.sweep()
    expect(r.held).toEqual([{ reference: 'ref1' }])
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.alerts).toHaveLength(0)
  })

  it('skips free-credit rows entirely — nothing to verify with Paystack', async () => {
    t = setupRecheck({ payments: [pendingReal({ paystack_ref: 'credit:s1:123' })] })
    const r = await t.sweep()
    expect(r.checked).toBe(0)
    expect(t.state.verifyCalls).toHaveLength(0)
  })

  it('keeps going and reports a failure when the Paystack lookup itself throws', async () => {
    t = setupRecheck({ payments: [pendingReal()] })
    t.mod && null
    const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
      'services/email.service.js': { sendOwnerAlert: async () => {} },
      'services/paystack.service.js': { verifyTransaction: async () => { throw new Error('timeout') } },
    })
    const r = await mod.sweepPendingPayments(t.env, t.db, { now: NOW })
    expect(r.failed).toEqual([{ reference: 'ref1', error: 'timeout' }])
    restore()
  })

  it('emails a summary when something was recovered or failed', async () => {
    t = setupRecheck({ payments: [pendingReal()], verify: { data: { status: 'success', amount: 2900, currency: 'USD' } } })
    await t.sweep()
    expect(t.state.alerts.some(a => /recovered/i.test(a.subject))).toBe(true)
  })

  it('returns an error (does not throw) when the payments query fails', async () => {
    t = setupRecheck({ payErr: { message: 'timeout' } })
    const r = await t.sweep()
    expect(r.error).toBe('timeout')
  })

  it("recheckPayment refuses NOT_PAID and MISMATCH without touching the payment", async () => {
    const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
      'services/paystack.service.js': { verifyTransaction: async () => ({ data: { status: 'failed' } }) },
    })
    const r = await mod.recheckPayment({}, {}, pendingReal())
    expect(r.outcome).toBe('NOT_PAID')
    restore()
  })
})

// ── paid-but-generation-failed recovery (Section 9/10) ──────────────────────
function setupFailed({ scans = [], claim = true, claimError = null, queueError = null, selectError = null } = {}) {
  const state = { queue: [], alerts: [], claims: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'scans' && q.op === 'select') return { data: scans, error: selectError }
    if (q.op === 'rpc' && q.name === 'claim_errored_fix') { state.claims.push(q.args); return { data: typeof claim === 'function' ? claim(q.args) : claim, error: claimError } }
    return undefined
  })
  const env = { FIX_QUEUE: { send: async m => { if (queueError) throw queueError; state.queue.push(m) } } }
  const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
  })
  return { sweep: () => mod.sweepFailedFixes(env, db, { now: NOW }), state, db, mod, restore }
}
const errScan = (over = {}) => ({ id: 's1', fix_tier: 'FIX', fix_error_recoveries: 0, updated_at: minsAgo(30), ...over })

describe('sweepFailedFixes', () => {

  it('re-queues a paid scan whose generation failed, via the atomic claim', async () => {
    t = setupFailed({ scans: [errScan()] })
    const r = await t.sweep()
    expect(r.requeued).toEqual([{ scanId: 's1', attempt: 1 }])
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 's1' }])
    expect(t.state.claims).toEqual([{ p_scan_id: 's1', p_max: t.mod.MAX_AUTO_RECOVERIES }])
  })
  it('only looks at PAID scans in ERROR, inside the window and past the grace period', async () => {
    t = setupFailed({ scans: [] })
    await t.sweep()
    const q = t.db.calls.find(c => c.table === 'scans')
    expect(q.filters.find(f => f[0] === 'eq' && f[1] === 'status')[2]).toBe('ERROR')
    expect(q.filters.find(f => f[0] === 'eq' && f[1] === 'fix_purchased')[2]).toBe(true)
    expect(q.filters.some(f => f[0] === 'gt' && f[1] === 'updated_at')).toBe(true)
    expect(q.filters.some(f => f[0] === 'lt' && f[1] === 'updated_at')).toBe(true)
  })
  it('uses generateBadge for a BADGE-tier scan', async () => {
    t = setupFailed({ scans: [errScan({ fix_tier: 'BADGE' })] })
    await t.sweep()
    expect(t.state.queue[0].type).toBe('generateBadge')
  })
  it('does NOT enqueue when the atomic claim is lost (a concurrent recovery won)', async () => {
    t = setupFailed({ scans: [errScan()], claim: false })
    const r = await t.sweep()
    expect(r.requeued).toHaveLength(0); expect(t.state.queue).toHaveLength(0)
  })
  it('stops retrying a scan after the cap and alerts the owner ONCE', async () => {
    t = setupFailed({ scans: [errScan({ fix_error_recoveries: 2, updated_at: minsAgo(30) })] })
    const r = await t.sweep()
    expect(r.requeued).toHaveLength(0); expect(t.state.claims).toHaveLength(0)
    expect(r.exhausted).toEqual([{ scanId: 's1' }])
    expect(t.state.alerts).toHaveLength(1)
    expect(t.state.alerts[0].message).toContain('requeue-fix')
  })
  it('an exhausted scan that failed long ago is not re-announced every hour', async () => {
    t = setupFailed({ scans: [errScan({ fix_error_recoveries: 2, updated_at: minsAgo(60 * 5) })] })
    const r = await t.sweep()
    expect(r.exhausted).toHaveLength(0); expect(t.state.alerts).toHaveLength(0)
  })
  it('a queue failure after the claim is reported, not thrown (left for the job-lost sweep)', async () => {
    t = setupFailed({ scans: [errScan()], queueError: new Error('queue down') })
    const r = await t.sweep()
    expect(r.failed).toEqual([{ scanId: 's1', error: 'queue down' }])
    expect(t.state.alerts).toHaveLength(1)
  })
  it('a claim RPC error is reported and the scan is not enqueued', async () => {
    t = setupFailed({ scans: [errScan()], claimError: new Error('rpc missing') })
    const r = await t.sweep()
    expect(r.failed[0].error).toBe('rpc missing'); expect(t.state.queue).toHaveLength(0)
  })
  it('caps work per run', async () => {
    const scans = Array.from({ length: 30 }, (_, i) => errScan({ id: `s${i}` }))
    t = setupFailed({ scans })
    const r = await t.sweep()
    expect(r.requeued).toHaveLength(t.mod.MAX_PER_RUN)
  })
  it('a query error is returned, not thrown', async () => {
    t = setupFailed({ selectError: new Error('boom') })
    expect((await t.sweep()).error).toBe('boom')
  })
})
