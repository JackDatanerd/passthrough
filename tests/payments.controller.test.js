import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

function setup(opts = {}) {
  const state = { scanUpdates: [], queue: [], alerts: [], verifyCalls: [], ledger: [] }
  const paymentRow = 'paymentRow' in opts ? opts.paymentRow : { user_id: 'u1', amount_cents: 2900, currency: 'USD', scan_id: 's1', fix_tier: 'FIX' }
  const updatedRows = opts.updatedRows ?? [{ id: 'pay1', paystack_ref: 'ref1', fix_tier: 'FIX', scan_id: 's1', referral_code_id: null, amount_cents: 2900 }]

  const db = createFakeSupabase(q => {
    if (q.table === 'payments' && q.op === 'select') return { data: ('fullPayment' in opts && q.cols === '*') ? opts.fullPayment : paymentRow, error: null }
    if (q.table === 'payments' && q.op === 'update') return { data: updatedRows, error: null }
    if (q.table === 'scans' && q.op === 'select') return { data: opts.scan ?? null, error: null }
    if (q.table === 'scans' && q.op === 'update') { state.scanUpdates.push({ patch: q.patch, id: eqValue(q, 'id') }); return { error: opts.scanUpdateError || null } }
    if (q.table === 'referral_codes') return { data: { id: 'rc1', partner_id: 'p1' } }
    if (q.table === 'partners') return { data: { commission_rate: 0.2 } }
    if (q.table === 'commission_ledger') { state.ledger.push(q.values); return { error: opts.ledgerError || null } }
    return undefined
  })

  const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
    'services/paystack.service.js': {
      verifyTransaction: async (env, ref) => {
        state.verifyCalls.push(ref)
        if (opts.verifyThrows) throw opts.verifyThrows
        return opts.paystack ?? { data: { status: 'success', currency: 'USD', amount: 2900, authorization: { authorization_code: 'AUTH_1' } } }
      },
      initializeTransaction: async () => ({ data: {} }),
    },
  })

  const env = { FIX_QUEUE: { send: async m => { if (opts.queueError) throw opts.queueError; state.queue.push(m) } } }
  const c = (over = {}) => ({
    env,
    get: k => (k === 'user' ? { id: 'u1', email: 'a@b.co' } : undefined),
    req: { query: k => (over.query ?? { reference: 'ref1' })[k], param: k => (over.params ?? { reference: 'ref1' })[k] },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, db, c }
}

// Separate, narrower harness for initializePayment — different shape of
// request (req.json() body, not query/param) and a different set of
// payments-table queries (existing-PENDING lookup + insert, not the
// select-then-update-by-reference pattern verifyPayment/reconcilePayment use.
function setupInit(opts = {}) {
  const state = { paymentInserts: [], paymentUpdates: [], alerts: [] }
  const scan = 'scan' in opts
    ? opts.scan
    : { id: 's1', user_id: 'u1', fix_purchased: false, status: 'COMPLETE_PASS', ats_score: 90 }
  const existingPending = 'existingPending' in opts ? opts.existingPending : null

  const db = createFakeSupabase(q => {
    if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
    if (q.table === 'payments' && q.op === 'select') return { data: existingPending, error: null }
    if (q.table === 'payments' && q.op === 'update') {
      state.paymentUpdates.push({ patch: q.patch, ref: eqValue(q, 'paystack_ref'), status: eqValue(q, 'status') })
      return { data: [{}], error: opts.abandonError || null }
    }
    if (q.table === 'payments' && q.op === 'insert') { state.paymentInserts.push(q.values); return { error: opts.insertError || null } }
    return undefined
  })

  const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
    'services/paystack.service.js': {
      initializeTransaction: async () => ({ access_code: 'AC_1', authorization_url: 'https://paystack.test/pay/AC_1' }),
      verifyTransaction: async () => ({}),
    },
  })

  const env = {}
  const c = (over = {}) => ({
    env,
    get: k => (k === 'user' ? { id: 'u1', email: 'a@b.co' } : undefined),
    req: { json: async () => (over.body ?? { scanId: 's1', fixTier: 'FIX' }) },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, db, c }
}

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

