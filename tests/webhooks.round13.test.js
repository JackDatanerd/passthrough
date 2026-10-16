import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

// Webhooks section, independent audit round 13.
//   B1  sweepReversedPayments selected no user_id, so reversePayment's buyer notice (which needs it) was silently skipped.
//   B2  sweepMissingCommissions passed env=null, so a partner never heard about a commission the sweep recovered.
//   B3  the commission / orphan sweeps selected narrow rows: referral_source, currency (and user_id) never reached recordConversion.
//   G1  the dispute auto-accept deadline is stored on the payment and surfaced.
//   G2  the in-memory database double returns only the columns a select names, like PostgREST (this is what hid B1–B3).
const NOW = Date.parse('2026-09-20T12:00:00Z')
const minsAgo = m => new Date(NOW - m * 60_000).toISOString()

let restore
afterEach(() => { restore?.(); restore = null })

const emails = () => ({ reversed: [], partner: [], alerts: [], receipts: [] })
function emailStub(sink) {
  return {
    sendOwnerAlert: async (e, subject, message) => { sink.alerts.push({ subject, message }); return true },
    sendPaymentReversed: async (e, db, to, name, p) => { sink.reversed.push({ to, ...p }); return true },
    sendPartnerConversionEarned: async (e, db, to, name, code, cents, currency) => { sink.partner.push({ to, code, cents, currency }); return true },
    sendPartnerCommissionReversed: async () => true,
    sendPartnerCodeLimitReached: async () => true,
  }
}

describe('G2: the in-memory database double projects columns', () => {
  const world = () => createWorld({ things: [{ id: 1, a: 'A', b: 'B', payload: { event: 'x', data: { id: 7 } }, rel: { n: 1 } }] })
  it('returns only the selected columns', async () => {
    const { data } = await world().db.from('things').select('id, a').eq('id', 1)
    expect(data).toEqual([{ id: 1, a: 'A' }])
  })
  it('keeps * whole, supports aliases and json paths, and keeps embedded relations', async () => {
    const w = world()
    expect((await w.db.from('things').select('*').eq('id', 1)).data[0].b).toBe('B')
    expect((await w.db.from('things').select('has_event:payload->>event, payload->data->>id').eq('id', 1)).data[0]).toEqual({ has_event: 'x', id: 7 })
    expect((await w.db.from('things').select('id, rel(n)').eq('id', 1)).data[0]).toEqual({ id: 1, rel: { n: 1 } })
  })
  it('applies to .select() after update and insert, and a test can opt out', async () => {
    const w = world()
    expect((await w.db.from('things').update({ a: 'Z' }).eq('id', 1).select('id')).data).toEqual([{ id: 1 }])
    w.projectColumns = false
    expect((await w.db.from('things').select('id').eq('id', 1)).data[0].a).toBe('Z')
  })
  it('a column that was not selected is undefined, which is the bug class it exists to expose', async () => {
    const { data } = await world().db.from('things').select('id').maybeSingle()
    expect(data.a).toBeUndefined()
  })
})

