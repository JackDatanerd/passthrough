import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { createWorld } from './helpers/memoryDb.cjs'

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
      isPendingStatus: s => ['ongoing', 'pending', 'processing', 'queued'].includes(s),
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

  // AUDIT FIX (bug): a fresh same-tier PENDING row used to be resumed
  // regardless of referral code — silently reusing whatever price the FIRST
  // attempt was created with, even if the customer applied/changed a
  // referral code afterward and the checkout button was now showing a
  // different price. Same-tier + same-code still resumes; same-tier +
  // different-code now blocks with a 409 instead of silently charging the
  // stale price.
  it('does NOT resume a same-tier PENDING row created with a DIFFERENT referral code — blocks with 409', async () => {
    t = setupInit({
      existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', referral_code: 'OLDCODE', created_at: new Date().toISOString() },
    })
    const res = await t.mod.initializePayment(t.c({ body: { scanId: 's1', fixTier: 'FIX', referralCode: 'NEWCODE' } }))
    expect(res.status).toBe(409)
    expect(res.body.data.reference).toBe('fresh-ref')
    expect(t.state.paymentUpdates).toHaveLength(0)
    expect(t.state.paymentInserts).toHaveLength(0)
  })

  it('does NOT resume a same-tier PENDING row created WITHOUT a referral code when one is now supplied — blocks with 409', async () => {
    t = setupInit({
      existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', referral_code: null, created_at: new Date().toISOString() },
    })
    const res = await t.mod.initializePayment(t.c({ body: { scanId: 's1', fixTier: 'FIX', referralCode: 'NEWCODE' } }))
    expect(res.status).toBe(409)
  })

  it('DOES resume a same-tier PENDING row when the referral code matches (case/whitespace-insensitive)', async () => {
    t = setupInit({
      existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', referral_code: 'SAMECODE', created_at: new Date().toISOString() },
    })
    const res = await t.mod.initializePayment(t.c({ body: { scanId: 's1', fixTier: 'FIX', referralCode: '  samecode  ' } }))
    expect(res.status).toBe(200)
    expect(res.body.data.reference).toBe('fresh-ref')
    expect(t.state.paymentInserts).toHaveLength(0)
  })
})

