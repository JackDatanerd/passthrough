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
function setup(world, { sendFails = false, receiptFails = false } = {}) {
  const receipts = []
  const state = { sendFails, receiptFails }
  const { mod, restore } = loadWithStubs('services/fulfillment.service.js', {
    'services/email.service.js': {
      sendPaymentReceipt: async (env, db, to) => { if (state.receiptFails) throw new Error('resend down'); receipts.push(to) },
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

  it('releases the claim when the send fails, so a later path can still send it', async () => {
    console.error = () => {}
    const w = seed(); t = setup(w, { receiptFails: true })
    await t.settle()
    expect(t.receipts).toHaveLength(0)
    expect(w.t.payments[0].receipt_sent_at).toBeNull()
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