describe('B1: a sale the reversal sweep reverses still tells the buyer', () => {
  function rig({ status = 'SUCCESS', refunds = [{ status: 'processed', amount: 2900, currency: 'USD' }] } = {}) {
    const world = createWorld({
      users: [{ id: 'u1', email: 'buyer@x.co', name: 'Bea' }],
      payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', user_id: 'u1', fix_tier: 'FIX', status, amount_cents: 2900, currency: 'USD', created_at: minsAgo(60 * 24), last_reconciled_at: null }],
      scans: [{ id: 's1', user_id: 'u1', fix_payment_id: 'p1', verification_code: 'AB3XY7', verification_status: 'ACTIVE' }],
      commission_ledger: [],
    })
    const sink = emails()
    const l = loadWithStubs('services/reconcile.service.js', {
      'services/email.service.js': emailStub(sink),
      'services/paystack.service.js': { verifyTransaction: async () => ({ data: { status: 'reversed', id: 55 } }), listRefunds: async () => ({ data: refunds }) },
    })
    restore = l.restore
    return { world, sink, run: () => l.mod.sweepReversedPayments({ RATE_LIMIT_KV: null }, world.db, { now: NOW }) }
  }
  it('a missed refund.processed: payment REFUNDED and the buyer is emailed', async () => {
    const r = rig()
    const out = await r.run()
    expect(out.reversed).toHaveLength(1)
    expect(r.world.t.payments[0].status).toBe('REFUNDED')
    expect(r.sink.reversed).toHaveLength(1)
    expect(r.sink.reversed[0]).toMatchObject({ to: 'buyer@x.co', amountCents: 2900, reference: 'ref1', reason: 'REFUND' })
  })
  it('a lost dispute whose resolve webhook never arrived: the buyer is emailed too', async () => {
    const r = rig({ status: 'DISPUTED', refunds: [] })
    const out = await r.run()
    expect(out.reversed[0].chargeback).toBe(true)
    expect(r.sink.reversed).toHaveLength(1)
    expect(r.sink.reversed[0].reason).toBe('DISPUTE')
  })
})

describe('B2 + B3: the commission sweep recovers attribution and tells the partner', () => {
  function rig({ payment, partnerOver = {} } = {}) {
    const world = createWorld({
      users: [{ id: 'u1', email: 'buyer@x.co', name: 'Bea' }],
      payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', user_id: 'u1', status: 'SUCCESS', amount_cents: 5000, currency: 'KES', fix_tier: 'FIX', referral_code_id: 'rc1', referral_source: 'typed', referral_reservation_id: null, created_at: minsAgo(120), ...payment }],
      scans: [{ id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false, fix_payment_id: null, updated_at: minsAgo(120), fix_tier: 'FIX' }],
      referral_codes: [{ id: 'rc1', partner_id: 'pa1', code: 'COACH', usage_limit: null, uses_so_far: 0 }],
      partners: [{ id: 'pa1', name: 'Pat', email: 'pat@x.co', commission_rate: 0.2, dashboard_token: 'tok', notify_conversions: true, ...partnerOver }],
      commission_ledger: [],
    })
    world.rpcs.increment_referral_code_usage = ({ p_ledger_id }) => { const l = world.t.commission_ledger.find(x => x.id === p_ledger_id); if (l) l.usage_counted = true; return { data: null, error: null } }
    const sink = emails()
    const kv = new Map()
    const env = { FRONTEND_URL: 'https://app.test', FIX_QUEUE: { send: async () => {} }, RATE_LIMIT_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v) } } }
    const l = loadWithStubs('services/reconcile.service.js', { 'services/email.service.js': emailStub(sink) })
    restore = () => { l.restore(); delete require_.cache[require_.resolve('../src/services/referral.service.js')] }
    return { world, sink, env, mod: l.mod }
  }

  it('records the attribution source and the payment currency the narrow select used to drop', async () => {
    const r = rig()
    const out = await r.mod.sweepMissingCommissions(r.env, r.world.db, { now: NOW })
    expect(out.recovered).toHaveLength(1)
    const row = r.world.t.commission_ledger[0]
    expect(row.attribution_source).toBe('typed')
    expect(row.currency).toBe('KES')
    expect(row.commission_amount_cents).toBe(1000)
  })
  it('round 16: the partner\'s channel tag (referral_sub) reaches the ledger row too, and a database without 0093 is still swept', async () => {
    const r = rig({ payment: { referral_sub: 'newsletter' } })
    await r.mod.sweepMissingCommissions(r.env, r.world.db, { now: NOW })
    expect(r.world.t.commission_ledger[0].attribution_sub).toBe('newsletter')
    const r2 = rig()
    r2.world.failNext('payments', 'select', { code: '42703', message: 'column payments.referral_sub does not exist' })
    const out = await r2.mod.sweepMissingCommissions(r2.env, r2.world.db, { now: NOW })
    expect(out.error).toBeNull()
    expect(out.recovered).toHaveLength(1)
    expect(r2.world.t.commission_ledger[0].attribution_source).toBe('typed')   // the retry still carried the source
  })
  it('emails the PARTNER about the recovered sale, and nobody is paged for it', async () => {
    const r = rig()
    await r.mod.sweepMissingCommissions(r.env, r.world.db, { now: NOW })
    expect(r.sink.partner).toEqual([{ to: 'pat@x.co', code: 'COACH', cents: 1000, currency: 'KES' }])
    expect(r.sink.alerts.filter(a => /NOT fully recorded/.test(a.subject))).toHaveLength(0)
  })
  it('a persistent failure still does not page the owner every hour (quietFailures) — the sweep reports it once', async () => {
    const r = rig({ partnerOver: { commission_rate: null } })
    await r.mod.sweepMissingCommissions(r.env, r.world.db, { now: NOW })
    await r.mod.sweepMissingCommissions(r.env, r.world.db, { now: NOW })
    expect(r.sink.alerts.filter(a => /NOT fully recorded/.test(a.subject))).toHaveLength(0)
    expect(r.sink.alerts.filter(a => /still failing/.test(a.subject))).toHaveLength(1)
  })
  it('a database without migration 0079 (no referral_source column) is still swept', async () => {
    const r = rig()
    r.world.failNext('payments', 'select', { code: '42703', message: 'column payments.referral_source does not exist' })
    const out = await r.mod.sweepMissingCommissions(r.env, r.world.db, { now: NOW })
    expect(out.error).toBeNull()
    expect(out.recovered).toHaveLength(1)
  })
  it('the orphan sweep passes the same fields to recordConversion (attribution, currency, buyer)', async () => {
    const r = rig()
    const out = await r.mod.sweepOrphanedPayments(r.env, r.world.db, { now: NOW })
    expect(out.reenqueued).toHaveLength(1)
    const row = r.world.t.commission_ledger[0]
    expect(row.attribution_source).toBe('typed')
    expect(row.currency).toBe('KES')
    expect(r.sink.partner).toHaveLength(1)
  })
})