// AUDIT FIX (Section 3/4 pass, bug): payments_scan_id_pending_uidx (migration
// 0037) turns the SELECT-then-INSERT race at the top of initializePayment
// into a catchable 23505 instead of two live checkouts silently coexisting.
// Needs its own harness (not setupInit above) because the two payments
// SELECTs in a single request must answer differently: the first (before
// Paystack/the insert) finds nothing, the second (after a 23505) finds what
// the concurrent winner just created.
describe('initializePayment — concurrent-insert race (payments_scan_id_pending_uidx)', () => {
  function setupRace(opts = {}) {
    const state = { paymentInserts: [], alerts: [], selectCount: 0 }
    const scan = { id: 's1', user_id: 'u1', fix_purchased: false, status: 'COMPLETE_PASS', ats_score: 90 }

    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'payments' && q.op === 'select') {
        state.selectCount += 1
        // First lookup (before the insert): nothing pending yet. Second
        // lookup (the 23505-recovery re-query): the concurrent winner's row.
        return { data: state.selectCount === 1 ? null : opts.winnerRow, error: null }
      }
      if (q.table === 'payments' && q.op === 'insert') {
        state.paymentInserts.push(q.values)
        return { error: { code: '23505', message: 'duplicate key value violates unique constraint "payments_scan_id_pending_uidx"' } }
      }
      return undefined
    })

    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
      'services/paystack.service.js': {
        initializeTransaction: async () => ({ access_code: 'AC_LOSER', authorization_url: 'https://paystack.test/pay/AC_LOSER' }),
        verifyTransaction: async () => ({}),
      },
    })

    const c = (over = {}) => ({
      env: {},
      get: k => (k === 'user' ? { id: 'u1', email: 'a@b.co' } : undefined),
      req: { json: async () => (over.body ?? { scanId: 's1', fixTier: 'FIX' }) },
      json: (body, status = 200) => ({ body, status }),
    })
    return { mod, restore, state, db, c }
  }

  it('folds a losing concurrent insert into resuming the winner\'s checkout (same tier/code)', async () => {
    t = setupRace({ winnerRow: { paystack_ref: 'winner-ref', paystack_access_code: 'winner-ac', fix_tier: 'FIX', referral_code: null, created_at: new Date().toISOString() } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(200)
    expect(res.body.data.reference).toBe('winner-ref')   // the OTHER request's checkout, not this one's
    expect(t.state.alerts).toHaveLength(0)                // expected conflict, not an outage — no owner page
  })

  it('folds a losing concurrent insert into a 409 when the winner used a different tier', async () => {
    t = setupRace({ winnerRow: { paystack_ref: 'winner-ref', paystack_access_code: 'winner-ac', fix_tier: 'BADGE', referral_code: null, created_at: new Date().toISOString() } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.data.reference).toBe('winner-ref')
    expect(t.state.alerts).toHaveLength(0)
  })

  it('still pages the owner if the 23505 recovery finds no pending row at all (already resolved/expired)', async () => {
    t = setupRace({ winnerRow: null })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(502)
    expect(t.state.alerts).toHaveLength(1)   // genuinely unexplained insert failure — worth paging
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

  // AUDIT FIX (bug): a currency mismatch on an otherwise-SUCCESSFUL payment
  // used to be silently folded into the same branch as a routine declined
  // payment — no [CRITICAL] log, no owner alert, unlike the amount-mismatch
  // case just above. Real money moving in the wrong currency must never be
  // indistinguishable from an ordinary "card declined."
  it('refuses to fulfil on a currency mismatch (status success), and alerts — distinctly from an amount mismatch', async () => {
    t = setup({ paystack: { data: { status: 'success', currency: 'NGN', amount: 2900 } } })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(400)
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.scanUpdates).toHaveLength(0)
    expect(t.state.alerts.some(a => /currency mismatch/i.test(a.subject))).toBe(true)
  })

  it('is idempotent: if the webhook already processed it (0 rows), reports success without re-fulfilling', async () => {
    t = setup({ updatedRows: [] })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body.success).toBe(true)
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.scanUpdates).toHaveLength(0)
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
})

// ── Section 8 audit: settlement/fulfilment now flow through fulfillment.service,
// so these run against the stateful in-memory DB and assert on where the world ENDS UP.

const OLD = new Date(Date.now() - 60 * 60_000).toISOString()

function worldSetup(over = {}, opts = {}) {
  const world = createWorld({
    users: [{ id: 'u1', deleted_at: null }],
    scans: [{ id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false, fix_payment_id: null, updated_at: OLD, verification_code: 'AB3XY7', verification_status: 'ACTIVE' }],
    payments: [{ id: 'pay1', user_id: 'u1', paystack_ref: 'ref1', status: 'PENDING', amount_cents: 2900, currency: 'USD', scan_id: 's1', fix_tier: 'FIX', referral_code_id: null }],
    referral_codes: [{ id: 'rc1', partner_id: 'p1' }],
    partners: [{ id: 'p1', commission_rate: 0.2 }],
    commission_ledger: [],
    ...over,
  })
  world.partialUnique.commission_ledger = [
    { cols: ['payment_id'], where: r => !r.reverses_ledger_id },
    { cols: ['reverses_ledger_id'], where: r => !!r.reverses_ledger_id },
  ]
  const state = { queue: [], alerts: [], verifyCalls: [] }
  const paystack = opts.paystack ?? { data: { status: 'success', currency: 'USD', amount: 2900, authorization: { authorization_code: 'AUTH_1' } } }
  const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
    'services/paystack.service.js': {
      verifyTransaction: async (env, ref) => { state.verifyCalls.push(ref); if (opts.verifyThrows) throw opts.verifyThrows; return paystack },
      initializeTransaction: async () => ({ data: {} }),
      isPendingStatus: s => ['ongoing', 'pending', 'processing', 'queued'].includes(s),
    },
  })
  const env = { FIX_QUEUE: { send: async m => { if (opts.queueError) throw opts.queueError; state.queue.push(m) } } }
  const c = (o = {}) => ({
    env,
    get: k => (k === 'user' ? { id: 'u1', email: 'a@b.co' } : undefined),
    req: {
      query: k => (o.query ?? { reference: 'ref1' })[k],
      param: k => (o.params ?? { reference: 'ref1' })[k],
      json: async () => o.body ?? {},
    },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, world, c }
}

describe('verifyPayment — settlement and fulfilment (fulfillment.service)', () => {
  it('fulfils: claims the scan FOR THIS PAYMENT with the paid tier and enqueues the matching generator', async () => {
    t = worldSetup(); t.world.t.payments[0].fix_tier = 'BADGE'
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body).toEqual({ success: true, data: { scanId: 's1' } })
    expect(t.world.t.payments[0]).toMatchObject({ status: 'SUCCESS', paystack_auth_code: 'AUTH_1' })
    expect(t.world.t.scans[0]).toMatchObject({ fix_purchased: true, fix_tier: 'BADGE', status: 'FIX_PURCHASED', fix_payment_id: 'pay1' })
    expect(t.state.queue).toEqual([{ type: 'generateBadge', scanId: 's1' }])
  })
  it('calling it twice fulfils once', async () => {
    t = worldSetup()
    await t.mod.verifyPayment(t.c()); await t.mod.verifyPayment(t.c())
    expect(t.state.queue).toHaveLength(1)
  })
  it('SELF-HEALING: the webhook flipped the payment but died before fulfilling — the buyer\'s return visit finishes the job', async () => {
    t = worldSetup(); t.world.t.payments[0].status = 'SUCCESS'
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body.success).toBe(true)
    expect(t.world.t.scans[0].fix_payment_id).toBe('pay1')
    expect(t.state.queue).toHaveLength(1)
  })
  it('an ABANDONED checkout (marked by initializePayment\'s stale cleanup) that was really paid is fulfilled', async () => {
    t = worldSetup(); t.world.t.payments[0].status = 'ABANDONED'
    await t.mod.verifyPayment(t.c())
    expect(t.world.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.queue).toHaveLength(1)
  })
  it('a failed fulfilment alerts the owner but does not show the paying customer an error', async () => {
    t = worldSetup({}, { queueError: new Error('queue down') })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body).toEqual({ success: true, data: { scanId: 's1' } })
    const alert = t.state.alerts.find(a => /fulfillment failed/i.test(a.subject))
    expect(alert.message).toContain('/api/payments/ref1/reconcile')
  })
  it('a second payment for an already-purchased scan is not re-generated and earns no commission — the owner is told to refund', async () => {
    t = worldSetup()
    Object.assign(t.world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay-first', status: 'FIX_DELIVERED' })
    t.world.t.payments[0].referral_code_id = 'rc1'
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body.success).toBe(true)
    expect(t.state.queue).toHaveLength(0)
    expect(t.world.t.commission_ledger).toHaveLength(0)
    expect(t.world.t.scans[0].status).toBe('FIX_DELIVERED')
    expect(t.state.alerts.some(a => /Duplicate payment/i.test(a.subject))).toBe(true)
  })
  it('records the partner commission (AFTER fulfilment)', async () => {
    t = worldSetup(); t.world.t.payments[0].referral_code_id = 'rc1'
    await t.mod.verifyPayment(t.c())
    expect(t.state.queue).toHaveLength(1)
    expect(t.world.t.commission_ledger).toHaveLength(1)
    expect(t.world.t.commission_ledger[0]).toMatchObject({ payment_id: 'pay1', commission_amount_cents: 580 })
  })
  it('alerts the owner when the partner commission could not be recorded, but still fulfils', async () => {
    t = worldSetup(); t.world.t.payments[0].referral_code_id = 'rc1'
    t.world.failNext('commission_ledger', 'insert', { code: '08006', message: 'conn' })
    t.world.failNext('commission_ledger', 'insert', { code: '08006', message: 'conn' })
    await t.mod.verifyPayment(t.c())
    expect(t.state.queue).toHaveLength(1)
    expect(t.state.alerts.some(a => /commission/i.test(a.subject))).toBe(true)
  })
})

