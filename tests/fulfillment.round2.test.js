import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Round-2 audit, Section 8: the delivery that FINISHES the job owns the partner
// commission and the receipt — not just the delivery that won the SUCCESS flip.

const NOW = Date.now()
function seed(over = {}) {
  const world = createWorld({
    payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', user_id: 'u1', status: 'PENDING', amount_cents: 3900, currency: 'USD',
                 fix_tier: 'FIX', referral_code_id: 'rc1', receipt_sent_at: null, created_at: new Date(NOW).toISOString() }],
    scans: [{ id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false, fix_payment_id: null, updated_at: new Date(NOW).toISOString() }],
    users: [{ id: 'u1', email: 'a@b.c', name: 'A', deleted_at: null }],
    referral_codes: [{ id: 'rc1', partner_id: 'pt1', code: 'X', usage_limit: null, uses_so_far: 0 }],
    partners: [{ id: 'pt1', commission_rate: 0.2 }],
    commission_ledger: [], ...over,
  })
  world.partialUnique.commission_ledger = [{ cols: ['payment_id'], where: r => r.reverses_ledger_id == null }]
  world.rpcs.increment_referral_code_usage = () => ({ data: null, error: null })
  return world
}

let t
afterEach(() => t?.restore())
function setup(world, { sendFails = false, receiptFails = false, receiptFalse = false } = {}) {
  const receipts = []
  const state = { sendFails, receiptFails, receiptFalse }
  const { mod, restore } = loadWithStubs('services/fulfillment.service.js', {
    'services/email.service.js': {
      // receiptFails models a THROWN error; receiptFalse models what the REAL
      // email.service.send() does on a failed/throttled send: it never throws,
      // it returns false (B9 — the tests only ever modelled the throw).
      sendPaymentReceipt: async (env, db, to) => {
        if (state.receiptFails) throw new Error('resend down')
        if (state.receiptFalse) return false
        receipts.push(to); return true
      },
      sendOwnerAlert: async () => {},
    },
  })
  const env = { FIX_QUEUE: { send: async () => { if (state.sendFails) throw new Error('queue blip') } } }
  const settle = (opts = {}) => mod.settlePayment(env, world.db, { ...world.t.payments[0] }, { source: 'webhook', ...opts })
  return { mod, restore, receipts, state, settle }
}
const realConsoleError = console.error
afterEach(() => { console.error = realConsoleError })

describe('settlePayment — commission and receipt after a half-finished first delivery', () => {
  it('REGRESSION: flip winner throws on the queue, the redelivery finishes — commission AND receipt still happen', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w, { sendFails: true })
    await expect(t.settle()).rejects.toThrow('queue blip')
    expect(w.t.payments[0].status).toBe('SUCCESS')
    expect(w.t.commission_ledger).toHaveLength(0)

    t.state.sendFails = false
    w.t.scans[0].updated_at = new Date(NOW - 5 * 60_000).toISOString()      // Paystack's retry arrives minutes later
    const r = await t.settle()
    expect(r.outcome).toBe('REENQUEUED')
    expect(r.won).toBe(false)
    expect(w.t.commission_ledger).toHaveLength(1)
    expect(w.t.commission_ledger[0]).toMatchObject({ payment_id: 'p1', partner_id: 'pt1', commission_amount_cents: 780 })
    expect(t.receipts).toEqual(['a@b.c'])
  })

  it('a claim failure on delivery #1 (scan never claimed) is finished by delivery #2 with commission + receipt', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w)
    w.failNext('scans', 'update', { message: 'db blip' })
    await expect(t.settle()).rejects.toBeTruthy()
    const r = await t.settle()
    expect(r.outcome).toBe('FULFILLED')
    expect(w.t.commission_ledger).toHaveLength(1)
    expect(t.receipts).toHaveLength(1)
  })

  it('normal path unchanged: one delivery → one commission, one receipt; a later redelivery adds neither', async () => {
    const w = seed(); t = setup(w)
    const first = await t.settle()
    expect(first).toMatchObject({ outcome: 'FULFILLED', won: true })
    const again = await t.settle()
    expect(again).toMatchObject({ outcome: 'ALREADY_FULFILLED', won: false })
    expect(w.t.commission_ledger).toHaveLength(1)
    expect(t.receipts).toHaveLength(1)
  })

  it('a DUPLICATE payment earns no commission', async () => {
    const w = seed(); t = setup(w)
    w.t.scans[0].fix_purchased = true; w.t.scans[0].fix_payment_id = 'other-payment'
    const r = await t.settle()
    expect(r.outcome).toBe('DUPLICATE')
    expect(w.t.commission_ledger).toHaveLength(0)
  })
})