describe('referenceCandidates accepts a bare-string `transaction`', () => {
  it('finds the reference whichever field carries it', () => {
    const { mod, restore: rs } = loadWithStubs('services/fulfillment.service.js', {})
    restore = rs
    expect(mod.referenceCandidates({ data: { transaction: 'ref-9' } })).toEqual(['ref-9'])
    expect(mod.referenceCandidates({ data: { transaction: { reference: 'ref-1' }, reference: 'ref-1' } })).toEqual(['ref-1'])
    expect(mod.referenceCandidates({ data: { transaction: 123456 } })).toEqual([])
  })
})

describe('G3: sweepStalledRefunds', () => {
  const hoursAgo = h => new Date(NOW - h * 3600_000).toISOString()
  function rig({ refunds, paymentRefunds = [], payments, kvSeen = new Map() } = {}) {
    const world = createWorld({
      payments: payments || [
        { id: 'p1', paystack_ref: 'ref1', scan_id: 's1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD' },
        { id: 'p2', paystack_ref: 'ref2', scan_id: 's2', status: 'SUCCESS', amount_cents: 2900, currency: 'USD' },
      ],
      payment_refunds: paymentRefunds,
    })
    const sink = emails()
    const l = loadWithStubs('services/reconcile.service.js', { 'services/email.service.js': emailStub(sink) })
    restore = l.restore
    const env = { PAYSTACK_SECRET_KEY: 'sk', RATE_LIMIT_KV: { get: async k => kvSeen.get(k) ?? null, put: async (k, v) => { kvSeen.set(k, v) } } }
    return { world, sink, kvSeen, run: () => l.mod.sweepStalledRefunds(env, world.db, { now: NOW, list: async () => ({ data: refunds }) }) }
  }
  const item = over => ({ id: 1, status: 'needs-attention', amount: 2900, currency: 'USD', transaction_reference: 'ref1', updated_at: hoursAgo(30), ...over })

  it('reports a refund stuck in needs-attention for over a day, once, and changes nothing', async () => {
    const r = rig({ refunds: [item()] })
    const a = await r.run()
    expect(a.stalled).toHaveLength(1)
    expect(a.stalled[0]).toMatchObject({ reference: 'ref1', status: 'needs-attention' })
    expect(r.sink.alerts).toHaveLength(1)
    expect(r.sink.alerts[0].subject).toMatch(/1 stalled/)
    expect(r.world.t.payments.map(p => p.status)).toEqual(['SUCCESS', 'SUCCESS'])
    await r.run()
    expect(r.sink.alerts).toHaveLength(1)          // once a week per refund
  })
  it('leaves a fresh needs-attention refund and a processed one alone', async () => {
    const r = rig({ refunds: [item({ updated_at: hoursAgo(2) }), item({ id: 2, status: 'processed', transaction_reference: 'ref2', amount: 2900 })] })
    const a = await r.run()
    expect(a.stalled).toHaveLength(0)
    expect(r.sink.alerts).toHaveLength(0)
  })
  it('a failed refund is stalled only if nothing else is in progress for that payment', async () => {
    const failedOnly = rig({ refunds: [item({ status: 'failed' })] })
    expect((await failedOnly.run()).stalled).toHaveLength(1)
    restore(); 
    const retried = rig({ refunds: [item({ status: 'failed' }), item({ id: 2, status: 'processing', updated_at: hoursAgo(1) })] })
    expect((await retried.run()).stalled).toHaveLength(0)
  })
  it('pending/processing only counts after 72 hours', async () => {
    const r = rig({ refunds: [item({ id: 1, status: 'processing', updated_at: hoursAgo(80) }), item({ id: 2, status: 'pending', transaction_reference: 'ref2', updated_at: hoursAgo(10) })] })
    const a = await r.run()
    expect(a.stalled.map(s => s.refundId)).toEqual([1])
  })
  it('ignores a refund that belongs to no payment of this app (other products on the Paystack account), and one with no reference', async () => {
    const r = rig({ refunds: [item({ transaction_reference: 'not-ours' }), item({ id: 5, transaction_reference: undefined, transaction: 99 })] })
    const a = await r.run()
    expect(a.checked).toBe(0); expect(a.stalled).toHaveLength(0); expect(r.sink.alerts).toHaveLength(0)
  })
  it('a processed PARTIAL refund the app never recorded is reported; once it is recorded it is not', async () => {
    const lost = rig({ refunds: [item({ status: 'processed', amount: 1000 })] })
    const a = await lost.run()
    expect(a.missedPartial).toEqual([{ reference: 'ref1', scanId: 's1', paystack: 1000, recorded: 0, paid: 2900, currency: 'USD' }])
    expect(lost.sink.alerts[0].message).toMatch(/not recorded|has not recorded/)
    restore()
    const known = rig({ refunds: [item({ status: 'processed', amount: 1000 })], paymentRefunds: [{ payment_id: 'p1', event_key: 'k', amount_cents: 1000 }] })
    expect((await known.run()).missedPartial).toHaveLength(0)
  })
  it('a processed refund of the whole amount is left to the reversal sweep', async () => {
    const r = rig({ refunds: [item({ status: 'processed', amount: 2900 })] })
    expect((await r.run()).missedPartial).toHaveLength(0)
  })
  it('a Paystack or database failure comes back as an error and never throws', async () => {
    const r = rig({ refunds: [item()] })
    r.world.failNext('payments', 'select', { message: 'boom' })
    const a = await r.run()
    expect(a.error).toBe('boom')
  })
})