describe('reconcilePayment (admin recovery) — via fulfillment.service', () => {
  const paid = (over = {}) => ({ status: 'SUCCESS', ...over })
  it('re-applies the purchase and enqueues for a stranded payment', async () => {
    t = worldSetup(); Object.assign(t.world.t.payments[0], paid())
    const res = await t.mod.reconcilePayment(t.c())
    expect(res.body).toMatchObject({ success: true, data: { outcome: 'FULFILLED' } })
    expect(t.world.t.scans[0]).toMatchObject({ fix_purchased: true, fix_payment_id: 'pay1' })
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 's1' }])
  })
  it('does not re-enqueue something already delivered — but still retries the commission ledger', async () => {
    t = worldSetup(); Object.assign(t.world.t.payments[0], paid({ referral_code_id: 'rc1' }))
    Object.assign(t.world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    const res = await t.mod.reconcilePayment(t.c())
    expect(res.body.message).toMatch(/already fulfilled/i)
    expect(t.state.queue).toHaveLength(0)
    expect(t.world.t.commission_ledger).toHaveLength(1)
    expect(res.body.data.conversion).toEqual({ ok: true, recorded: true })
  })
  it('a JOB-LOST scan (claimed, still FIX_PURCHASED) is re-enqueued immediately for an explicit admin reconcile', async () => {
    t = worldSetup(); Object.assign(t.world.t.payments[0], paid())
    Object.assign(t.world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_PURCHASED', updated_at: new Date().toISOString() })
    const res = await t.mod.reconcilePayment(t.c())
    expect(res.body.data.outcome).toBe('REENQUEUED')
    expect(t.state.queue).toHaveLength(1)
  })
  it('a DUPLICATE payment is reported and never re-generated, and earns no commission', async () => {
    t = worldSetup(); Object.assign(t.world.t.payments[0], paid({ referral_code_id: 'rc1' }))
    Object.assign(t.world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay-first', status: 'FIX_DELIVERED' })
    const res = await t.mod.reconcilePayment(t.c())
    expect(res.body.data.outcome).toBe('DUPLICATE')
    expect(t.state.queue).toHaveLength(0)
    expect(t.world.t.commission_ledger).toHaveLength(0)
  })
})

describe('recheckPayment (admin) — PENDING/ABANDONED/FAILED that Paystack says were paid', () => {
  it('asks Paystack, and when the money really arrived settles + delivers', async () => {
    t = worldSetup(); t.world.t.payments[0].status = 'FAILED'
    const res = await t.mod.recheckPayment(t.c())
    expect(res.body.success).toBe(true)
    expect(t.state.verifyCalls).toEqual(['ref1'])
    expect(t.world.t.payments[0].status).toBe('SUCCESS')
    expect(t.state.queue).toHaveLength(1)
  })
  it('409s when Paystack says it was not paid', async () => {
    t = worldSetup({}, { paystack: { data: { status: 'abandoned' } } })
    const res = await t.mod.recheckPayment(t.c())
    expect(res.status).toBe(409)
    expect(t.world.t.payments[0].status).toBe('PENDING')
  })
  it('an amount mismatch is held until the admin explicitly accepts it', async () => {
    t = worldSetup({}, { paystack: { data: { status: 'success', currency: 'USD', amount: 3100 } } })
    expect((await t.mod.recheckPayment(t.c())).status).toBe(409)
    expect(t.state.queue).toHaveLength(0)
    const ok = await t.mod.recheckPayment(t.c({ body: { acceptAmountMismatch: true } }))
    expect(ok.body.success).toBe(true)
    expect(t.state.queue).toHaveLength(1)
  })
  it('a CURRENCY mismatch can never be accepted', async () => {
    t = worldSetup({}, { paystack: { data: { status: 'success', currency: 'NGN', amount: 2900 } } })
    const res = await t.mod.recheckPayment(t.c({ body: { acceptAmountMismatch: true } }))
    expect(res.status).toBe(409)
    expect(t.state.queue).toHaveLength(0)
  })
  it('refuses SUCCESS (use reconcile), REFUNDED and free-credit payments', async () => {
    t = worldSetup(); t.world.t.payments[0].status = 'SUCCESS'
    expect((await t.mod.recheckPayment(t.c())).status).toBe(400)
    t.world.t.payments[0].status = 'REFUNDED'
    expect((await t.mod.recheckPayment(t.c())).status).toBe(400)
    t.world.t.payments[0].status = 'PENDING'; t.world.t.payments[0].paystack_ref = 'credit:s1:1'
    expect((await t.mod.recheckPayment(t.c({ params: { reference: 'credit:s1:1' } }))).status).toBe(400)
  })
  it('502s (and changes nothing) when the Paystack lookup itself fails', async () => {
    t = worldSetup({}, { verifyThrows: new Error('timeout') })
    expect((await t.mod.recheckPayment(t.c())).status).toBe(502)
    expect(t.world.t.payments[0].status).toBe('PENDING')
  })
})

describe('resolvePayment (admin) — reverse a sale / clear a dispute', () => {
  function soldWorld(status = 'SUCCESS') {
    const w = worldSetup()
    Object.assign(w.world.t.payments[0], { status, referral_code_id: 'rc1' })
    Object.assign(w.world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    w.world.t.commission_ledger.push({ id: 'led1', payment_id: 'pay1', partner_id: 'p1', referral_code_id: 'rc1', gross_amount_cents: 2900, commission_rate: 0.2, commission_amount_cents: 580, payout_id: null, reverses_ledger_id: null })
    return w
  }
  it('reverse: payment REFUNDED, commission reversed, credential revoked (reason REFUND)', async () => {
    t = soldWorld()
    const res = await t.mod.resolvePayment(t.c({ body: { action: 'reverse' } }))
    expect(res.body.data).toMatchObject({ transitioned: true, commissionReversed: true, verificationRevoked: true })
    expect(t.world.t.payments[0].status).toBe('REFUNDED')
    expect(t.world.t.scans[0]).toMatchObject({ verification_status: 'REVOKED', verification_revoked_reason: 'REFUND' })
  })
  it('reverse on a DISPUTED payment records reason DISPUTE (a lost chargeback)', async () => {
    t = soldWorld('DISPUTED')
    await t.mod.resolvePayment(t.c({ body: { action: 'reverse' } }))
    expect(t.world.t.scans[0].verification_revoked_reason).toBe('DISPUTE')
  })
  it('reverse is idempotent', async () => {
    t = soldWorld()
    await t.mod.resolvePayment(t.c({ body: { action: 'reverse' } })); await t.mod.resolvePayment(t.c({ body: { action: 'reverse' } }))
    expect(t.world.t.commission_ledger.filter(r => r.reverses_ledger_id)).toHaveLength(1)
  })
  it('clear-dispute puts a DISPUTED payment back to SUCCESS and changes nothing else', async () => {
    t = soldWorld('DISPUTED')
    const res = await t.mod.resolvePayment(t.c({ body: { action: 'clear-dispute' } }))
    expect(res.body.success).toBe(true)
    expect(t.world.t.payments[0].status).toBe('SUCCESS')
    expect(t.world.t.scans[0].verification_status).toBe('ACTIVE')
  })
  it('clear-dispute on a payment that is not DISPUTED is a 400', async () => {
    t = soldWorld('SUCCESS')
    expect((await t.mod.resolvePayment(t.c({ body: { action: 'clear-dispute' } }))).status).toBe(400)
  })
  it('404s for an unknown payment', async () => {
    t = worldSetup()
    expect((await t.mod.resolvePayment(t.c({ params: { reference: 'nope' }, body: { action: 'reverse' } }))).status).toBe(404)
  })
})

// SECTION 12 AUDIT: cancelPayment and getPaymentHistory had zero coverage.
// cancelPayment's whole point is the atomic ownership+status guard baked
// into the UPDATE's WHERE clause, so that's the one worth pinning down —
// not just "happy path 200", but that the filters actually sent to
// supabase are exactly user_id + PENDING, and that a mismatch on either
// (wrong owner, already-settled payment) comes back 404 rather than
// silently touching someone else's row or re-cancelling a real payment.

function setupCancel(opts = {}) {
  const state = { updates: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'payments' && q.op === 'update') {
      state.updates.push(q)
      return { data: 'updated' in opts ? opts.updated : [{ id: 'pay1' }], error: opts.error ?? null }
    }
  })
  const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
  })
  const c = (over = {}) => ({
    env: {},
    get: k => (k === 'user' ? (over.user ?? { id: 'u1' }) : undefined),
    req: { param: () => over.reference ?? 'ref1' },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, c, db }
}