describe('settlePayment — receipt exactly once', () => {
  it('claims receipt_sent_at atomically: a second finisher cannot mail another', async () => {
    const w = seed(); t = setup(w)
    await t.settle()
    expect(w.t.payments[0].receipt_sent_at).toBeTruthy()
    // force a second "finishing" delivery (scan reset as if the job message were lost)
    w.t.scans[0].status = 'FIX_PURCHASED'; w.t.scans[0].updated_at = new Date(NOW - 10 * 60_000).toISOString()
    const r = await t.settle()
    expect(r.outcome).toBe('REENQUEUED')
    expect(t.receipts).toHaveLength(1)
  })

  it('a thrown send failure KEEPS the claim, undelivered — exactly the state recoverLostReceipts retries hourly', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w, { receiptFails: true })
    await t.settle()
    expect(t.receipts).toHaveLength(0)
    expect(w.t.payments[0].receipt_sent_at).toBeTruthy()
    expect(w.t.payments[0].receipt_delivered_at ?? null).toBeNull()
  })

  // B9 REGRESSION. email.service.send() never throws — a failed or throttled
  // send returns false. The old code awaited it and stamped
  // receipt_delivered_at regardless, so the failure was recorded as "delivered"
  // and no sweep would ever retry: the buyer just never got a receipt.
  it('REGRESSION (B9): send() returning false is NOT recorded as delivered', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w, { receiptFalse: true })
    await t.settle()
    expect(t.receipts).toHaveLength(0)
    expect(w.t.payments[0].receipt_delivered_at ?? null).toBeNull()
    expect(w.t.payments[0].receipt_sent_at).toBeTruthy()
  })

  it('REGRESSION (B9): …and once the mail provider recovers, the sweep re-sends it and only then marks it delivered', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w, { receiptFalse: true })
    await t.settle()
    // 11 minutes later the provider is healthy again
    w.t.payments[0].receipt_sent_at = new Date(NOW - 11 * 60_000).toISOString()
    t.state.receiptFalse = false
    const r = await t.mod.recoverLostReceipts({}, w.db, { now: NOW })
    expect(r.resent).toBe(1)
    expect(t.receipts).toEqual(['a@b.c'])
    expect(w.t.payments[0].receipt_delivered_at).toBeTruthy()
  })

  it('defer: the email is handed to the caller instead of being awaited inline', async () => {
    const w = seed(); t = setup(w)
    const deferred = []
    await t.settle({ defer: p => deferred.push(p) })
    expect(deferred).toHaveLength(1)
    await Promise.all(deferred)
    expect(t.receipts).toHaveLength(1)
  })

  it('without the migration (column missing) it falls back to the old "winner sends" rule', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w)
    const realFrom = w.db.from
    w.db.from = table => {          // receipt_sent_at does not exist yet → PostgREST/Postgres error on the claim
      const api = realFrom(table)
      if (table !== 'payments') return api
      const realUpdate = api.update
      api.update = patch => (patch && patch.receipt_sent_at
        ? { eq() { return this }, is() { return this }, select: async () => ({ data: null, error: { code: '42703', message: 'column "receipt_sent_at" does not exist' } }) }
        : realUpdate(patch))
      return api
    }
    await t.settle()                 // the winner still sends
    expect(t.receipts).toHaveLength(1)
    // …but a non-winner finishing delivery does not guess (it cannot dedupe)
    w.t.scans[0].status = 'FIX_PURCHASED'; w.t.scans[0].updated_at = new Date(NOW - 10 * 60_000).toISOString()
    const r = await t.settle()
    expect(r.outcome).toBe('REENQUEUED')
    expect(t.receipts).toHaveLength(1)
  })
})

// ── Round 3: a claimed-but-never-delivered receipt is recovered ────────────
describe('receipt delivery marker + recoverLostReceipts', () => {
  const tenMinAgo = new Date(NOW - 11 * 60_000).toISOString()

  it('marks receipt_delivered_at only AFTER the send succeeded', async () => {
    const w = seed(); t = setup(w)
    await t.settle()
    expect(w.t.payments[0].receipt_delivered_at).toBeTruthy()
  })

  it('a claim whose send was cancelled (claimed, never delivered) is re-sent by the sweep — exactly once', async () => {
    const w = seed(); t = setup(w)
    Object.assign(w.t.payments[0], { status: 'SUCCESS', receipt_sent_at: tenMinAgo, receipt_delivered_at: null })
    const a = await t.mod.recoverLostReceipts({}, w.db, { now: NOW })
    expect(a.resent).toBe(1)
    expect(t.receipts).toHaveLength(1)
    const b = await t.mod.recoverLostReceipts({}, w.db, { now: NOW })
    expect(b.checked).toBe(0)
    expect(t.receipts).toHaveLength(1)
  })

  it('leaves a recent claim alone — the original send may simply still be running', async () => {
    const w = seed(); t = setup(w)
    Object.assign(w.t.payments[0], { status: 'SUCCESS', receipt_sent_at: new Date(NOW - 60_000).toISOString(), receipt_delivered_at: null })
    expect((await t.mod.recoverLostReceipts({}, w.db, { now: NOW })).checked).toBe(0)
    expect(t.receipts).toHaveLength(0)
  })

  it('REGRESSION (B9): a re-send that send() reports as false is counted failed, not delivered', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w, { receiptFalse: true })
    Object.assign(w.t.payments[0], { status: 'SUCCESS', receipt_sent_at: tenMinAgo, receipt_delivered_at: null })
    const r = await t.mod.recoverLostReceipts({}, w.db, { now: NOW })
    expect(r.failed).toBe(1)
    expect(r.resent).toBe(0)
    expect(w.t.payments[0].receipt_delivered_at ?? null).toBeNull()
  })

  it('a failed re-send is counted and retried later (the fresh claim time defers it 10 minutes)', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w, { receiptFails: true })
    Object.assign(w.t.payments[0], { status: 'SUCCESS', receipt_sent_at: tenMinAgo, receipt_delivered_at: null })
    const r = await t.mod.recoverLostReceipts({}, w.db, { now: NOW })
    expect(r.failed).toBe(1)
    expect(w.t.payments[0].receipt_delivered_at).toBeNull()
    expect((await t.mod.recoverLostReceipts({}, w.db, { now: NOW })).checked).toBe(0)
  })
})