describe('G5: REVERSAL_CHECKS_PER_RUN', () => {
  it('defaults to 20, honours a valid value, clamps to 100, and ignores junk', () => {
    const { mod, restore: rs } = loadWithStubs('services/reconcile.service.js', {})
    restore = rs
    expect(mod.reversalChecksPerRun({})).toBe(20)
    expect(mod.reversalChecksPerRun({ REVERSAL_CHECKS_PER_RUN: '60' })).toBe(60)
    expect(mod.reversalChecksPerRun({ REVERSAL_CHECKS_PER_RUN: '9999' })).toBe(100)
    for (const bad of ['0', '-3', 'many', '']) expect(mod.reversalChecksPerRun({ REVERSAL_CHECKS_PER_RUN: bad })).toBe(20)
  })
  it('the sweep asks the database for that many rows', async () => {
    const world = createWorld({ payments: [] })
    const { mod, restore: rs } = loadWithStubs('services/reconcile.service.js', { 'services/email.service.js': emailStub(emails()) })
    restore = rs
    await mod.sweepReversedPayments({ REVERSAL_CHECKS_PER_RUN: '55', RATE_LIMIT_KV: null }, world.db, { now: NOW })
    expect(world.calls.find(c => c.table === 'payments').limit).toBe(55)
  })
})

