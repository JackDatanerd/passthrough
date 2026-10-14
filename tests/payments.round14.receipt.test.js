import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Payments & Pricing round 14: a payment that delivered nothing (DUPLICATE / SCAN_MISSING / NO_SCAN) must not be
// receipted, and a duplicate must not advertise or retry a receipt.

const NOW = Date.now()
let t
afterEach(() => t && t.restore())

function seed({ scan, payments }) {
  return createWorld({
    payments,
    scans: scan ? [scan] : [],
    users: [{ id: 'u1', email: 'a@b.c', name: 'A', deleted_at: null }],
    commission_ledger: [],
  })
}
function load(world) {
  const receipts = []
  const { mod, restore } = loadWithStubs('services/fulfillment.service.js', {
    'services/email.service.js': { sendPaymentReceipt: async (e, d, to) => { receipts.push(to); return true }, sendOwnerAlert: async () => {} },
    'services/refund.service.js': { autoRefundEnabled: () => false, autoRefundUndeliverableEnabled: () => false,
      UNDELIVERABLE_OUTCOMES: ['SCAN_MISSING', 'NO_SCAN', 'ACCOUNT_DELETED'],
      autoRefundDuplicate: async () => ({ status: 'SKIPPED' }), autoRefundUndeliverable: async () => ({ status: 'SKIPPED' }) },
  })
  t = { restore }
  const env = { FIX_QUEUE: { send: async () => {} } }
  return { mod, receipts, env }
}
const pay = (id, over = {}) => ({ id, paystack_ref: 'ref' + id, scan_id: 's1', user_id: 'u1', status: 'PENDING', amount_cents: 3900,
  currency: 'USD', fix_tier: 'FIX', receipt_sent_at: null, created_at: new Date(NOW).toISOString(), ...over })
const scanOwnedBy = (owner, over = {}) => ({ id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_payment_id: owner, updated_at: new Date(NOW).toISOString(), ...over })

describe('settlePayment receipts', () => {
  it('DUPLICATE: no receipt', async () => {
    const w = seed({ scan: scanOwnedBy('pA'), payments: [pay('pA', { status: 'SUCCESS' }), pay('pB')] })
    const { mod, receipts, env } = load(w)
    const r = await mod.settlePayment(env, w.db, { ...w.t.payments[1] }, { source: 'verify' })
    expect(r.outcome).toBe('DUPLICATE')
    expect(receipts).toEqual([])
  })
  it('NO_SCAN: no receipt', async () => {
    const w = seed({ scan: null, payments: [pay('pA', { scan_id: null })] })
    const { mod, receipts, env } = load(w)
    const r = await mod.settlePayment(env, w.db, { ...w.t.payments[0] }, { source: 'verify' })
    expect(r.outcome).toBe('NO_SCAN')
    expect(receipts).toEqual([])
  })
  it('SCAN_MISSING: no receipt', async () => {
    const w = seed({ scan: null, payments: [pay('pA')] })
    const { mod, receipts, env } = load(w)
    const r = await mod.settlePayment(env, w.db, { ...w.t.payments[0] }, { source: 'verify' })
    expect(r.outcome).toBe('SCAN_MISSING')
    expect(receipts).toEqual([])
  })
  it('normal delivery still sends exactly one receipt', async () => {
    const w = seed({ scan: scanOwnedBy(null, { fix_purchased: false, status: 'COMPLETE_PASS' }), payments: [pay('pA')] })
    const { mod, receipts, env } = load(w)
    const r = await mod.settlePayment(env, w.db, { ...w.t.payments[0] }, { source: 'verify' })
    expect(r.outcome).toBe('FULFILLED')
    expect(receipts).toEqual(['a@b.c'])
  })
})

describe('isDuplicateOfOtherPayment / recoverLostReceipts', () => {
  it('true only when the scan is owned by a different payment', async () => {
    const w = seed({ scan: scanOwnedBy('pA'), payments: [pay('pA', { status: 'SUCCESS' }), pay('pB', { status: 'SUCCESS' })] })
    const { mod } = load(w)
    expect(await mod.isDuplicateOfOtherPayment(w.db, w.t.payments[0])).toBe(false)
    expect(await mod.isDuplicateOfOtherPayment(w.db, w.t.payments[1])).toBe(true)
    expect(await mod.isDuplicateOfOtherPayment(w.db, { id: 'x', scan_id: null })).toBe(false)
    expect(await mod.isDuplicateOfOtherPayment(w.db, { id: 'x', scan_id: 'gone' })).toBe(false)
  })
  it('a claimed-but-undelivered receipt for a duplicate is closed out, not mailed', async () => {
    const old = new Date(NOW - 60 * 60 * 1000).toISOString()
    const w = seed({ scan: scanOwnedBy('pA'), payments: [pay('pA', { status: 'SUCCESS', receipt_sent_at: old, receipt_delivered_at: new Date(NOW).toISOString() }),
      pay('pB', { status: 'SUCCESS', receipt_sent_at: old, receipt_delivered_at: null })] })
    const { mod, receipts } = load(w)
    await mod.recoverLostReceipts({}, w.db, { now: NOW })
    expect(receipts).toEqual([])
    expect(w.t.payments[1].receipt_delivered_at).toBeTruthy()
  })
})
