import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Payments & Pricing round 6:
//   B1  an accepted UNDERpayment is recorded at what Paystack captured (refund maths + commission follow it)
//   B2  a mismatch found without the webhook (guard / sweep) alerts the owner; the admin's own recheck stays quiet
//   G1  a DUPLICATE is refunded automatically (inline, and deferred behind the webhook), idempotently,
//       and the buyer's refund email says "extra payment", not "purchase closed"

const NOW = Date.now()
let t
afterEach(() => t?.restore())
const realError = console.error
afterEach(() => { console.error = realError })

function payments(over = []) {
  return [
    { id: 'p-first', paystack_ref: 'ref0', scan_id: 's1', user_id: 'u1', status: 'SUCCESS', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX', created_at: new Date(NOW - 3600_000).toISOString() },
    { id: 'p1', paystack_ref: 'ref1', scan_id: 's1', user_id: 'u1', status: 'PENDING', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX', referral_code_id: null, created_at: new Date(NOW).toISOString() },
    ...over,
  ]
}
function world({ owned = true, pays } = {}) {
  return createWorld({
    payments: pays || payments(),
    scans: [{ id: 's1', user_id: 'u1', status: owned ? 'FIX_DELIVERED' : 'COMPLETE_PASS', fix_purchased: owned, fix_payment_id: owned ? 'p-first' : null, updated_at: new Date(NOW).toISOString() }],
    users: [{ id: 'u1', email: 'a@b.c', name: 'A', deleted_at: null }],
    referral_codes: [], partners: [], commission_ledger: [], admin_audit_log: [],
  })
}

function setup(w, { verify, refundList = { data: [] }, createRefundThrows = null, listThrows = null, env: envOver = {} } = {}) {
  const state = { alerts: [], emails: [], refunds: [], conversions: [], queue: [] }
  const stubs = {
    'services/email.service.js': {
      sendOwnerAlert: async (e, subject, message, opts) => { state.alerts.push({ subject, message, opts }) },
      sendPaymentReceipt: async () => true,
      sendPaymentReversed: async (e, db, to, name, info) => { state.emails.push({ to, ...info }); return true },
    },
    'services/paystack.service.js': {
      verifyTransaction: async () => verify,
      isPendingStatus: () => false,
      listRefunds: async () => { if (listThrows) throw listThrows; return refundList },
      createRefund: async (e, ref, o) => { if (createRefundThrows) throw createRefundThrows; state.refunds.push({ ref, ...o }); return { status: true, data: { status: 'pending' } } },
    },
    'services/referral.service.js': {
      recordConversion: async (db, row) => { state.conversions.push(row.amount_cents); return { ok: true, recorded: false } },
    },
  }
  const env = { ...envOver, FIX_QUEUE: { send: async m => { state.queue.push(m) } } }
  const fulfil = loadWithStubs('services/fulfillment.service.js', stubs)
  const recon = loadWithStubs('services/reconcile.service.js', {})
  return {
    state, env, db: w.db, fulfillment: fulfil.mod, reconcile: recon.mod,
    restore() { recon.restore(); fulfil.restore() },
  }
}
const row = (w, id = 'p1') => w.t.payments.find(p => p.id === id)

describe('B1 — recheckPayment with acceptAmountMismatch records what was actually captured', () => {
  it('an accepted UNDERpayment lowers amount_cents to the captured amount, and settles/commissions on THAT amount', async () => {
    const w = world({ owned: false }); t = setup(w, { verify: { data: { status: 'success', amount: 3500, currency: 'USD' } } })
    const r = await t.reconcile.recheckPayment(t.env, t.db, { ...row(w) }, { acceptAmountMismatch: true, source: 'admin-recheck' })
    expect(r.outcome).toBe('FULFILLED')
    expect(r.amountAdjusted).toEqual({ from: 3900, to: 3500 })
    expect(row(w)).toMatchObject({ status: 'SUCCESS', amount_cents: 3500 })
    expect(t.state.conversions).toEqual([3500])
  })

  it('an accepted OVERpayment (the buyer covered a fee) keeps the expected price', async () => {
    const w = world({ owned: false }); t = setup(w, { verify: { data: { status: 'success', amount: 4100, currency: 'USD' } } })
    const r = await t.reconcile.recheckPayment(t.env, t.db, { ...row(w) }, { acceptAmountMismatch: true })
    expect(r.outcome).toBe('FULFILLED')
    expect(r.amountAdjusted).toBeUndefined()
    expect(row(w).amount_cents).toBe(3900)
  })

  it('without acceptAmountMismatch the row is untouched and held', async () => {
    const w = world({ owned: false }); t = setup(w, { verify: { data: { status: 'success', amount: 3500, currency: 'USD' } } })
    const r = await t.reconcile.recheckPayment(t.env, t.db, { ...row(w) }, {})
    expect(r.outcome).toBe('MISMATCH')
    expect(row(w)).toMatchObject({ status: 'PENDING', amount_cents: 3900 })
  })

  it('a currency mismatch can never be accepted, and never adjusts the amount', async () => {
    const w = world({ owned: false }); t = setup(w, { verify: { data: { status: 'success', amount: 3500, currency: 'KES' } } })
    const r = await t.reconcile.recheckPayment(t.env, t.db, { ...row(w) }, { acceptAmountMismatch: true })
    expect(r.outcome).toBe('MISMATCH')
    expect(row(w).amount_cents).toBe(3900)
  })

  it('a row that settled concurrently (no longer revivable) is not adjusted', async () => {
    const w = world({ owned: false }); t = setup(w, { verify: { data: { status: 'success', amount: 3500, currency: 'USD' } } })
    row(w).status = 'REFUNDED'
    const r = await t.reconcile.recheckPayment(t.env, t.db, { ...row(w), status: 'PENDING' }, { acceptAmountMismatch: true })
    expect(r.amountAdjusted).toBeUndefined()
    expect(row(w).amount_cents).toBe(3900)
  })
})

describe('B2 — notifySettlementProblem alerts a mismatch found without the webhook', () => {
  const mismatch = { outcome: 'MISMATCH', expectedAmount: 3900, expectedCurrency: 'USD', receivedAmount: 100, receivedCurrency: 'USD' }
  it('alerts for the checkout guard and the sweep, naming expected vs received, deduped per reference', async () => {
    const w = world(); t = setup(w, {})
    for (const source of ['checkout-guard', 'pending-sweep']) {
      expect(await t.fulfillment.notifySettlementProblem(t.env, mismatch, row(w), source)).toBe(true)
    }
    expect(t.state.alerts).toHaveLength(2)
    expect(t.state.alerts[0].subject).toContain('mismatch')
    expect(t.state.alerts[0].message).toContain('expected: 3900 USD')
    expect(t.state.alerts[0].message).toContain('received: 100 USD')
    expect(t.state.alerts[0].opts).toEqual({ dedupeKey: 'ref1' })
  })
  it('stays quiet for the admin\'s own recheck — the response already shows them the answer', async () => {
    const w = world(); t = setup(w, {})
    expect(await t.fulfillment.notifySettlementProblem(t.env, mismatch, row(w), 'admin-recheck')).toBe(false)
    expect(t.state.alerts).toHaveLength(0)
  })
  it('the sweep reports a held mismatch in its summary and alerts once for it', async () => {
    const w = world({ owned: false, pays: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', user_id: 'u1', status: 'PENDING', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX', created_at: new Date(NOW - 30 * 60_000).toISOString() }] })
    t = setup(w, { verify: { data: { status: 'success', amount: 100, currency: 'USD' } } })
    const r = await t.reconcile.sweepPendingPayments(t.env, t.db, { now: NOW })
    expect(r.held).toEqual([{ reference: 'ref1' }])
    const subjects = t.state.alerts.map(a => a.subject)
    expect(subjects.some(s => s.includes('mismatch'))).toBe(true)
    expect(subjects.some(s => s.startsWith('Pending-payment sweep') && s.includes('1 held'))).toBe(true)
    expect(row(w).status).toBe('PENDING')
  })
})