// (Investigated as a suspected narrow-select bug: settlePayment works from the row its own flip UPDATE returns, so this sweep is fine. Kept as a guard.)
describe('the pending-payment sweep settles completely: receipt, reservation and attribution', () => {
  function rig() {
    const world = createWorld({
      users: [{ id: 'u1', email: 'buyer@x.co', name: 'Bea', deleted_at: null }],
      payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', user_id: 'u1', status: 'PENDING', amount_cents: 5000, currency: 'USD', fix_tier: 'FIX',
        referral_code_id: 'rc1', referral_reservation_id: 'res1', referral_source: 'link', created_at: minsAgo(120) }],
      scans: [{ id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false, fix_payment_id: null, updated_at: minsAgo(120), fix_tier: 'FIX' }],
      referral_codes: [{ id: 'rc1', partner_id: 'pa1', code: 'COACH', usage_limit: null, uses_so_far: 0 }],
      partners: [{ id: 'pa1', name: 'Pat', email: 'pat@x.co', commission_rate: 0.2, dashboard_token: 'tok', notify_conversions: true }],
      commission_ledger: [],
    })
    const rpcArgs = []
    world.rpcs.increment_referral_code_usage = args => { rpcArgs.push(args); const l = world.t.commission_ledger.find(x => x.id === args.p_ledger_id); if (l) l.usage_counted = true; return { data: null, error: null } }
    const sink = emails()
    sink.receipts = []
    const l = loadWithStubs('services/reconcile.service.js', {
      'services/email.service.js': { ...emailStub(sink), sendPaymentReceipt: async (e, db, to) => { sink.receipts.push(to); return true } },
      'services/paystack.service.js': { verifyTransaction: async () => ({ data: { status: 'success', amount: 5000, currency: 'USD', id: 9 } }) },
    })
    restore = () => { l.restore(); delete require_.cache[require_.resolve('../src/services/referral.service.js')] }
    const env = { FRONTEND_URL: 'https://app.test', FIX_QUEUE: { send: async () => {} }, RATE_LIMIT_KV: null }
    return { world, sink, rpcArgs, run: () => l.mod.sweepPendingPayments(env, world.db, { now: NOW }) }
  }
  it('the buyer gets the receipt and the checkout reservation is consumed with the commission', async () => {
    const r = rig()
    const out = await r.run()
    expect(out.recovered).toHaveLength(1)
    expect(r.world.t.payments[0].status).toBe('SUCCESS')
    expect(r.sink.receipts).toEqual(['buyer@x.co'])
    expect(r.rpcArgs[0]).toMatchObject({ p_code_id: 'rc1', p_reservation_id: 'res1' })
    expect(r.world.t.commission_ledger[0].attribution_source).toBe('link')
  })
})
