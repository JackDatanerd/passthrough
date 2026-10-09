import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Payments & Pricing round 8 — service layer:
//   G1  an undeliverable payment (scan gone / never attached / account deleted) refunds itself
//   B5  settlePayment stamps paid_at (and survives the column not existing yet); receipts show it

const NOW = Date.now()
let t
afterEach(() => t?.restore())
const realError = console.error
afterEach(() => { console.error = realError })

const pay = (over = {}) => ({ id: 'p1', paystack_ref: 'ref1', scan_id: 's-gone', user_id: 'u1', status: 'PENDING', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX', referral_code_id: null, created_at: new Date(NOW - 86400_000).toISOString(), ...over })
function world({ scans, pays, users } = {}) {
  return createWorld({
    payments: pays || [pay()],
    scans: scans || [],
    users: users || [{ id: 'u1', email: 'a@b.c', name: 'A', deleted_at: null }],
    referral_codes: [], partners: [], commission_ledger: [], admin_audit_log: [],
  })
}
function setup(w, { verify, refundList = { data: [] }, listThrows = null, env: envOver = {}, receiptSpy } = {}) {
  const state = { alerts: [], emails: [], refunds: [], receipts: [], queue: [] }
  const stubs = {
    'services/email.service.js': {
      sendOwnerAlert: async (e, subject, message, opts) => { state.alerts.push({ subject, message, opts }) },
      sendPaymentReceipt: async (e, db, to, name, info) => { state.receipts.push(info); return true },
      sendPaymentReversed: async (e, db, to, name, info) => { state.emails.push({ to, ...info }); return true },
    },
    'services/paystack.service.js': {
      verifyTransaction: async () => verify,
      isPendingStatus: () => false,
      listRefunds: async () => { if (listThrows) throw listThrows; return refundList },
      createRefund: async (e, ref, o) => { state.refunds.push({ ref, ...o }); return { status: true, data: { status: 'pending' } } },
    },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true, recorded: false }) },
  }
  const env = { ...envOver, FIX_QUEUE: { send: async m => { state.queue.push(m) } } }
  const f = loadWithStubs('services/fulfillment.service.js', stubs)
  const r = loadWithStubs('services/refund.service.js', { 'services/paystack.service.js': stubs['services/paystack.service.js'] })
  return { state, env, db: w.db, fulfillment: f.mod, refund: r.mod, restore() { f.restore(); r.restore() } }
}
const row = (w, id = 'p1') => w.t.payments.find(p => p.id === id)
const settle = (tt, w, opts = {}, over = {}) => tt.fulfillment.settlePayment(tt.env, tt.db, { ...row(w), ...over }, { source: 'webhook', ...opts })

describe('G1 — settlePayment auto-refunds an undeliverable payment', () => {
  it('SCAN_MISSING: settles the money, refunds it in full once, and says so', async () => {
    const w = world(); t = setup(w, {})
    const r = await settle(t, w)
    expect(r.outcome).toBe('SCAN_MISSING')
    expect(row(w).status).toBe('SUCCESS')
    expect(r.autoRefund).toEqual({ status: 'QUEUED', amountCents: 3900 })
    expect(t.state.refunds).toHaveLength(1)
    expect(t.state.refunds[0].ref).toBe('ref1')
    expect(w.t.admin_audit_log.some(a => a.action === 'payment.auto_refund_undeliverable')).toBe(true)
  })

  it('NO_SCAN (scan deleted → scan_id set null) refunds too', async () => {
    const w = world({ pays: [pay({ scan_id: null })] }); t = setup(w, {})
    const r = await settle(t, w)
    expect(r.outcome).toBe('NO_SCAN')
    expect(r.autoRefund.status).toBe('QUEUED')
  })

  it('ACCOUNT_DELETED refunds too', async () => {
    const w = world({ scans: [{ id: 's-gone', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false }], users: [{ id: 'u1', email: 'a@b.c', name: 'A', deleted_at: '2026-01-01T00:00:00Z' }] })
    t = setup(w, {})
    const r = await settle(t, w)
    expect(r.outcome).toBe('ACCOUNT_DELETED')
    expect(r.autoRefund.status).toBe('QUEUED')
  })

  it('a normal delivery carries no autoRefund and touches no refund API', async () => {
    const w = world({ scans: [{ id: 's-gone', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false }] }); t = setup(w, {})
    const r = await settle(t, w)
    expect(r.outcome).toBe('FULFILLED')
    expect('autoRefund' in r).toBe(false)
    expect(t.state.refunds).toHaveLength(0)
  })

  it('AUTO_REFUND_UNDELIVERABLE=false disables it', async () => {
    const w = world(); t = setup(w, { env: { AUTO_REFUND_UNDELIVERABLE: 'false' } })
    const r = await settle(t, w)
    expect(r.autoRefund).toEqual({ status: 'SKIPPED', reason: 'DISABLED' })
    expect(t.state.refunds).toHaveLength(0)
  })

  it('an in-flight refund is reported IN_PROGRESS, never duplicated', async () => {
    const w = world(); t = setup(w, { refundList: { data: [{ status: 'pending', amount: 3900 }] } })
    const r = await settle(t, w)
    expect(r.autoRefund).toMatchObject({ status: 'IN_PROGRESS' })
    expect(t.state.refunds).toHaveLength(0)
  })

  it('a Paystack outage is FAILED, and the inline caller is left to page the owner (alert text says "by hand")', async () => {
    console.error = () => {}
    const w = world(); t = setup(w, { listThrows: new Error('paystack down') })
    const r = await settle(t, w)
    expect(r.autoRefund.status).toBe('FAILED')
    await t.fulfillment.notifySettlementProblem(t.env, r, row(w), 'webhook')
    const a = t.state.alerts.map(x => x.subject + ' ' + x.message).join('\n')
    expect(a).toMatch(/by hand|FAILED/i)
  })

  it('deferred (webhook): answers SCHEDULED at once and refunds in the deferred task', async () => {
    const w = world(); t = setup(w, {})
    const tasks = []
    const r = await settle(t, w, { defer: p => tasks.push(p) })
    expect(r.autoRefund).toEqual({ status: 'SCHEDULED' })
    expect(t.state.refunds).toHaveLength(0)
    await Promise.all(tasks)
    expect(t.state.refunds).toHaveLength(1)
  })

  it('deferred and failing: the task pages the owner itself, deduped per reference', async () => {
    console.error = () => {}
    const w = world(); t = setup(w, { listThrows: new Error('paystack down') })
    const tasks = []
    await settle(t, w, { defer: p => tasks.push(p) })
    await Promise.all(tasks)
    const a = t.state.alerts.find(x => x.subject.includes('FAILED'))
    expect(a).toBeTruthy()
    expect(a.opts).toEqual({ dedupeKey: 'ref1:autorefund' })
  })
})