describe('G1 — settlePayment refunds a DUPLICATE automatically', () => {
  const settle = (tt, w, opts = {}) => tt.fulfillment.settlePayment(tt.env, tt.db, { ...row(w) }, { source: 'webhook', ...opts })

  it('inline: refunds the whole amount once and reports QUEUED; the scan is never re-generated and no commission is taken', async () => {
    const w = world(); t = setup(w, {})
    const r = await settle(t, w)
    expect(r.outcome).toBe('DUPLICATE')
    expect(r.ownerPaymentId).toBe('p-first')
    expect(r.autoRefund).toEqual({ status: 'QUEUED', amountCents: 3900 })
    expect(t.state.refunds).toEqual([expect.objectContaining({ ref: 'ref1', currency: 'USD', amount: undefined })])
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.conversions).toHaveLength(0)
    expect(w.t.admin_audit_log[0]).toMatchObject({ action: 'payment.auto_refund_duplicate', actor_id: null, target_id: 'p1' })
    expect(w.t.admin_audit_log[0].detail).toMatchObject({ ownerPaymentId: 'p-first', amountCents: 3900 })
  })

  it('a repeat (verify, recheck, webhook redelivery) while Paystack shows the refund open sends nothing more', async () => {
    const w = world(); t = setup(w, { refundList: { data: [{ status: 'pending', amount: 3900 }] } })
    const r = await settle(t, w)
    expect(r.autoRefund).toMatchObject({ status: 'IN_PROGRESS' })
    expect(t.state.refunds).toHaveLength(0)
  })

  it('...and once it has been processed', async () => {
    const w = world(); row(w).status = 'SUCCESS'
    t = setup(w, { refundList: { data: [{ status: 'processed', amount: 3900 }] } })
    const r = await settle(t, w)
    expect(r.autoRefund).toMatchObject({ status: 'IN_PROGRESS' })
    expect(t.state.refunds).toHaveLength(0)
  })

  it('fails closed: if Paystack\'s refund list cannot be read nothing is sent, and the result says FAILED', async () => {
    console.error = () => {}
    const w = world(); t = setup(w, { listThrows: new Error('paystack down') })
    const r = await settle(t, w)
    expect(r.autoRefund.status).toBe('FAILED')
    expect(r.autoRefund.reason).toContain('paystack down')
    expect(t.state.refunds).toHaveLength(0)
  })

  it('AUTO_REFUND_DUPLICATES=false disables it', async () => {
    const w = world(); t = setup(w, { env: { AUTO_REFUND_DUPLICATES: 'false' } })
    const r = await settle(t, w)
    expect(r.autoRefund).toEqual({ status: 'SKIPPED', reason: 'DISABLED' })
    expect(t.state.refunds).toHaveLength(0)
  })

  it('never refunds when the owning payment cannot be proven (legacy row with no fix_payment_id → ownerPaymentId null)', async () => {
    const w = world({ pays: [
      { id: 'p-first', paystack_ref: 'ref0', scan_id: 's1', user_id: 'u1', status: 'SUCCESS', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX' },
      { id: 'p1', paystack_ref: 'ref1', scan_id: 's1', user_id: 'u1', status: 'PENDING', amount_cents: 3900, currency: 'USD', fix_tier: 'FIX' },
    ] })
    w.t.scans[0].fix_payment_id = null            // purchased before fix_payment_id existed
    t = setup(w, {})
    const r = await settle(t, w)
    // the legacy rule finds another SUCCESS payment, so this one is a DUPLICATE with an UNKNOWN owner
    expect(r.outcome).toBe('DUPLICATE')
    expect(r.autoRefund).toMatchObject({ status: 'SKIPPED', reason: 'NO_OWNER' })
    expect(t.state.refunds).toHaveLength(0)
  })

  it('never refunds when the "owner" payment belongs to a different scan', async () => {
    const w = world(); w.t.payments[0].scan_id = 'other-scan'
    t = setup(w, {})
    const r = await settle(t, w)
    expect(r.autoRefund).toMatchObject({ status: 'SKIPPED', reason: 'OWNER_MISMATCH' })
    expect(t.state.refunds).toHaveLength(0)
  })

  it('a non-duplicate settlement carries no autoRefund and touches no refund API', async () => {
    const w = world({ owned: false }); t = setup(w, {})
    const r = await settle(t, w)
    expect(r.outcome).toBe('FULFILLED')
    expect('autoRefund' in r).toBe(false)
    expect(t.state.refunds).toHaveLength(0)
  })

  it('deferred (the webhook): answers SCHEDULED at once and does the Paystack work in the deferred task', async () => {
    const w = world(); t = setup(w, {})
    const tasks = []
    const r = await settle(t, w, { defer: p => tasks.push(p) })
    expect(r.autoRefund).toEqual({ status: 'SCHEDULED' })
    expect(t.state.refunds).toHaveLength(0)                      // nothing yet — it is behind waitUntil
    await Promise.all(tasks)
    expect(t.state.refunds).toHaveLength(1)
  })

  it('deferred and FAILING: the task itself pages the owner, because nobody is waiting on its result', async () => {
    console.error = () => {}
    const w = world(); t = setup(w, { listThrows: new Error('paystack down') })
    const tasks = []
    await settle(t, w, { defer: p => tasks.push(p) })
    await Promise.all(tasks)
    const a = t.state.alerts.find(x => x.subject.includes('FAILED'))
    expect(a).toBeTruthy()
    expect(a.opts).toEqual({ dedupeKey: 'ref1:autorefund' })
  })

  it('deferred but disabled: reports SKIPPED immediately and schedules nothing harmful', async () => {
    const w = world(); t = setup(w, { env: { AUTO_REFUND_DUPLICATES: 'false' } })
    const tasks = []
    const r = await settle(t, w, { defer: p => tasks.push(p) })
    expect(r.autoRefund).toEqual({ status: 'SKIPPED', reason: 'DISABLED' })
    await Promise.all(tasks)
    expect(t.state.refunds).toHaveLength(0)
  })
})