describe('initializePayment — stale PENDING cleanup', () => {
  // AUDIT FIX: pay_status_enum defines FAILED/ABANDONED but nothing ever
  // wrote either — a PENDING row that fell out of the 30-minute reuse
  // window used to just sit there forever. These lock in the new behavior:
  // a stale PENDING gets flipped to ABANDONED (best-effort) right before a
  // fresh payment is created for it.

  it('marks a stale (>30min old) PENDING row ABANDONED before creating a new payment', async () => {
    const staleCreatedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    t = setupInit({ existingPending: { paystack_ref: 'old-ref', paystack_access_code: 'old-ac', fix_tier: 'FIX', created_at: staleCreatedAt } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(200)
    expect(t.state.paymentUpdates).toHaveLength(1)
    expect(t.state.paymentUpdates[0]).toEqual({ patch: { status: 'ABANDONED' }, ref: 'old-ref', status: 'PENDING' })
    expect(t.state.paymentInserts).toHaveLength(1)   // fresh checkout still proceeds
  })

  it('does not touch anything when there is no existing PENDING row at all', async () => {
    t = setupInit({ existingPending: null })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(200)
    expect(t.state.paymentUpdates).toHaveLength(0)
    expect(t.state.paymentInserts).toHaveLength(1)
  })

  it('still creates the new payment even if the ABANDONED flip itself fails (best-effort, non-blocking)', async () => {
    const staleCreatedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    t = setupInit({
      existingPending: { paystack_ref: 'old-ref', paystack_access_code: 'old-ac', fix_tier: 'FIX', created_at: staleCreatedAt },
      abandonError: { message: 'db hiccup' },
    })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(200)
    expect(t.state.paymentInserts).toHaveLength(1)
  })

  it('does NOT abandon a still-fresh PENDING row for the same tier — resumes it instead, untouched', async () => {
    t = setupInit({ existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', created_at: new Date().toISOString() } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.body.data.reference).toBe('fresh-ref')
    expect(t.state.paymentUpdates).toHaveLength(0)   // still mid-flight — must not be touched
    expect(t.state.paymentInserts).toHaveLength(0)
  })

  it('does NOT abandon a still-fresh PENDING row for a DIFFERENT tier — blocks with 409, untouched', async () => {
    t = setupInit({ existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'BADGE', created_at: new Date().toISOString() } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(409)
    expect(t.state.paymentUpdates).toHaveLength(0)
    expect(t.state.paymentInserts).toHaveLength(0)
  })
})

describe('verifyPayment', () => {
  it('400s without a reference', async () => {
    t = setup()
    const res = await t.mod.verifyPayment(t.c({ query: {} }))
    expect(res.status).toBe(400)
  })

  it('accepts Paystack\'s trxref alias', async () => {
    t = setup()
    const res = await t.mod.verifyPayment(t.c({ query: { trxref: 'ref1' } }))
    expect(res.status).toBe(200)
  })

  it('404s (and never calls Paystack) for a payment owned by someone else', async () => {
    t = setup({ paymentRow: { user_id: 'someone-else', amount_cents: 2900, currency: 'USD', scan_id: 's1', fix_tier: 'FIX' } })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(404)
    expect(t.state.verifyCalls).toHaveLength(0)
    expect(t.state.queue).toHaveLength(0)
  })

  it('404s for an unknown reference (does not reveal whether it exists)', async () => {
    t = setup({ paymentRow: null })
    expect((await t.mod.verifyPayment(t.c())).status).toBe(404)
  })

  it('502s and alerts the owner when Paystack itself errors', async () => {
    t = setup({ verifyThrows: new Error('Paystack verify returned HTTP 401') })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(502)
    expect(t.state.alerts.some(a => /verify failed/i.test(a.subject))).toBe(true)
  })

  it('400s (no fulfilment) when Paystack says the transaction did not succeed', async () => {
    t = setup({ paystack: { data: { status: 'failed', currency: 'USD', amount: 2900 } } })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(400)
    expect(t.state.queue).toHaveLength(0)
  })

  it('compares currency to what THIS payment was created with, not current env config', async () => {
    t = setup({ paymentRow: { user_id: 'u1', amount_cents: 2900, currency: 'KES', scan_id: 's1', fix_tier: 'FIX' },
      paystack: { data: { status: 'success', currency: 'KES', amount: 2900 } } })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(200)
  })

  it('refuses to fulfil on an amount mismatch, and alerts', async () => {
    t = setup({ paystack: { data: { status: 'success', currency: 'USD', amount: 1 } } })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(400)
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.scanUpdates).toHaveLength(0)
    expect(t.state.alerts.some(a => /amount mismatch/i.test(a.subject))).toBe(true)
  })

  it('fulfils: writes the PAID tier from the payment row to the scan and enqueues', async () => {
    t = setup({ updatedRows: [{ id: 'pay1', paystack_ref: 'ref1', fix_tier: 'BADGE', scan_id: 's1', referral_code_id: null, amount_cents: 2900 }] })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body).toEqual({ success: true, data: { scanId: 's1' } })
    expect(t.state.scanUpdates[0].patch).toEqual({ fix_purchased: true, status: 'FIX_PURCHASED', fix_tier: 'BADGE' })
    expect(t.state.queue).toEqual([{ type: 'generateBadge', scanId: 's1' }])
  })

  it('is idempotent: if the webhook already processed it (0 rows), reports success without re-fulfilling', async () => {
    t = setup({ updatedRows: [] })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body.success).toBe(true)
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.scanUpdates).toHaveLength(0)
  })

  it('a failed fulfilment alerts the owner but does not show the paying customer an error', async () => {
    t = setup({ queueError: new Error('queue down') })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body).toEqual({ success: true, data: { scanId: 's1' } })
    const alert = t.state.alerts.find(a => /fulfillment failed/i.test(a.subject))
    expect(alert.message).toContain('/api/payments/ref1/reconcile')
  })

  it('alerts the owner when the partner commission could not be recorded, but still fulfils', async () => {
    t = setup({ updatedRows: [{ id: 'pay1', paystack_ref: 'ref1', fix_tier: 'FIX', scan_id: 's1', referral_code_id: 'rc1', amount_cents: 2900 }], ledgerError: { code: '08006', message: 'conn' } })
    await t.mod.verifyPayment(t.c())
    expect(t.state.queue).toHaveLength(1)
    expect(t.state.alerts.some(a => /commission/i.test(a.subject))).toBe(true)
  })
})