describe('cancelPayment', () => {
  it('cancels by flipping status to ABANDONED, scoped to this reference + this user + PENDING only', async () => {
    t = setupCancel()
    const res = await t.mod.cancelPayment(t.c({ reference: 'ref1', user: { id: 'u1' } }))
    expect(res.body.success).toBe(true)
    const call = t.state.updates[0]
    expect(call.patch).toEqual({ status: 'ABANDONED' })
    expect(call.filters).toEqual(expect.arrayContaining([
      ['eq', 'paystack_ref', 'ref1'], ['eq', 'user_id', 'u1'], ['eq', 'status', 'PENDING'],
    ]))
  })

  it('404s — and never claims success — when nothing matched (wrong owner, already-settled, or unknown reference)', async () => {
    t = setupCancel({ updated: [] })
    const res = await t.mod.cancelPayment(t.c())
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)
  })

  it('404s when updated comes back null rather than an empty array', async () => {
    t = setupCancel({ updated: null })
    const res = await t.mod.cancelPayment(t.c())
    expect(res.status).toBe(404)
  })

  it('propagates a database error', async () => {
    t = setupCancel({ error: new Error('db down') })
    await expect(t.mod.cancelPayment(t.c())).rejects.toThrow('db down')
  })
})

describe('getPaymentHistory', () => {
  function setupHistory(rows) {
    const db = createFakeSupabase(q => (q.table === 'payments' && q.op === 'select' ? { data: rows, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, get: k => (k === 'user' ? { id: 'u1' } : undefined), json: (body, status = 200) => ({ body, status }) }
    return { mod, restore, c, db }
  }

  it('scopes to the requesting user and orders newest-first', async () => {
    t = setupHistory([])
    await t.mod.getPaymentHistory(t.c)
    const call = t.db.calls.find(c => c.table === 'payments')
    expect(call.filters.find(f => f[0] === 'eq')).toEqual(['eq', 'user_id', 'u1'])
    expect(call.orders).toEqual([['created_at', { ascending: false }]])
  })

  it('maps rows to camelCase and includes fixTier', async () => {
    t = setupHistory([{ id: 'p1', amount_cents: 1900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'r1', created_at: 't1', scan_id: 's1', fix_tier: 'BADGE' }])
    const res = await t.mod.getPaymentHistory(t.c)
    expect(res.body.data.payments[0]).toEqual({
      id: 'p1', amountCents: 1900, currency: 'USD', status: 'SUCCESS',
      paystackRef: 'r1', createdAt: 't1', scanId: 's1', fixTier: 'BADGE',
    })
  })

  it('propagates a database error', async () => {
    const db = createFakeSupabase(q => (q.table === 'payments' && q.op === 'select' ? { data: null, error: new Error('db down') } : undefined))
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, get: k => (k === 'user' ? { id: 'u1' } : undefined), json: (body, status = 200) => ({ body, status }) }
    await expect(mod.getPaymentHistory(c)).rejects.toThrow('db down')
    restore()
  })
})