describe('refund.service.autoRefundUndeliverable guards', () => {
  const sPay = (over = {}) => pay({ status: 'SUCCESS', ...over })
  it('refuses a payment that owns the scan (proof of delivery)', async () => {
    const w = world({ scans: [{ id: 's-gone', user_id: 'u1', fix_purchased: true, fix_payment_id: 'p1' }] }); t = setup(w, {})
    expect(await t.refund.autoRefundUndeliverable(t.env, t.db, sPay(), { outcome: 'ACCOUNT_DELETED' })).toEqual({ status: 'SKIPPED', reason: 'DELIVERED' })
    expect(t.state.refunds).toHaveLength(0)
  })
  it('refuses outcomes that are not undeliverable, unsettled rows and free credits', async () => {
    const w = world(); t = setup(w, {})
    expect((await t.refund.autoRefundUndeliverable(t.env, t.db, sPay(), { outcome: 'FULFILLED' })).reason).toBe('NOT_UNDELIVERABLE')
    expect((await t.refund.autoRefundUndeliverable(t.env, t.db, pay({ status: 'PENDING' }), { outcome: 'NO_SCAN' })).reason).toBe('NOT_SETTLED')
    expect((await t.refund.autoRefundUndeliverable(t.env, t.db, sPay({ amount_cents: 0, paystack_ref: 'credit:s:1' }), { outcome: 'NO_SCAN' })).reason).toBe('FREE')
    expect(t.state.refunds).toHaveLength(0)
  })
  it('exports the undeliverable outcome list', () => {
    const w = world(); t = setup(w, {})
    expect(t.refund.UNDELIVERABLE_OUTCOMES).toEqual(['SCAN_MISSING', 'NO_SCAN', 'ACCOUNT_DELETED'])
    expect(t.refund.autoRefundUndeliverableEnabled({})).toBe(true)
    expect(t.refund.autoRefundUndeliverableEnabled({ AUTO_REFUND_UNDELIVERABLE: 'FALSE' })).toBe(false)
  })
})

describe('B5 — paid_at', () => {
  const owned = () => world({ scans: [{ id: 's-gone', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false }] })
  it('settlePayment stamps paid_at when the row flips to SUCCESS', async () => {
    const w = owned(); t = setup(w, {})
    await settle(t, w)
    expect(row(w).status).toBe('SUCCESS')
    expect(Date.parse(row(w).paid_at)).toBeGreaterThan(NOW - 5000)
  })
  it('still settles when paid_at does not exist yet (migration 0064 not applied), and warns', async () => {
    const w = owned(); t = setup(w, {})
    const warns = []; const realWarn = console.warn; const realLog = console.log
    console.warn = (...a) => warns.push(a.join(' ')); console.log = (...a) => warns.push(a.join(' '))
    w.failNext('payments', 'update', { code: '42703', message: 'column "paid_at" of relation "payments" does not exist' })
    try {
      const r = await settle(t, w)
      expect(r.outcome).toBe('FULFILLED')
    } finally { console.warn = realWarn; console.log = realLog }
    expect(row(w).status).toBe('SUCCESS')
    expect(row(w).paid_at).toBeUndefined()
  })
})