describe('reconcilePayment (admin recovery)', () => {
  const full = (over = {}) => ({ id: 'pay1', paystack_ref: 'ref1', status: 'SUCCESS', scan_id: 's1', fix_tier: 'FIX', referral_code_id: null, amount_cents: 2900, ...over })

  it('404s for an unknown payment', async () => {
    t = setup({ fullPayment: null })
    expect((await t.mod.reconcilePayment(t.c())).status).toBe(404)
  })
  it('refuses a payment that is not SUCCESS', async () => {
    t = setup({ fullPayment: full({ status: 'PENDING' }) })
    const res = await t.mod.reconcilePayment(t.c())
    expect(res.status).toBe(400)
    expect(t.state.queue).toHaveLength(0)
  })
  it('re-applies the purchase and re-enqueues for a stranded payment', async () => {
    t = setup({ fullPayment: full(), scan: { id: 's1', status: 'COMPLETE_PASS', fix_purchased: false } })
    const res = await t.mod.reconcilePayment(t.c())
    expect(res.body.success).toBe(true)
    expect(t.state.scanUpdates[0].patch).toEqual({ fix_purchased: true, status: 'FIX_PURCHASED', fix_tier: 'FIX' })
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 's1' }])
  })
  it('does not re-enqueue something already delivered — but still retries the commission ledger', async () => {
    t = setup({ fullPayment: full({ referral_code_id: 'rc1' }), scan: { id: 's1', status: 'FIX_DELIVERED', fix_purchased: true } })
    const res = await t.mod.reconcilePayment(t.c())
    expect(res.body.message).toMatch(/already fulfilled/i)
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.ledger).toHaveLength(1)
    expect(res.body.data.conversion).toEqual({ ok: true, recorded: true })
  })
})
