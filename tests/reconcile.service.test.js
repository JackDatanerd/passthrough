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
  // existingLedgerRow: what recordConversion's post-23505 duplicate-lookup
  // SELECT finds. Defaults to "already fully recorded" (usage_counted: true),
  // matching a 23505 ledgerError that isn't paired with an override.
  referralCode = { id: 'rc1', partner_id: 'p1' }, partner = { commission_rate: 0.2 }, ledgerError = null,
  existingLedgerRow = { id: 'led1', usage_counted: true }, existingLedgerError = null,
  reversalRow = null,
} = {}) {
  const state = { queue: [], alerts: [], claims: [], ledger: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'payments') return { data: payments, error: payErr }
    if (q.table === 'scans' && q.op === 'select') return { data: scans, error: null }
    if (q.table === 'scans' && q.op === 'update') { state.claims.push({ patch: q.patch, filters: q.filters }); return { data: claimRows, error: claimError } }
    if (q.table === 'referral_codes') return { data: referralCode, error: null }
    if (q.table === 'partners') return { data: partner, error: null }
    if (q.table === 'commission_ledger' && q.op === 'insert') { state.ledger.push(q.values); return { error: ledgerError } }
    // recordConversion's post-23505 duplicate check: a SELECT for the row
    // that already exists, keyed on payment_id (distinct from the insert above).
    if (q.table === 'commission_ledger' && q.op === 'select') {
      // Round 6: recordConversion also asks whether a duplicate's row was already reversed (reverses_ledger_id = row).
      if (q.filters.some(f => f[0] === 'eq' && f[1] === 'reverses_ledger_id')) return { data: reversalRow, error: null }
      return { data: existingLedgerRow, error: existingLedgerError }
    }
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

  it('Round 7: a lost job belongs to the payment that OWNS the scan, not a newer duplicate', async () => {
    // Rows arrive newest-first: the duplicate (a FIX payment) is seen before the owner (a BADGE payment).
    t = setup({
      payments: [
        pay({ id: 'dup', paystack_ref: 'refDup', fix_tier: 'FIX',   referral_code_id: 'rc1', amount_cents: 2900, created_at: minsAgo(30) }),
        pay({ id: 'own', paystack_ref: 'refOwn', fix_tier: 'BADGE', created_at: minsAgo(90) }),
      ],
      scans: [scan({ fix_purchased: true, fix_tier: 'BADGE', fix_payment_id: 'own', status: 'FIX_PURCHASED', updated_at: minsAgo(30) })],
    })
    const r = await t.sweep()
    expect(r.reenqueued).toHaveLength(1)
    expect(r.reenqueued[0]).toMatchObject({ reference: 'refOwn', kind: 'job-lost' })
    expect(t.state.queue).toEqual([{ type: 'generateBadge', scanId: 's1' }])   // the scan's tier, never the duplicate's
    expect(t.state.ledger).toHaveLength(0)                                       // no commission on the duplicate
  })

  it('Round 7: a lost job re-runs the generator the scan was bought with (scans.fix_tier)', async () => {
    t = setup({
      payments: [pay({ id: 'own', fix_tier: 'FIX' })],
      scans: [scan({ fix_purchased: true, fix_tier: 'BADGE', fix_payment_id: 'own', status: 'FIX_PURCHASED', updated_at: minsAgo(30) })],
    })
    await t.sweep()
    expect(t.state.queue).toEqual([{ type: 'generateBadge', scanId: 's1' }])
  })

  it('Round 7: only a duplicate in the window (owner older than the look-back) is skipped, not re-run', async () => {
    t = setup({
      payments: [pay({ id: 'dup', fix_tier: 'FIX' })],
      scans: [scan({ fix_purchased: true, fix_tier: 'BADGE', fix_payment_id: 'own', status: 'FIX_PURCHASED', updated_at: minsAgo(30) })],
    })
    const r = await t.sweep()
    expect(r.orphans).toBe(0)
    expect(t.state.queue).toHaveLength(0)
  })

  it('is idempotent: re-recovering an already-recorded conversion is a harmless no-op', async () => {
    t = setup({ payments: [pay({ referral_code_id: 'rc1', amount_cents: 2900 })], scans: [scan({ fix_purchased: false })],
      ledgerError: { code: '23505', message: 'duplicate key' },
      existingLedgerRow: { id: 'led1', usage_counted: true } })
    const r = await t.sweep()
    expect(r.reenqueued[0].conversion).toEqual({ ok: true, recorded: false, reason: 'duplicate' })
  })

  it('a duplicate whose usage was never counted is repaired (usage bumped), not skipped', async () => {
    t = setup({ payments: [pay({ referral_code_id: 'rc1', amount_cents: 2900 })], scans: [scan({ fix_purchased: false })],
      ledgerError: { code: '23505', message: 'duplicate key' },
      existingLedgerRow: { id: 'led1', usage_counted: false } })
    const r = await t.sweep()
    expect(r.reenqueued[0].conversion).toEqual({ ok: true, recorded: false, reason: 'duplicate', usageRepaired: true })
  })

  it('a failure DURING the post-duplicate lookup itself is reported, not silently swallowed as a plain duplicate', async () => {
    t = setup({ payments: [pay({ referral_code_id: 'rc1', amount_cents: 2900 })], scans: [scan({ fix_purchased: false })],
      ledgerError: { code: '23505', message: 'duplicate key' },
      existingLedgerError: { message: 'db blip' } })
    const r = await t.sweep()
    expect(r.reenqueued[0].conversion).toMatchObject({ ok: false, reason: 'duplicate-lookup' })
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
  const state = { selects: [], updates: [], rpcs: [], deletes: [] }
  const db = createFakeSupabase(q => {
    if (q.op === 'rpc') { state.rpcs.push({ name: q.name, args: q.args }); return { data: null, error: null } }
    if (q.table === 'referral_code_reservations' && q.op === 'delete') { state.deletes.push(q); return { data: null, error: null } }
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

  // Section 3/4 (usage-limit reservation, migration 0044)
  it('releases the referral-code reservation of every row it actually abandons', async () => {
    t = setupPending({ payments: [pending({ id: 'p1', referral_reservation_id: 'res-1' }), pending({ id: 'p2', paystack_ref: 'ref2' })] })
    await t.sweep()
    expect(t.state.rpcs).toEqual([{ name: 'release_referral_code_slot', args: { p_reservation_id: 'res-1' } }])
  })

  it('does NOT release the reservation of a row a concurrent settle already won (0 rows claimed)', async () => {
    t = setupPending({ payments: [pending({ referral_reservation_id: 'res-1' })], updateResults: { p1: [] } })
    await t.sweep()
    expect(t.state.rpcs).toHaveLength(0)
  })

  it('prunes old reservation rows every run — even when nothing is stale', async () => {
    t = setupPending()
    await t.sweep()
    expect(t.state.deletes).toHaveLength(1)
    const lt = t.state.deletes[0].filters.find(f => f[0] === 'lt' && f[1] === 'created_at')[2]
    expect(Date.parse(lt)).toBe(NOW - 24 * 3600_000)
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
  it('Round 7: the look-back window is wider than the hourly cron interval, so every payment is looked at', () => {
    const { PENDING_MIN_AGE_MS, PENDING_RECENT_MS } = require('../src/services/reconcile.service')
    const cronIntervalMs = 60 * 60 * 1000
    // A row is eligible for (RECENT - MIN_AGE) of its life; hourly runs only see every row if that span
    // is at least one interval (and two or more gives a second chance for a slow mobile-money approval).
    expect(PENDING_RECENT_MS - PENDING_MIN_AGE_MS).toBeGreaterThanOrEqual(2 * cronIntervalMs)
  })

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
    expect(Date.parse(gt)).toBe(NOW - 3 * 60 * 60_000)   // 3-hour recent window (must exceed the hourly cron interval)
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

  it('ROUND 6 (bug): holds (does not fulfil) an amount mismatch AND alerts — the webhook may be the thing that was lost', async () => {
    t = setupRecheck({ payments: [pendingReal()], verify: { data: { status: 'success', amount: 100, currency: 'USD' } } })
    const r = await t.sweep()
    expect(r.held).toEqual([{ reference: 'ref1' }])
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.alerts.length).toBeGreaterThanOrEqual(1)
    expect(t.state.alerts.some(a => /mismatch/i.test(a.subject || a.title || JSON.stringify(a)))).toBe(true)
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

// ── Round 3 (Section 8): refund reconciliation ─────────────────────────────
import { createWorld } from './helpers/memoryDb.cjs'

describe('sweepReversedPayments — Paystack refunded it, but we never heard', () => {
  function rig({ verify, refunds = [], payments } = {}) {
    const world = createWorld({
      payments: payments || [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', created_at: minsAgo(60 * 24), last_reconciled_at: null }],
      scans: [{ id: 's1', user_id: 'u1', fix_payment_id: 'p1', verification_code: 'AB3XY7', verification_status: 'ACTIVE' }],
      commission_ledger: [],
    })
    const state = { alerts: [], verified: [], listed: [] }
    const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
      'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
      'services/paystack.service.js': {
        verifyTransaction: async (e, ref) => { state.verified.push(ref); return typeof verify === 'function' ? verify(ref) : verify },
        listRefunds: async (e, ref) => { state.listed.push(ref); return { data: refunds } },
      },
      'services/referral.service.js': { recordConversion: async () => ({ ok: true }) },
    })
    return { world, state, mod, restore, run: () => mod.sweepReversedPayments({ RATE_LIMIT_KV: null }, world.db, { now: NOW }) }
  }
  let r
  afterEach(() => r?.restore())

  it('reverses the sale when Paystack\'s processed refunds add up to the amount paid', async () => {
    r = rig({ verify: { data: { status: 'reversed' } }, refunds: [{ status: 'processed', amount: 1000, currency: 'USD' }, { status: 'processed', amount: 1900, currency: 'USD' }] })
    const out = await r.run()
    expect(out.reversed).toHaveLength(1)
    expect(r.world.t.payments[0].status).toBe('REFUNDED')
    expect(r.world.t.scans[0].verification_status).toBe('REVOKED')
    expect(r.state.alerts.some(a => /1 sale\(s\) reversed/.test(a.subject))).toBe(true)
  })
  it('a partial (or still-pending) refund is reported, never actioned', async () => {
    r = rig({ verify: { data: { status: 'reversed' } }, refunds: [{ status: 'processed', amount: 1000, currency: 'USD' }, { status: 'pending', amount: 1900, currency: 'USD' }] })
    const out = await r.run()
    expect(out.reversed).toHaveLength(0)
    expect(out.partial).toHaveLength(1)
    expect(r.world.t.payments[0].status).toBe('SUCCESS')
    expect(r.state.alerts.some(a => /partial refund/.test(a.subject))).toBe(true)
  })
  it('does nothing for a transaction Paystack still reports as success (and never asks for its refunds)', async () => {
    r = rig({ verify: { data: { status: 'success' } } })
    const out = await r.run()
    expect(out.checked).toBe(1)
    expect(r.state.listed).toHaveLength(0)
    expect(r.world.t.payments[0].status).toBe('SUCCESS')
  })
  it('stamps last_reconciled_at so the rotation moves on, and skips free-credit rows', async () => {
    r = rig({ verify: { data: { status: 'success' } }, payments: [
      { id: 'p1', paystack_ref: 'ref1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', created_at: minsAgo(500), last_reconciled_at: null },
      { id: 'p2', paystack_ref: 'credit:abc', status: 'SUCCESS', amount_cents: 0, currency: 'USD', created_at: minsAgo(500), last_reconciled_at: null }] })
    await r.run()
    expect(r.state.verified).toEqual(['ref1'])
    expect(r.world.t.payments[0].last_reconciled_at).toBeTruthy()
  })
  it('a Paystack failure on one payment is recorded and does not stop the rest', async () => {
    r = rig({ verify: ref => { if (ref === 'ref1') throw new Error('timeout'); return { data: { status: 'success' } } } })
    r.world.t.payments.push({ id: 'p9', paystack_ref: 'ref9', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', created_at: minsAgo(500), last_reconciled_at: null })
    const out = await r.run()
    expect(out.failed).toEqual([{ reference: 'ref1', error: 'timeout' }])
    expect(out.checked).toBe(2)
    expect(r.state.verified).toEqual(['ref1', 'ref9'])
  })
  it('falls back to a plain look at recent payments if migration 0036 (last_reconciled_at) is not applied', async () => {
    r = rig({ verify: { data: { status: 'success' } } })
    r.world.failNext('payments', 'select', { code: '42703', message: 'column payments.last_reconciled_at does not exist' })
    const out = await r.run()
    expect(out.error).toBeUndefined()
    expect(out.checked).toBe(1)
  })
})


describe('sweepMissingCommissions (Webhooks round 4, B4)', () => {
  const CODE = { id: 'rc1', partner_id: 'p1', code: 'PARTNER' }
  function setupCommissions({ payments, ledger = [], conv } = {}) {
    const state = { alerts: [], conversions: [], kv: new Map(), queries: [] }
    const db = createFakeSupabase(q => {
      state.queries.push(q)
      if (q.table === 'payments' && q.op === 'select') return { data: payments, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: ledger, error: null }
      return undefined
    })
    const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
      'services/referral.service.js': { recordConversion: async (d, p, env) => { state.conversions.push({ id: p.id, env }); return conv ? conv(p) : { ok: true, recorded: true } } },
      'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
    })
    const env = { RATE_LIMIT_KV: { get: async k => state.kv.get(k) ?? null, put: async (k, v) => { state.kv.set(k, v) } } }
    return { run: () => mod.sweepMissingCommissions(env, db, { now: NOW }), state, restore, db }
  }
  const rp = (id, over = {}) => ({ id, paystack_ref: 'ref-' + id, scan_id: 's-' + id, status: 'SUCCESS', amount_cents: 2900, currency: 'USD', referral_code_id: CODE.id, created_at: minsAgo(120), ...over })

  it('re-runs recordConversion for a referred SUCCESS payment with no ledger row, and reports the recovery', async () => {
    t = setupCommissions({ payments: [rp('a'), rp('b')], ledger: [{ payment_id: 'b', usage_counted: true }] })
    const r = await t.run()
    expect(t.state.conversions.map(c => c.id)).toEqual(['a'])
    expect(r.recovered).toEqual([{ reference: 'ref-a', scanId: 's-a' }])
    expect(t.state.alerts[0].subject).toMatch(/1 recovered/)
  })
  it('also repairs a ledger row whose usage counter was never bumped (usage_counted = false)', async () => {
    t = setupCommissions({ payments: [rp('a')], ledger: [{ payment_id: 'a', usage_counted: false }], conv: () => ({ ok: true, recorded: false, usageRepaired: true }) })
    const r = await t.run()
    expect(r.recovered).toHaveLength(1)
  })
  it('leaves fully recorded commissions alone and sends nothing', async () => {
    t = setupCommissions({ payments: [rp('a')], ledger: [{ payment_id: 'a', usage_counted: true }] })
    const r = await t.run()
    expect(t.state.conversions).toHaveLength(0)
    expect(r.missing).toBe(0)
    expect(t.state.alerts).toHaveLength(0)
  })
  it('does NOT pass env to recordConversion (its own alert has no cooldown and would page every hour)', async () => {
    t = setupCommissions({ payments: [rp('a')] })
    await t.run()
    expect(t.state.conversions[0].env).toBeNull()
  })
  it('a persistent failure is reported ONCE, not on every hourly run', async () => {
    t = setupCommissions({ payments: [rp('a')], conv: () => ({ ok: false, reason: 'ledger-insert', error: 'connection reset' }) })
    const a = await t.run(); await t.run()
    expect(a.failed).toHaveLength(1)
    expect(t.state.alerts.filter(x => /still failing/.test(x.subject))).toHaveLength(1)
  })
  it('a deliberately-unrecorded commission (code deleted) is neither recovered nor a failure', async () => {
    t = setupCommissions({ payments: [rp('a')], conv: () => ({ ok: true, recorded: false, reason: 'code-not-found' }) })
    const r = await t.run()
    expect(r.recovered).toHaveLength(0); expect(r.failed).toHaveLength(0)
    expect(t.state.alerts).toHaveLength(0)
  })
  it('is capped per run, and only looks at SUCCESS payments inside the look-back window', async () => {
    t = setupCommissions({ payments: Array.from({ length: 30 }, (_, i) => rp('x' + i)) })
    const r = await t.run()
    expect(r.missing).toBe(20)
    const sel = t.state.queries.find(q => q.table === 'payments')
    expect(sel.filters).toContainEqual(['eq', 'status', 'SUCCESS'])
    expect(sel.filters).toContainEqual(['not', 'referral_code_id', 'is', null])
    expect(sel.filters.filter(f => f[1] === 'created_at').map(f => f[0]).sort()).toEqual(['gt', 'lt'])
  })
  it('a payments query error is returned, not thrown', async () => {
    const db = createFakeSupabase(q => (q.table === 'payments' ? { data: null, error: { message: 'down' } } : undefined))
    const { mod, restore } = loadWithStubs('services/reconcile.service.js', {})
    try { expect((await mod.sweepMissingCommissions({}, db, { now: NOW })).error).toBe('down') } finally { restore() }
  })
})