describe('G1 — notifySettlementProblem wording for a DUPLICATE', () => {
  const dup = (autoRefund) => ({ outcome: 'DUPLICATE', ownerPaymentId: 'p-first', autoRefund })
  it('says no action is needed when the automatic refund is on its way', async () => {
    const w = world(); t = setup(w, {})
    await t.fulfillment.notifySettlementProblem(t.env, dup({ status: 'QUEUED' }), row(w), 'verifyPayment')
    expect(t.state.alerts[0].subject).toContain('automatic refund queued (no action needed)')
  })
  it('asks for a manual refund (with the reason) when the automatic one failed', async () => {
    const w = world(); t = setup(w, {})
    await t.fulfillment.notifySettlementProblem(t.env, dup({ status: 'FAILED', reason: 'HTTP 500' }), row(w), 'verifyPayment')
    expect(t.state.alerts[0].subject).toContain('refund needed')
    expect(t.state.alerts[0].message).toContain('AUTOMATIC refund failed (HTTP 500)')
  })
})

describe('G1 — the buyer\'s refund email for a refunded DUPLICATE', () => {
  it('reversePayment flags a refund of a payment that does NOT own the scan, and leaves the real credential alone', async () => {
    const w = world(); row(w).status = 'SUCCESS'; t = setup(w, {})
    w.t.scans[0].verification_status = 'ACTIVE'; w.t.scans[0].verification_code = 'AB3XY7'
    const r = await t.fulfillment.reversePayment(t.db, { ...row(w) }, { reason: 'REFUND', env: t.env })
    expect(r.transitioned).toBe(true)
    expect(r.revoked).toBe(false)
    expect(t.state.emails).toEqual([expect.objectContaining({ to: 'a@b.c', duplicate: true, verificationRevoked: false })])
    expect(w.t.scans[0].verification_status).toBe('ACTIVE')
  })
  it('a refund of the OWNING payment is not flagged as a duplicate', async () => {
    const w = world(); t = setup(w, {})
    const r = await t.fulfillment.reversePayment(t.db, { ...row(w, 'p-first') }, { reason: 'REFUND', env: t.env })
    expect(r.transitioned).toBe(true)
    expect(t.state.emails[0].duplicate).toBe(false)
  })
})

