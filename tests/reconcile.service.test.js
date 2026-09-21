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
    expect(claim.patch).toEqual({ fix_purchased: true, fix_tier: 'FIX', status: 'FIX_PURCHASED' })
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