// ── Payments & Pricing pass 1 (G4): resendReceipt ───────────────────────────
describe('resendReceipt', () => {
  it('sends to the buyer\'s current email and marks the receipt delivered', async () => {
    const w = seed(); t = setup(w)
    Object.assign(w.t.payments[0], { status: 'SUCCESS', receipt_sent_at: null, receipt_delivered_at: null })
    const r = await t.mod.resendReceipt({}, w.db, { ...w.t.payments[0] })
    expect(r).toEqual({ sent: true, reason: null, email: 'a@b.c' })
    expect(t.receipts).toEqual(['a@b.c'])
    expect(w.t.payments[0].receipt_delivered_at).toBeTruthy()
  })
  it('reports SEND_FAILED when the mailer returns false (never a fake success) and does not mark delivered', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w, { receiptFalse: true })
    const r = await t.mod.resendReceipt({}, w.db, { ...w.t.payments[0] })
    expect(r.sent).toBe(false)
    expect(r.reason).toBe('SEND_FAILED')
    expect(w.t.payments[0].receipt_delivered_at ?? null).toBeNull()
  })
  it('reports NO_EMAIL when the account has no address, and never throws', async () => {
    const w = seed(); t = setup(w)
    w.t.users[0].email = null
    const r = await t.mod.resendReceipt({}, w.db, { ...w.t.payments[0] })
    expect(r).toEqual({ sent: false, reason: 'NO_EMAIL', email: null })
    expect(t.receipts).toHaveLength(0)
  })
})

// ── Payments & Pricing pass 1 (G2): abandonPendingForScan ───────────────────
describe('abandonPendingForScan', () => {
  function seedPending() {
    return seed({ payments: [
      { id: 'pa', paystack_ref: 'refA', scan_id: 's1', user_id: 'u1', status: 'PENDING', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX', referral_reservation_id: 'res1', created_at: new Date(NOW).toISOString() },
      { id: 'pb', paystack_ref: 'refB', scan_id: 's1', user_id: 'u1', status: 'SUCCESS', amount_cents: 0, currency: 'USD', fix_tier: 'FIX', created_at: new Date(NOW).toISOString() },
      { id: 'pc', paystack_ref: 'refC', scan_id: 's2', user_id: 'u1', status: 'PENDING', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX', created_at: new Date(NOW).toISOString() },
    ], referral_code_reservations: [{ id: 'res1', referral_code_id: 'rc1' }] })
  }
  it('abandons only THIS scan\'s PENDING checkout — never a settled row, never another scan\'s', async () => {
    const w = seedPending(); t = setup(w)
    const n = await t.mod.abandonPendingForScan(w.db, 's1')
    expect(n).toBe(1)
    const st = id => w.t.payments.find(p => p.id === id).status
    expect(st('pa')).toBe('ABANDONED')
    expect(st('pb')).toBe('SUCCESS')
    expect(st('pc')).toBe('PENDING')
  })
  it('hands back the referral-code usage slot the closed checkout was holding', async () => {
    const w = seedPending(); t = setup(w)
    const released = []
    w.rpcs.release_referral_code_slot = args => { released.push(args.p_reservation_id); return { data: null, error: null } }
    await t.mod.abandonPendingForScan(w.db, 's1')
    expect(released).toEqual(['res1'])
  })
  it('never throws — a database error just reports 0 closed', async () => {
    console.error = () => {}
    t = setup(seedPending())
    const bad = { from: () => { throw new Error('db down') } }
    expect(await t.mod.abandonPendingForScan(bad, 's1')).toBe(0)
  })
})