describe('refund.service.queueRefund', () => {
  function svc(w, o = {}) {
    const state = { created: [] }
    const ps = loadWithStubs('services/refund.service.js', {
      'services/paystack.service.js': {
        listRefunds: async () => { if (o.listThrows) throw o.listThrows; return o.refundList ?? { data: [] } },
        createRefund: async (e, ref, x) => { if (o.rejects) throw Object.assign(new Error('already reversed'), { paystackRejected: true }); state.created.push({ ref, ...x }); return { data: { status: 'pending' } } },
      },
    })
    return { mod: ps.mod, state, restore: ps.restore }
  }
  const pay = () => ({ id: 'p1', paystack_ref: 'ref1', amount_cents: 3900, currency: 'USD' })

  it('queues a full refund without an explicit amount, and a partial leg with one', async () => {
    const w = world(); t = svc(w)
    const full = await t.mod.queueRefund({}, w.db, pay())
    expect(full).toMatchObject({ ok: true, amountCents: 3900, partial: false, completesRefund: true })
    expect(t.state.created[0].amount).toBeUndefined()
    const part = await t.mod.queueRefund({}, w.db, pay(), { amountCents: 1000 })
    expect(part).toMatchObject({ ok: true, amountCents: 1000, partial: true })
    expect(t.state.created[1].amount).toBe(1000)
  })
  it('refuses more than what is left after earlier processed refunds', async () => {
    const w = world(); t = svc(w, { refundList: { data: [{ status: 'processed', amount: 3000 }] } })
    const r = await t.mod.queueRefund({}, w.db, pay(), { amountCents: 1000 })
    expect(r).toMatchObject({ ok: false, code: 'OVER_REMAINING', status: 400 })
  })
  it('maps a Paystack rejection to 409 and an outage to 502', async () => {
    const w = world(); t = svc(w, { rejects: true })
    expect(await t.mod.queueRefund({}, w.db, pay())).toMatchObject({ ok: false, code: 'REJECTED', status: 409 })
    t.restore()
    console.error = () => {}
    const w2 = world(); t = svc(w2, { listThrows: new Error('down') })
    expect(await t.mod.queueRefund({}, w2.db, pay())).toMatchObject({ ok: false, code: 'LIST_FAILED', status: 502 })
  })
  it('autoRefundEnabled defaults ON and only an explicit "false" disables it', () => {
    const w = world(); t = svc(w)
    expect(t.mod.autoRefundEnabled({})).toBe(true)
    expect(t.mod.autoRefundEnabled({ AUTO_REFUND_DUPLICATES: 'true' })).toBe(true)
    expect(t.mod.autoRefundEnabled({ AUTO_REFUND_DUPLICATES: ' False ' })).toBe(false)
  })
})
