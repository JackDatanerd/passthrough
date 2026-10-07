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
  const state = { paymentInserts: [], paymentUpdates: [], alerts: [], rpcCalls: [], verifyCalls: [] }
  const scan = 'scan' in opts
    ? opts.scan
    : { id: 's1', user_id: 'u1', fix_purchased: false, status: 'COMPLETE_PASS', ats_score: 90 }
  const existingPending = 'existingPending' in opts ? opts.existingPending : null

  // Referral codes this scenario knows how to resolve — keyed by the
  // UPPER-CASED code string, same normalization referral.service.js's
  // lookupCode applies before querying. Defaults to "nothing resolves" (every
  // code is treated as invalid/not-found), matching the previous, implicit
  // behavior of every test that doesn't care about referral-code pricing.
  const referralCodes = opts.referralCodes || {}

  const db = createFakeSupabase(q => {
    if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
    if (q.table === 'payments' && q.op === 'select') return { data: existingPending, error: null }
    if (q.table === 'payments' && q.op === 'update') {
      state.paymentUpdates.push({ patch: q.patch, ref: eqValue(q, 'paystack_ref'), status: eqValue(q, 'status') })
      return { data: [{}], error: opts.abandonError || null }
    }
    if (q.table === 'payments' && q.op === 'insert') { state.paymentInserts.push(q.values); return { error: opts.insertError || null } }
    if (q.table === 'referral_codes') return { data: referralCodes[eqValue(q, 'code')] || null, error: null }
    // Usage-limit reservation RPCs (migration 0044) — recorded so tests can
    // assert what was reserved/released; reserve returns opts.reservationId
    // (null by default = "no room left").
    if (q.op === 'rpc') {
      state.rpcCalls.push({ name: q.name, args: q.args })
      if (q.name === 'reserve_referral_code_slot') return { data: opts.reservationId ?? null, error: opts.reserveError || null }
      return { data: null, error: null }
    }
    return undefined
  })

  const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { state.alerts.push({ subject, message }) } },
    'services/paystack.service.js': {
      initializeTransaction: async () => {
        if (opts.paystackThrows) throw opts.paystackThrows
        return { access_code: 'AC_1', authorization_url: 'https://paystack.test/pay/AC_1' }
      },
      // Round 3 (B2): initializePayment now asks Paystack about an earlier PENDING checkout before
      // retiring or resuming it. Default = Paystack says "not paid" ({} -> NOT_PAID).
      isPendingStatus: st => ['ongoing', 'pending', 'processing', 'queued'].includes(st),
      verifyTransaction: async () => {
        state.verifyCalls.push(1)
        if (opts.verifyThrows) throw opts.verifyThrows
        return opts.verifyResult ?? {}
      },
    },
  })

  const env = {}
  const c = (over = {}) => ({
    env,
    get: k => (k === 'user' ? (opts.user ?? { id: 'u1', email: 'a@b.co', emailVerified: true }) : undefined),
    req: { json: async () => (over.body ?? { scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX' }) },
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
  // a code that resolves to a genuinely different price now blocks with a
  // 409 instead of silently charging the stale price.
  //
  // A real, resolvable NEWCODE is used here (not just a different string) —
  // see the "re-audit" tests below for why the comparison has to be against
  // what a code actually RESOLVES to, not the raw string.
  const usableCode = (over = {}) => ({
    active: true, usage_limit: null, uses_so_far: 0, expires_at: null,
    tier_prices: { FIX: 1500 }, partners: { status: 'ACTIVE' }, ...over
  })

  it('does NOT resume a same-tier PENDING row created with a DIFFERENT (resolvable) referral code — blocks with 409', async () => {
    t = setupInit({
      existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', referral_code: 'OLDCODE', created_at: new Date().toISOString() },
      referralCodes: { NEWCODE: usableCode({ code: 'NEWCODE' }) },
    })
    const res = await t.mod.initializePayment(t.c({ body: { scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX', referralCode: 'NEWCODE' } }))
    expect(res.status).toBe(409)
    expect(res.body.data.reference).toBe('fresh-ref')
    expect(t.state.paymentUpdates).toHaveLength(0)
    expect(t.state.paymentInserts).toHaveLength(0)
  })

  it('does NOT resume a same-tier PENDING row created WITHOUT a referral code when a DIFFERENT (resolvable) one is now supplied — blocks with 409', async () => {
    t = setupInit({
      existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', referral_code: null, created_at: new Date().toISOString() },
      referralCodes: { NEWCODE: usableCode({ code: 'NEWCODE' }) },
    })
    const res = await t.mod.initializePayment(t.c({ body: { scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX', referralCode: 'NEWCODE' } }))
    expect(res.status).toBe(409)
  })

  it('DOES resume a same-tier PENDING row when the referral code matches (case/whitespace-insensitive)', async () => {
    t = setupInit({
      existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', referral_code: 'SAMECODE', created_at: new Date().toISOString() },
      referralCodes: { SAMECODE: usableCode({ code: 'SAMECODE' }) },
    })
    const res = await t.mod.initializePayment(t.c({ body: { scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX', referralCode: '  samecode  ' } }))
    expect(res.status).toBe(200)
    expect(res.body.data.reference).toBe('fresh-ref')
    expect(t.state.paymentInserts).toHaveLength(0)
  })

  // AUDIT FIX (Section 3/4 re-audit, bug): the pending row's stored
  // referral_code is a snapshot of the RESOLVED code (referral.service.js's
  // priceForResolvedCode writes null for anything that doesn't actually
  // resolve — invalid, expired, exhausted, wrong partner status). Comparing
  // that against the current request's raw, unresolved string meant
  // resubmitting the exact same invalid/typo'd code twice in a row — nothing
  // about the price actually changed — read as "the code changed" and
  // wrongly blocked a resume that would have charged the identical price.
  describe('re-audit: comparing against the RESOLVED code, not the raw request field', () => {
    it('DOES resume when the SAME unresolvable code is submitted twice (price never actually changed)', async () => {
      t = setupInit({
        // First attempt's code never resolved (typo, expired, whatever) — the
        // stored snapshot is null, exactly like a no-code checkout.
        existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', referral_code: null, created_at: new Date().toISOString() },
        // No referralCodes entry for 'TYPOCODE' — it does not resolve this time either.
      })
      const res = await t.mod.initializePayment(t.c({ body: { scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX', referralCode: 'TYPOCODE' } }))
      expect(res.status).toBe(200)
      expect(res.body.data.reference).toBe('fresh-ref')
      expect(t.state.paymentInserts).toHaveLength(0)
    })

    it('DOES resume when a code that used to resolve no longer does, as long as the request repeats the SAME string (both resolve to standard pricing now)', async () => {
      t = setupInit({
        // Stored snapshot is null because the code had already stopped
        // resolving by the time the first attempt priced it (e.g. it hit its
        // usage limit moments earlier) — same shape as the case above.
        existingPending: { paystack_ref: 'fresh-ref', paystack_access_code: 'fresh-ac', fix_tier: 'FIX', referral_code: null, created_at: new Date().toISOString() },
        referralCodes: { EXPIREDCODE: usableCode({ code: 'EXPIREDCODE', active: false }) },
      })
      const res = await t.mod.initializePayment(t.c({ body: { scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX', referralCode: 'EXPIREDCODE' } }))
      expect(res.status).toBe(200)
      expect(res.body.data.reference).toBe('fresh-ref')
    })
  })
})

// Section 3/4 audit (feature gap, migration 0044): referral-code usage_limit
// is now enforced by an atomic reservation taken BEFORE Paystack is called,
// not just a plain read of uses_so_far.
describe('initializePayment — referral usage-limit reservation', () => {
  const limitedCode = (over = {}) => ({
    id: 'rc1', code: 'LIMITED', active: true, usage_limit: 5, uses_so_far: 0, expires_at: null,
    tier_prices: { FIX: 1500 }, partners: { status: 'ACTIVE' }, ...over
  })
  const body = { scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX', referralCode: 'LIMITED' }
  const rpcNames = () => t.state.rpcCalls.map(r => r.name)

  it('a limited code takes a reservation, charges the discounted price, and stores the reservation on the payment row', async () => {
    t = setupInit({ referralCodes: { LIMITED: limitedCode() }, reservationId: 'res-1' })
    const res = await t.mod.initializePayment(t.c({ body }))
    expect(res.status).toBe(200)
    expect(t.state.rpcCalls[0]).toEqual({ name: 'reserve_referral_code_slot', args: { p_code_id: 'rc1' } })
    expect(t.state.paymentInserts[0]).toMatchObject({
      amount_cents: 1500, referral_code_id: 'rc1', referral_code: 'LIMITED', referral_reservation_id: 'res-1',
    })
  })

  it('when the reservation is denied (lost the race for the last slot) the code is NOT applied — standard price, checkout still succeeds', async () => {
    t = setupInit({ referralCodes: { LIMITED: limitedCode() }, reservationId: null })
    const res = await t.mod.initializePayment(t.c({ body }))
    expect(res.status).toBe(200)
    const ins = t.state.paymentInserts[0]
    expect(ins.amount_cents).toBeGreaterThan(1500)
    expect(ins.referral_code_id).toBeNull()
    expect(ins.referral_code).toBeNull()
    expect('referral_reservation_id' in ins).toBe(false)
  })

  it('a reservation ERROR is treated exactly like a denial (never applies a discount it could not reserve)', async () => {
    t = setupInit({ referralCodes: { LIMITED: limitedCode() }, reserveError: { message: 'function does not exist' } })
    const res = await t.mod.initializePayment(t.c({ body }))
    expect(res.status).toBe(200)
    expect(t.state.paymentInserts[0].referral_code_id).toBeNull()
  })

  it('an UNLIMITED code never touches the reservation RPCs and inserts the pre-0044 row shape', async () => {
    t = setupInit({ referralCodes: { LIMITED: limitedCode({ usage_limit: null }) } })
    const res = await t.mod.initializePayment(t.c({ body }))
    expect(res.status).toBe(200)
    expect(t.state.rpcCalls).toHaveLength(0)
    expect(t.state.paymentInserts[0]).toMatchObject({ amount_cents: 1500, referral_code_id: 'rc1' })
    expect('referral_reservation_id' in t.state.paymentInserts[0]).toBe(false)
  })

  it('no code at all -> no reservation RPC', async () => {
    t = setupInit()
    await t.mod.initializePayment(t.c())
    expect(t.state.rpcCalls).toHaveLength(0)
  })

  it('releases the slot when Paystack initialize fails (no payment row will ever carry it)', async () => {
    t = setupInit({ referralCodes: { LIMITED: limitedCode() }, reservationId: 'res-1', paystackThrows: new Error('boom') })
    const res = await t.mod.initializePayment(t.c({ body }))
    expect(res.status).toBe(502)
    expect(t.state.rpcCalls[1]).toEqual({ name: 'release_referral_code_slot', args: { p_reservation_id: 'res-1' } })
    expect(t.state.paymentInserts).toHaveLength(0)
  })

  it('releases the slot when Paystack REJECTS the request (400 path)', async () => {
    const err = Object.assign(new Error('dup ref'), { paystackRejected: true })
    t = setupInit({ referralCodes: { LIMITED: limitedCode() }, reservationId: 'res-1', paystackThrows: err })
    const res = await t.mod.initializePayment(t.c({ body }))
    expect(res.status).toBe(400)
    expect(rpcNames()).toEqual(['reserve_referral_code_slot', 'release_referral_code_slot'])
  })

  it('releases the slot when the payments insert fails', async () => {
    t = setupInit({ referralCodes: { LIMITED: limitedCode() }, reservationId: 'res-1', insertError: { code: '08006', message: 'down' } })
    const res = await t.mod.initializePayment(t.c({ body }))
    expect(res.status).toBe(502)
    expect(rpcNames()).toEqual(['reserve_referral_code_slot', 'release_referral_code_slot'])
  })

  it('a stale PENDING row that this call abandons has ITS reservation released', async () => {
    const staleCreatedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    t = setupInit({ existingPending: { paystack_ref: 'old-ref', paystack_access_code: 'old-ac', fix_tier: 'FIX', referral_reservation_id: 'old-res', created_at: staleCreatedAt } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(200)
    expect(t.state.rpcCalls).toEqual([{ name: 'release_referral_code_slot', args: { p_reservation_id: 'old-res' } }])
  })

  it('does NOT release when the abandon flip itself failed (row may still be live)', async () => {
    const staleCreatedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    t = setupInit({ existingPending: { paystack_ref: 'old-ref', paystack_access_code: 'old-ac', fix_tier: 'FIX', referral_reservation_id: 'old-res', created_at: staleCreatedAt }, abandonError: { message: 'db hiccup' } })
    await t.mod.initializePayment(t.c())
    expect(t.state.rpcCalls).toHaveLength(0)
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
      get: k => (k === 'user' ? { id: 'u1', email: 'a@b.co', emailVerified: true } : undefined),
      req: { json: async () => (over.body ?? { scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX' }) },
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

  // These three run against the stateful world (declared further down) rather than
  // the bare fake: with a scan that doesn't exist, settlement outcome is now
  // SCAN_MISSING, which verifyPayment reports as 409 needsSupport (B6) instead of
  // the old false success — so a happy-path assertion needs a real scan to land on.
  it('accepts Paystack\'s trxref alias', async () => {
    t = worldSetup()
    const res = await t.mod.verifyPayment(t.c({ query: { trxref: 'ref1' }, params: {} }))
    expect(res.status).toBe(200)
    expect(t.world.t.payments[0].status).toBe('SUCCESS')
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
    t = worldSetup({ payments: [{ id: 'pay1', user_id: 'u1', paystack_ref: 'ref1', status: 'PENDING', amount_cents: 2900, currency: 'KES', scan_id: 's1', fix_tier: 'FIX', referral_code_id: null }] },
      { paystack: { data: { status: 'success', currency: 'KES', amount: 2900 } } })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(200)
    expect(t.world.t.payments[0].status).toBe('SUCCESS')
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
    // The webhook already flipped the row AND claimed the scan (recently — inside the
    // re-enqueue grace window): the buyer's verify call just reports success.
    t = worldSetup()
    t.world.t.payments[0].status = 'SUCCESS'
    Object.assign(t.world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_PURCHASED', updated_at: new Date().toISOString() })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.body.success).toBe(true)
    expect(t.state.queue).toHaveLength(0)
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

// Payments & Pricing round 2 (B6): verifyPayment must not tell a buyer their order
// was fulfilled when nothing was delivered.
describe('verifyPayment — outcomes that delivered nothing (B6)', () => {
  it('SCAN_MISSING answers 409 needsSupport (not a false success), alerts the owner, and generates nothing', async () => {
    t = worldSetup({ scans: [] })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, needsSupport: true, outcome: 'SCAN_MISSING' })
    expect(res.body.message).toContain('ref1')
    expect(t.state.queue).toHaveLength(0)
    expect(t.state.alerts.some(a => /no longer exists/i.test(a.subject))).toBe(true)
  })
  it('ACCOUNT_DELETED answers 409 needsSupport', async () => {
    t = worldSetup({ users: [{ id: 'u1', deleted_at: new Date().toISOString() }] })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, needsSupport: true, outcome: 'ACCOUNT_DELETED' })
  })
  it('NO_SCAN (a payment with no scan attached) answers 409 needsSupport', async () => {
    t = worldSetup(); t.world.t.payments[0].scan_id = null
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.outcome).toBe('NO_SCAN')
  })
  it('a REFUNDED row (late duplicate Paystack success) answers 409 naming the status — never "confirmed"', async () => {
    t = worldSetup(); t.world.t.payments[0].status = 'REFUNDED'
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, needsSupport: true, outcome: 'IGNORED_STATUS' })
    expect(res.body.message).toContain('REFUNDED')
    expect(t.state.queue).toHaveLength(0)
    expect(t.world.t.payments[0].status).toBe('REFUNDED')
  })
  it('a DISPUTED row answers 409 naming the status', async () => {
    t = worldSetup(); t.world.t.payments[0].status = 'DISPUTED'
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.message).toContain('DISPUTED')
  })
  it('DUPLICATE stays a success — the scan IS delivered (by the earlier payment); the refund is the owner\'s job', async () => {
    t = worldSetup()
    Object.assign(t.world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay-first', status: 'FIX_DELIVERED' })
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { scanId: 's1' } })
  })
  it('the happy path is unchanged', async () => {
    t = worldSetup()
    const res = await t.mod.verifyPayment(t.c())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { scanId: 's1' } })
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
  it('Webhooks round 4 (G1): accepting a held payment also closes the HELD webhook-inbox row for it', async () => {
    t = worldSetup({ webhook_events: [
      { id: 'we1', reference: 'ref1', status: 'HELD', note: 'amount/currency mismatch', event_type: 'charge.success' },
      { id: 'we2', reference: 'other', status: 'HELD', note: 'amount/currency mismatch', event_type: 'charge.success' },
    ] }, { paystack: { data: { status: 'success', currency: 'USD', amount: 3100 } } })
    await t.mod.recheckPayment(t.c({ body: { acceptAmountMismatch: true } }))
    const rows = t.world.t.webhook_events
    expect(rows.find(r => r.id === 'we1')).toMatchObject({ status: 'PROCESSED', note: 'resolved — payment is SUCCESS' })
    expect(rows.find(r => r.id === 'we2').status).toBe('HELD')
  })
  it('a recheck that stays held (mismatch not accepted) leaves the HELD inbox row alone', async () => {
    t = worldSetup({ webhook_events: [{ id: 'we1', reference: 'ref1', status: 'HELD', event_type: 'charge.success' }] },
      { paystack: { data: { status: 'success', currency: 'USD', amount: 3100 } } })
    expect((await t.mod.recheckPayment(t.c())).status).toBe(409)
    expect(t.world.t.webhook_events[0].status).toBe('HELD')
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
  const state = { updates: [], rpcs: [] }
  const db = createFakeSupabase(q => {
    if (q.op === 'rpc') { state.rpcs.push({ name: q.name, args: q.args }); return { data: null, error: null } }
    // Round 3 (B2): cancelPayment reads the caller's own PENDING row first, to ask Paystack.
    if (q.table === 'payments' && q.op === 'select')
      return { data: 'pending' in opts ? opts.pending : { id: 'pay1', paystack_ref: 'ref1', user_id: 'u1', scan_id: 's1', status: 'PENDING', amount_cents: 4900, currency: 'USD', fix_tier: 'FIX' }, error: opts.selectError ?? null }
    if (q.table === 'payments' && q.op === 'update') {
      state.updates.push(q)
      return { data: 'updated' in opts ? opts.updated : [{ id: 'pay1' }], error: opts.error ?? null }
    }
  })
  const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/paystack.service.js': {
      isPendingStatus: st => ['ongoing', 'pending', 'processing', 'queued'].includes(st),
      verifyTransaction: async () => {
        state.verifyCalls = (state.verifyCalls || 0) + 1
        if (opts.verifyThrows) throw opts.verifyThrows
        return opts.verifyResult ?? {}
      },
    },
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

  it('releases the cancelled payment\'s referral-code reservation (and only when the cancel actually matched)', async () => {
    t = setupCancel({ updated: [{ id: 'pay1', referral_reservation_id: 'res-9' }] })
    const res = await t.mod.cancelPayment(t.c())
    expect(res.body.success).toBe(true)
    expect(t.state.rpcs).toEqual([{ name: 'release_referral_code_slot', args: { p_reservation_id: 'res-9' } }])
    t.restore()
    t = setupCancel({ updated: [] })
    await t.mod.cancelPayment(t.c())
    expect(t.state.rpcs).toHaveLength(0)
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

// Payments & Pricing pass 1 (G4): pagination, ABANDONED hidden by default,
// fixTier + receiptAvailable in the mapped shape.
describe('getPaymentHistory', () => {
  function setupHistory(rows, { total } = {}) {
    const db = createFakeSupabase(q => (q.table === 'payments' && q.op === 'select'
      ? { data: rows, error: null, count: total ?? rows.length } : undefined))
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = (query = {}) => ({
      env: {}, get: k => (k === 'user' ? { id: 'u1' } : undefined),
      req: { query: k => query[k] },
      json: (body, status = 200) => ({ body, status }),
    })
    return { mod, restore, c, db }
  }

  it('scopes to the requesting user, orders newest-first with id as tie-break, and hides ABANDONED by default', async () => {
    t = setupHistory([])
    await t.mod.getPaymentHistory(t.c())
    const call = t.db.calls.find(c => c.table === 'payments')
    expect(call.filters.find(f => f[0] === 'eq')).toEqual(['eq', 'user_id', 'u1'])
    expect(call.filters.find(f => f[0] === 'neq')).toEqual(['neq', 'status', 'ABANDONED'])
    expect(call.orders).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]])
  })

  it('defaults to page 1 of 20, as a range', async () => {
    t = setupHistory([])
    await t.mod.getPaymentHistory(t.c())
    expect(t.db.calls[0].range).toEqual([0, 19])
  })

  it('honours page/pageSize query params, clamped to sane bounds', async () => {
    t = setupHistory([])
    await t.mod.getPaymentHistory(t.c({ page: '3', pageSize: '10' }))
    expect(t.db.calls[0].range).toEqual([20, 29])
    // pageSize is capped at 50 even if a huge one is requested
    t = setupHistory([])
    await t.mod.getPaymentHistory(t.c({ page: '1', pageSize: '9999' }))
    expect(t.db.calls[0].range).toEqual([0, 49])
  })

  it('includeAbandoned=1 drops the ABANDONED filter', async () => {
    t = setupHistory([])
    await t.mod.getPaymentHistory(t.c({ includeAbandoned: '1' }))
    expect(t.db.calls[0].filters.some(f => f[0] === 'neq')).toBe(false)
  })

  it('maps rows to camelCase, includes fixTier, total and page info, and flags a receiptable row', async () => {
    t = setupHistory([{ id: 'p1', amount_cents: 1900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'r1', created_at: 't1', scan_id: 's1', fix_tier: 'BADGE' }], { total: 37 })
    const res = await t.mod.getPaymentHistory(t.c())
    expect(res.body.data.payments[0]).toEqual({
      id: 'p1', amountCents: 1900, currency: 'USD', status: 'SUCCESS',
      paystackRef: 'r1', createdAt: 't1', scanId: 's1', fixTier: 'BADGE', receiptAvailable: true,
    })
    expect(res.body.data.total).toBe(37)
    expect(res.body.data.page).toBe(1)
    expect(res.body.data.pageSize).toBe(20)
  })

  it('receiptAvailable is false for a free-credit ($0) row and for a non-SUCCESS row', async () => {
    t = setupHistory([
      { id: 'p1', amount_cents: 0, currency: 'USD', status: 'SUCCESS', paystack_ref: 'credit:s1:123', created_at: 't1', scan_id: 's1', fix_tier: 'FIX' },
      { id: 'p2', amount_cents: 1900, currency: 'USD', status: 'PENDING', paystack_ref: 'r2', created_at: 't2', scan_id: 's2', fix_tier: 'FIX' },
    ])
    const res = await t.mod.getPaymentHistory(t.c())
    expect(res.body.data.payments.map(p => p.receiptAvailable)).toEqual([false, false])
  })

  it('propagates a database error', async () => {
    const db = createFakeSupabase(q => (q.table === 'payments' && q.op === 'select' ? { data: null, error: new Error('db down') } : undefined))
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = { env: {}, get: k => (k === 'user' ? { id: 'u1' } : undefined), req: { query: () => undefined }, json: (body, status = 200) => ({ body, status }) }
    await expect(mod.getPaymentHistory(c)).rejects.toThrow('db down')
    restore()
  })
})

// Payments & Pricing pass 1 (G1): admin-issued Paystack refunds.
describe('refundPayment (admin)', () => {
  // `claim` scripts the migration-0048 refund_claimed_at UPDATE: 'ok' (default)
  // wins the claim, 'lost' matches no row (another request holds it),
  // 'missingColumn' is the migration-not-applied error.
  function setupRefund({ payment, existingRefunds = { data: [] }, createRefund, logAdminAction, claim = 'ok', listRefunds } = {}) {
    const state = { logs: [], updates: [], listCalls: 0 }
    const db = createFakeSupabase(q => {
      if (q.table === 'payments' && q.op === 'select') return { data: payment, error: null }
      if (q.table === 'payments' && q.op === 'update') {
        state.updates.push({ patch: q.patch, id: eqValue(q, 'id'), or: q.or })
        if (q.patch && q.patch.refund_claimed_at) {
          if (claim === 'lost') return { data: [], error: null }
          if (claim === 'missingColumn') return { data: null, error: { code: '42703', message: 'column "refund_claimed_at" does not exist' } }
          return { data: [{ id: 'pay1' }], error: null }
        }
        return { data: null, error: null }
      }
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/paystack.service.js': {
        listRefunds: listRefunds || (async () => { state.listCalls++; return existingRefunds }),
        createRefund: createRefund || (async () => ({ status: true, data: { status: 'pending' } })),
      },
      'lib/adminAudit.js': { logAdminAction: async (ctx, sb, action, type, id, meta) => { state.logs.push({ action, type, id, meta }) } },
    })
    const c = (ref = 'ref1', body = {}) => ({
      env: {}, get: () => undefined,
      req: { param: () => ref, json: async () => body },
      json: (b, status = 200) => ({ body: b, status }),
    })
    return { mod, restore, state, db, c }
  }
  const paidPayment = (over = {}) => ({ id: 'pay1', paystack_ref: 'ref1', user_id: 'u1', status: 'SUCCESS', amount_cents: 3900, currency: 'USD', ...over })

  it('queues a full refund, logs the admin action, and leaves our row untouched (the webhook settles it)', async () => {
    t = setupRefund({ payment: paidPayment() })
    const res = await t.mod.refundPayment(t.c())
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toMatchObject({ amountCents: 3900, partial: false })
    expect(t.state.logs[0]).toMatchObject({ action: 'payment.refund_requested', type: 'payment', id: 'pay1' })
  })

  it('a partial amount is passed through and marked partial', async () => {
    let sentAmount
    t = setupRefund({ payment: paidPayment(), createRefund: async (env, ref, opts) => { sentAmount = opts.amount; return { status: true, data: { status: 'pending' } } } })
    const res = await t.mod.refundPayment(t.c('ref1', { amountCents: 1000 }))
    expect(sentAmount).toBe(1000)
    expect(res.body.data.partial).toBe(true)
  })

  it('404s when the payment does not exist', async () => {
    t = setupRefund({ payment: null })
    expect((await t.mod.refundPayment(t.c())).status).toBe(404)
  })

  it('refuses a free-credit ($0) row — nothing was charged', async () => {
    t = setupRefund({ payment: paidPayment({ amount_cents: 0, paystack_ref: 'credit:s1:1' }) })
    const res = await t.mod.refundPayment(t.c())
    expect(res.status).toBe(400)
  })

  it('refuses a payment that is not SUCCESS (e.g. still PENDING)', async () => {
    t = setupRefund({ payment: paidPayment({ status: 'PENDING' }) })
    expect((await t.mod.refundPayment(t.c())).status).toBe(400)
  })

  it('refuses a payment already REFUNDED', async () => {
    t = setupRefund({ payment: paidPayment({ status: 'REFUNDED' }) })
    expect((await t.mod.refundPayment(t.c())).status).toBe(400)
  })

  it('DISPUTED gets a distinct message pointing at Resolve', async () => {
    t = setupRefund({ payment: paidPayment({ status: 'DISPUTED' }) })
    const res = await t.mod.refundPayment(t.c())
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('DISPUTED')
  })

  it('rejects an amountCents greater than what was paid', async () => {
    t = setupRefund({ payment: paidPayment({ amount_cents: 1000 }) })
    expect((await t.mod.refundPayment(t.c('ref1', { amountCents: 2000 }))).status).toBe(400)
  })

  it('blocks with 409 when Paystack already shows an open (pending/processing) refund — never a double-refund', async () => {
    t = setupRefund({ payment: paidPayment(), existingRefunds: { data: [{ status: 'pending', amount: 3900 }] } })
    const res = await t.mod.refundPayment(t.c())
    expect(res.status).toBe(409)
  })

  it('blocks with 409 when Paystack already shows it fully processed', async () => {
    t = setupRefund({ payment: paidPayment(), existingRefunds: { data: [{ status: 'processed', amount: 3900 }] } })
    expect((await t.mod.refundPayment(t.c())).status).toBe(409)
  })

  it('a partial prior refund reduces what is left, and a request over that remainder is rejected', async () => {
    t = setupRefund({ payment: paidPayment(), existingRefunds: { data: [{ status: 'processed', amount: 2000 }] } })
    const res = await t.mod.refundPayment(t.c('ref1', { amountCents: 1900 + 100 }))
    expect(res.status).toBe(400)
  })

  it('fails CLOSED (502, nothing sent) when checking existing refunds itself errors', async () => {
    t = setupRefund({ payment: paidPayment() })
    t.restore(); // rebuild with a throwing listRefunds
    const db = createFakeSupabase(q => {
      if (q.table === 'payments' && q.op === 'select') return { data: paidPayment(), error: null }
      if (q.table === 'payments' && q.op === 'update') return { data: [{ id: 'pay1' }], error: null }   // refund claim won
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/paystack.service.js': { listRefunds: async () => { throw new Error('paystack down') }, createRefund: async () => ({}) },
      'lib/adminAudit.js': { logAdminAction: async () => {} },
    })
    const res = await mod.refundPayment({ env: {}, get: () => undefined, req: { param: () => 'ref1', json: async () => ({}) }, json: (b, s = 200) => ({ body: b, status: s }) })
    expect(res.status).toBe(502)
    restore()
  })

  it('a Paystack-rejected refund (e.g. already reversed) answers 409 with its message, and logs nothing', async () => {
    t = setupRefund({ payment: paidPayment(), createRefund: async () => { const e = new Error('Transaction has been fully reversed'); e.paystackRejected = true; throw e } })
    const res = await t.mod.refundPayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.message).toContain('fully reversed')
    expect(t.state.logs).toHaveLength(0)
  })

  it('a non-rejection Paystack failure (auth/5xx) answers 502, distinct from a rejection', async () => {
    t = setupRefund({ payment: paidPayment(), createRefund: async () => { throw new Error('HTTP 500') } })
    expect((await t.mod.refundPayment(t.c())).status).toBe(502)
  })
})

// Payments & Pricing round 2: B3 (partial vs completing leg), B4 (no free text in
// the audit log), B5 (per-payment refund claim, migration 0048).
describe('refundPayment (admin) — round 2', () => {
  function setupRefund2(o = {}) {
    const state = { logs: [], updates: [], created: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'payments' && q.op === 'select') return { data: o.payment, error: null }
      if (q.table === 'payments' && q.op === 'update') {
        state.updates.push({ patch: q.patch, id: eqValue(q, 'id'), or: q.or })
        if (q.patch && q.patch.refund_claimed_at) {
          if (o.claim === 'lost') return { data: [], error: null }
          if (o.claim === 'missingColumn') return { data: null, error: { code: '42703', message: 'column does not exist' } }
          return { data: [{ id: 'pay1' }], error: null }
        }
        return { data: null, error: null }
      }
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/paystack.service.js': {
        listRefunds: o.listRefunds || (async () => o.existingRefunds || { data: [] }),
        createRefund: o.createRefund || (async (env, ref, opts) => { state.created.push(opts); return { status: true, data: { status: 'pending' } } }),
      },
      'lib/adminAudit.js': { logAdminAction: async (ctx, sb, action, type, id, meta) => { state.logs.push({ action, type, id, meta }) } },
    })
    const c = (body = {}) => ({
      env: {}, get: () => undefined,
      req: { param: () => 'ref1', json: async () => body },
      json: (b, status = 200) => ({ body: b, status }),
    })
    return { mod, restore, state, c }
  }
  const paid = (over = {}) => ({ id: 'pay1', paystack_ref: 'ref1', user_id: 'u1', status: 'SUCCESS', amount_cents: 4900, currency: 'USD', ...over })

  describe('B3 — "partial" is judged on the total AFTER this refund', () => {
    it('a leg that COMPLETES the total (the remainder after earlier processed refunds) is not "partial" and says the sale will be reversed', async () => {
      t = setupRefund2({ payment: paid(), existingRefunds: { data: [{ status: 'processed', amount: 2000 }] } })
      const res = await t.mod.refundPayment(t.c())            // no amount -> the remainder, 2900
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ amountCents: 2900, partial: false })
      expect(res.body.message).toContain('marked REFUNDED')
      expect(res.body.message).not.toContain('stays SUCCESS')
      expect(t.state.created[0].amount).toBe(2900)             // a follow-up leg always states its amount
      expect(t.state.logs[0].meta).toMatchObject({ partial: false, completesRefund: true })
    })
    it('a leg that still leaves money un-refunded IS partial', async () => {
      t = setupRefund2({ payment: paid(), existingRefunds: { data: [{ status: 'processed', amount: 1000 }] } })
      const res = await t.mod.refundPayment(t.c({ amountCents: 1000 }))
      expect(res.body.data.partial).toBe(true)
      expect(res.body.message).toContain('stays SUCCESS')
    })
    it('a first-and-only full refund omits `amount` so Paystack refunds the whole transaction', async () => {
      t = setupRefund2({ payment: paid() })
      const res = await t.mod.refundPayment(t.c())
      expect(res.body.data.partial).toBe(false)
      expect(t.state.created[0].amount).toBeUndefined()
    })
    it('an explicit amount equal to the full payment (nothing refunded yet) is still a full refund', async () => {
      t = setupRefund2({ payment: paid() })
      const res = await t.mod.refundPayment(t.c({ amountCents: 4900 }))
      expect(res.body.data.partial).toBe(false)
    })
  })

  describe('B4 — no admin-typed text in admin_audit_log', () => {
    it('the note goes to Paystack as merchant_note, and the audit row records only THAT a note was given', async () => {
      t = setupRefund2({ payment: paid() })
      await t.mod.refundPayment(t.c({ note: 'refund for jane@example.com, duplicate charge' }))
      expect(t.state.created[0].merchantNote).toBe('refund for jane@example.com, duplicate charge')
      const meta = t.state.logs[0].meta
      expect(meta.hasNote).toBe(true)
      expect(meta).not.toHaveProperty('note')
      expect(JSON.stringify(meta)).not.toContain('jane@example.com')
    })
    it('hasNote is false when none was given', async () => {
      t = setupRefund2({ payment: paid() })
      await t.mod.refundPayment(t.c())
      expect(t.state.logs[0].meta.hasNote).toBe(false)
    })
  })

  describe('B5 — per-payment refund claim (refund_claimed_at)', () => {
    const claimWrites = st => st.updates.filter(u => u.patch && 'refund_claimed_at' in u.patch)

    it('claims atomically: one UPDATE scoped to this payment, only when unclaimed or past the TTL', async () => {
      t = setupRefund2({ payment: paid() })
      await t.mod.refundPayment(t.c())
      const first = claimWrites(t.state)[0]
      expect(first.id).toBe('pay1')
      expect(first.patch.refund_claimed_at).toEqual(expect.any(String))
      expect(first.or[0]).toContain('refund_claimed_at.is.null')
      expect(first.or[0]).toContain('refund_claimed_at.lt.')
    })
    it('a request that loses the claim gets 409 and NEVER touches Paystack (no list, no create)', async () => {
      let listed = 0, created = 0
      t = setupRefund2({ payment: paid(), claim: 'lost',
        listRefunds: async () => { listed++; return { data: [] } },
        createRefund: async () => { created++; return { status: true, data: {} } } })
      const res = await t.mod.refundPayment(t.c())
      expect(res.status).toBe(409)
      expect(res.body.message).toMatch(/just submitted/i)
      expect(listed).toBe(0); expect(created).toBe(0)
      expect(t.state.logs).toHaveLength(0)
    })
    it('two concurrent requests with the same explicit amount queue exactly ONE refund', async () => {
      // A shared claim cell stands in for the row: the first UPDATE wins, the second matches nothing.
      let held = false, created = 0
      const state = { logs: [] }
      const db = createFakeSupabase(q => {
        if (q.table === 'payments' && q.op === 'select') return { data: paid(), error: null }
        if (q.table === 'payments' && q.op === 'update' && q.patch && q.patch.refund_claimed_at) {
          if (held) return { data: [], error: null }
          held = true; return { data: [{ id: 'pay1' }], error: null }
        }
        return undefined
      })
      const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
        'config/supabase.js': { getSupabase: () => db },
        'services/paystack.service.js': {
          listRefunds: async () => { await Promise.resolve(); return { data: [] } },   // both would see "nothing open"
          createRefund: async () => { created++; return { status: true, data: { status: 'pending' } } },
        },
        'lib/adminAudit.js': { logAdminAction: async () => {} },
      })
      t = { restore }
      const mk = () => ({ env: {}, get: () => undefined, req: { param: () => 'ref1', json: async () => ({ amountCents: 1000 }) }, json: (b, s = 200) => ({ body: b, status: s }) })
      const [a, b] = await Promise.all([mod.refundPayment(mk()), mod.refundPayment(mk())])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      expect(created).toBe(1)
    })
    it('the claim is KEPT after a successful queue (Paystack\'s list can lag a just-created refund)', async () => {
      t = setupRefund2({ payment: paid() })
      await t.mod.refundPayment(t.c())
      expect(t.state.updates.filter(u => u.patch && u.patch.refund_claimed_at === null)).toHaveLength(0)
    })
    it('the claim is released at once when Paystack rejects the refund', async () => {
      t = setupRefund2({ payment: paid(), createRefund: async () => { const e = new Error('nope'); e.paystackRejected = true; throw e } })
      const res = await t.mod.refundPayment(t.c())
      expect(res.status).toBe(409)
      expect(t.state.updates.filter(u => u.patch && u.patch.refund_claimed_at === null)).toHaveLength(1)
    })
    it('the claim is released when Paystack fails outright (502)', async () => {
      t = setupRefund2({ payment: paid(), createRefund: async () => { throw new Error('HTTP 500') } })
      expect((await t.mod.refundPayment(t.c())).status).toBe(502)
      expect(t.state.updates.filter(u => u.patch && u.patch.refund_claimed_at === null)).toHaveLength(1)
    })
    it('the claim is released when the existing-refund lookup fails (fails closed AND frees the payment)', async () => {
      t = setupRefund2({ payment: paid(), listRefunds: async () => { throw new Error('paystack down') } })
      expect((await t.mod.refundPayment(t.c())).status).toBe(502)
      expect(t.state.updates.filter(u => u.patch && u.patch.refund_claimed_at === null)).toHaveLength(1)
    })
    it('the claim is released when the open-refund guard blocks it', async () => {
      t = setupRefund2({ payment: paid(), existingRefunds: { data: [{ status: 'pending', amount: 4900 }] } })
      expect((await t.mod.refundPayment(t.c())).status).toBe(409)
      expect(t.state.updates.filter(u => u.patch && u.patch.refund_claimed_at === null)).toHaveLength(1)
    })
    it('an early refusal (not SUCCESS) never even takes the claim', async () => {
      t = setupRefund2({ payment: paid({ status: 'PENDING' }) })
      await t.mod.refundPayment(t.c())
      expect(claimWrites(t.state)).toHaveLength(0)
    })
    it('migration 0048 not applied (column missing): refunds still work, unlocked, with a loud log — and nothing tries to release a claim it never had', async () => {
      const logged = []
      const realErr = console.error; console.error = (...a) => logged.push(a.join(' '))
      try {
        t = setupRefund2({ payment: paid(), claim: 'missingColumn' })
        const res = await t.mod.refundPayment(t.c())
        expect(res.status).toBe(200)
        expect(logged.some(l => /migration 0048/.test(l))).toBe(true)
        expect(t.state.updates.filter(u => u.patch && u.patch.refund_claimed_at === null)).toHaveLength(0)
      } finally { console.error = realErr }
    })
    it('any OTHER error taking the claim propagates (fails closed — no refund is sent)', async () => {
      let created = 0
      const db = createFakeSupabase(q => {
        if (q.table === 'payments' && q.op === 'select') return { data: paid(), error: null }
        if (q.table === 'payments' && q.op === 'update') return { data: null, error: { code: '08006', message: 'conn' } }
        return undefined
      })
      const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
        'config/supabase.js': { getSupabase: () => db },
        'services/paystack.service.js': { listRefunds: async () => ({ data: [] }), createRefund: async () => { created++; return { status: true } } },
        'lib/adminAudit.js': { logAdminAction: async () => {} },
      })
      t = { restore }
      await expect(mod.refundPayment({ env: {}, get: () => undefined, req: { param: () => 'ref1', json: async () => ({}) }, json: (b, s = 200) => ({ body: b, status: s }) })).rejects.toBeTruthy()
      expect(created).toBe(0)
    })
  })
})

// Payments & Pricing pass 1 (G4): in-app receipt resend.
describe('resendPaymentReceipt', () => {
  function setup({ payment, resendResult } = {}) {
    const db = createFakeSupabase(q => (q.table === 'payments' && q.op === 'select' ? { data: payment, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/fulfillment.service.js': { resendReceipt: async () => resendResult ?? { sent: true, reason: null, email: 'a@b.c' } },
    })
    const c = (ref = 'ref1') => ({
      env: {}, get: k => (k === 'user' ? { id: 'u1' } : undefined),
      req: { param: () => ref },
      json: (b, status = 200) => ({ body: b, status }),
    })
    return { mod, restore, c }
  }
  const p = (over = {}) => ({ id: 'pay1', paystack_ref: 'ref1', user_id: 'u1', status: 'SUCCESS', amount_cents: 3900, ...over })

  it('sends and reports the destination email', async () => {
    t = setup({ payment: p() })
    const res = await t.mod.resendPaymentReceipt(t.c())
    expect(res.status).toBe(200)
    expect(res.body.data.email).toBe('a@b.c')
  })
  it('404s on a payment that is not this user\'s (never leaks whether it exists)', async () => {
    t = setup({ payment: p({ user_id: 'someone-else' }) })
    expect((await t.mod.resendPaymentReceipt(t.c())).status).toBe(404)
  })
  it('refuses a free-credit ($0) row and a non-SUCCESS row — a receipt is only for a completed paid purchase', async () => {
    t = setup({ payment: p({ amount_cents: 0, paystack_ref: 'credit:s1:1' }) })
    expect((await t.mod.resendPaymentReceipt(t.c())).status).toBe(400)
    t = setup({ payment: p({ status: 'PENDING' }) })
    expect((await t.mod.resendPaymentReceipt(t.c())).status).toBe(400)
  })
  it('503s with a clear message when the account has no email on file', async () => {
    t = setup({ payment: p(), resendResult: { sent: false, reason: 'NO_EMAIL', email: null } })
    const res = await t.mod.resendPaymentReceipt(t.c())
    expect(res.status).toBe(503)
  })
  it('503s when the send itself fails', async () => {
    t = setup({ payment: p(), resendResult: { sent: false, reason: 'SEND_FAILED', email: null } })
    expect((await t.mod.resendPaymentReceipt(t.c())).status).toBe(503)
  })
})

// SECTION 12 AUDIT (feature gap): reconcile / recheck / resolve are the
// admin-only actions that move real money (or the record of it), and none of
// them left any trace of WHICH admin did it. Each now writes to
// admin_audit_log via lib/adminAudit.js. worldSetup's c() acts as user 'u1'.
describe('admin payment actions — audit trail', () => {
  const audit = w => w.world.t.admin_audit_log || []
  function sold(status = 'SUCCESS') {
    const w = worldSetup()
    Object.assign(w.world.t.payments[0], { status, referral_code_id: 'rc1' })
    Object.assign(w.world.t.scans[0], { fix_purchased: true, fix_payment_id: 'pay1', status: 'FIX_DELIVERED' })
    w.world.t.commission_ledger.push({ id: 'led1', payment_id: 'pay1', partner_id: 'p1', referral_code_id: 'rc1', gross_amount_cents: 2900, commission_rate: 0.2, commission_amount_cents: 580, payout_id: null, reverses_ledger_id: null })
    return w
  }

  it('reverse logs payment.reversed with the reason and what was undone', async () => {
    t = sold()
    await t.mod.resolvePayment(t.c({ body: { action: 'reverse' } }))
    expect(audit(t)).toHaveLength(1)
    expect(audit(t)[0]).toMatchObject({
      actor_id: 'u1', action: 'payment.reversed', target_type: 'payment', target_id: 'pay1',
      detail: { reference: 'ref1', reason: 'REFUND', commissionReversed: true, verificationRevoked: true },
    })
  })
  it('reversing a DISPUTED payment logs reason DISPUTE', async () => {
    t = sold('DISPUTED')
    await t.mod.resolvePayment(t.c({ body: { action: 'reverse' } }))
    expect(audit(t)[0].detail.reason).toBe('DISPUTE')
  })
  it('clear-dispute logs payment.dispute_cleared', async () => {
    t = sold('DISPUTED')
    await t.mod.resolvePayment(t.c({ body: { action: 'clear-dispute' } }))
    expect(audit(t)).toHaveLength(1)
    expect(audit(t)[0]).toMatchObject({ action: 'payment.dispute_cleared', target_id: 'pay1', detail: { reference: 'ref1' } })
  })
  it('a REFUSED resolve (400/404) logs nothing — nothing happened', async () => {
    t = sold('SUCCESS')
    await t.mod.resolvePayment(t.c({ body: { action: 'clear-dispute' } }))          // not DISPUTED → 400
    await t.mod.resolvePayment(t.c({ params: { reference: 'nope' }, body: { action: 'reverse' } })) // 404
    expect(audit(t)).toHaveLength(0)
  })
  it('reconcile logs payment.reconcile with the outcome', async () => {
    t = worldSetup(); t.world.t.payments[0].status = 'SUCCESS'
    await t.mod.reconcilePayment(t.c())
    expect(audit(t)).toHaveLength(1)
    expect(audit(t)[0]).toMatchObject({ action: 'payment.reconcile', target_id: 'pay1', detail: { reference: 'ref1', outcome: 'FULFILLED' } })
  })
  it('reconcile of a non-SUCCESS payment (400) logs nothing', async () => {
    t = worldSetup()   // PENDING
    await t.mod.reconcilePayment(t.c())
    expect(audit(t)).toHaveLength(0)
  })
  it('recheck logs payment.recheck including whether a mismatch was accepted', async () => {
    t = worldSetup({}, { paystack: { data: { status: 'success', currency: 'USD', amount: 3100 } } })
    await t.mod.recheckPayment(t.c())                                             // held (MISMATCH, 409)
    await t.mod.recheckPayment(t.c({ body: { acceptAmountMismatch: true } }))    // accepted
    expect(audit(t)).toHaveLength(2)
    expect(audit(t)[0].detail).toMatchObject({ outcome: 'MISMATCH', acceptAmountMismatch: false })
    expect(audit(t)[1].detail).toMatchObject({ acceptAmountMismatch: true })
  })
  it('a failed audit write never turns a completed reversal into an error', async () => {
    t = sold()
    t.world.failNext('admin_audit_log', 'insert', { message: 'audit table down' })
    const res = await t.mod.resolvePayment(t.c({ body: { action: 'reverse' } }))
    expect(res.body.success).toBe(true)
    expect(t.world.t.payments[0].status).toBe('REFUNDED')
  })
})

// ── Payments & Pricing round 3 ────────────────────────────────────────────────────────────
// B1 history past-the-end · B2 ask Paystack before retiring a PENDING checkout · G1 verified-email
// gate · G3 pending-checkout lookup.
describe('round 3 — payments & pricing', () => {
  const SCAN = '11111111-1111-1111-1111-111111111111'
  const minutesAgo = m => new Date(Date.now() - m * 60 * 1000).toISOString()
  const pendingRow = (over = {}) => ({ id: 'p1', paystack_ref: 'old-ref', paystack_access_code: 'old-ac', fix_tier: 'FIX',
    referral_code: null, scan_id: SCAN, user_id: 'u1', amount_cents: 4900, currency: 'USD', status: 'PENDING', created_at: minutesAgo(45), ...over })

  // Loads the controller with the reconcile/fulfillment seams stubbed so these tests pin the
  // CONTROLLER's decisions (what it asks, what it refuses), not settlement internals.
  function load(resolver, { recheck = async () => ({ outcome: 'NOT_PAID' }), user } = {}) {
    const state = { rechecks: [], problems: [], inits: 0, inserts: 0, updates: [] }
    const db = createFakeSupabase(q => {
      if (q.op === 'insert' && q.table === 'payments') state.inserts++
      if (q.op === 'update' && q.table === 'payments') state.updates.push(q.patch)
      return resolver(q, state)
    })
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/reconcile.service.js': { recheckPayment: async (...a) => { state.rechecks.push(a[2].paystack_ref); return recheck(...a) } },
      'services/fulfillment.service.js': { notifySettlementProblem: async (e, r, p, src) => { state.problems.push({ outcome: r.outcome, src }) } },
      'services/paystack.service.js': { initializeTransaction: async () => { state.inits++; return { access_code: 'AC_NEW', authorization_url: 'u' } }, verifyTransaction: async () => ({}), isPendingStatus: st => ['ongoing', 'pending', 'processing', 'queued'].includes(st) },
    })
    const c = (extra = {}) => ({
      env: {}, get: k => (k === 'user' ? (user ?? { id: 'u1', email: 'a@b.co', emailVerified: true }) : undefined),
      req: { json: async () => ({ scanId: SCAN, fixTier: 'FIX' }), param: () => 'old-ref', query: k => (extra.query || {})[k] },
      json: (body, status = 200) => ({ body, status }),
    })
    return { mod, restore, state, db, c }
  }
  const scanRow = { id: SCAN, user_id: 'u1', fix_purchased: false, status: 'COMPLETE_PASS', ats_score: 90 }
  const initResolver = pending => (q) => {
    if (q.table === 'scans' && q.op === 'select') return { data: scanRow, error: null }
    if (q.table === 'payments' && q.op === 'select') return { data: pending, error: null }
    if (q.table === 'payments' && q.op === 'update') return { data: [{ id: 'p1' }], error: null }
    return undefined
  }

  it('B2: a stale PENDING row Paystack reports as PAID is settled — never abandoned, no second checkout', async () => {
    t = load(initResolver(pendingRow()), { recheck: async () => ({ outcome: 'FULFILLED' }) })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.alreadyPaid).toBe(true)
    expect(res.body.data).toEqual({ paidReference: 'old-ref', scanId: SCAN })
    expect(t.state.rechecks).toEqual(['old-ref'])
    expect(t.state.updates).toHaveLength(0)   // not flipped to ABANDONED
    expect(t.state.inits).toBe(0)             // no new Paystack transaction
    expect(t.state.inserts).toBe(0)
    expect(t.state.problems).toEqual([{ outcome: 'FULFILLED', src: 'checkout-guard' }])
  })

  it('B2: a paid-but-amount-mismatched earlier checkout says it is being checked, and still blocks a second payment', async () => {
    t = load(initResolver(pendingRow()), { recheck: async () => ({ outcome: 'MISMATCH' }) })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/checked by hand/)
    expect(res.body.message).toMatch(/old-ref/)
    expect(t.state.inits).toBe(0)
  })

  it('B2: Paystack says NOT paid → the stale row is abandoned and a fresh checkout proceeds, as before', async () => {
    t = load(initResolver(pendingRow()))
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(200)
    expect(t.state.rechecks).toEqual(['old-ref'])
    expect(t.state.updates).toEqual([{ status: 'ABANDONED' }])
    expect(t.state.inits).toBe(1)
  })

  it('B2: a failed Paystack lookup BLOCKS retiring a stale row (502) — it could have been paid', async () => {
    t = load(initResolver(pendingRow()), { recheck: async () => { throw new Error('paystack down') } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(502)
    expect(t.state.updates).toHaveLength(0)
    expect(t.state.inits).toBe(0)
  })

  it('B2: a failed lookup on a FRESH row still resumes it (Paystack will not charge one access code twice)', async () => {
    t = load(initResolver(pendingRow({ created_at: minutesAgo(5) })), { recheck: async () => { throw new Error('paystack down') } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(200)
    expect(res.body.data.reference).toBe('old-ref')
    expect(t.state.inits).toBe(0)
  })

  it('B2: a stale row Paystack still reports as IN FLIGHT (e.g. mobile money awaiting approval) blocks a new checkout — never abandoned', async () => {
    t = load(initResolver(pendingRow()), { recheck: async () => ({ outcome: 'NOT_PAID', paystackStatus: 'processing' }) })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.inFlight).toBe(true)
    expect(t.state.updates).toHaveLength(0)
    expect(t.state.inits).toBe(0)
    expect(t.state.problems).toHaveLength(0)   // not a settlement problem — nothing to page the owner about
  })

  it('B2: a FRESH row that is in flight is simply resumed', async () => {
    t = load(initResolver(pendingRow({ created_at: minutesAgo(5) })), { recheck: async () => ({ outcome: 'NOT_PAID', paystackStatus: 'ongoing' }) })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(200)
    expect(res.body.data.reference).toBe('old-ref')
    expect(t.state.inits).toBe(0)
  })

  it('B2: cancelPayment refuses while Paystack still reports the checkout in flight', async () => {
    t = load((q) => (q.table === 'payments' && q.op === 'select' ? { data: pendingRow(), error: null } : undefined),
      { recheck: async () => ({ outcome: 'NOT_PAID', paystackStatus: 'queued' }) })
    const res = await t.mod.cancelPayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.inFlight).toBe(true)
    expect(t.state.updates).toHaveLength(0)
  })

  it('B2: cancelPayment settles instead of cancelling when Paystack says the checkout was paid', async () => {
    t = load((q) => (q.table === 'payments' && q.op === 'select' ? { data: pendingRow(), error: null } : undefined),
      { recheck: async () => ({ outcome: 'FULFILLED' }) })
    const res = await t.mod.cancelPayment(t.c())
    expect(res.status).toBe(409)
    expect(res.body.alreadyPaid).toBe(true)
    expect(t.state.updates).toHaveLength(0)
  })

  it('B2: cancelPayment does not cancel when it cannot reach Paystack (502, row untouched)', async () => {
    t = load((q) => (q.table === 'payments' && q.op === 'select' ? { data: pendingRow(), error: null } : undefined),
      { recheck: async () => { throw new Error('timeout') } })
    const res = await t.mod.cancelPayment(t.c())
    expect(res.status).toBe(502)
    expect(t.state.updates).toHaveLength(0)
  })

  it('B2: cancelPayment 404s without calling Paystack when the caller has no such PENDING row', async () => {
    t = load((q) => (q.table === 'payments' && q.op === 'select' ? { data: null, error: null } : undefined))
    const res = await t.mod.cancelPayment(t.c())
    expect(res.status).toBe(404)
    expect(t.state.rechecks).toHaveLength(0)
  })

  it('G1: an unverified account is refused at checkout before ANY lookup or Paystack call', async () => {
    t = load(initResolver(null), { user: { id: 'u1', email: 'a@b.co', emailVerified: false } })
    const res = await t.mod.initializePayment(t.c())
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED')
    expect(t.db.calls).toHaveLength(0)
    expect(t.state.inits).toBe(0)
  })

  it('B1: a history page past the end (PostgREST 416 / PGRST103) answers an empty page with the real total, not a 500', async () => {
    const rangeErr = Object.assign(new Error('Requested range not satisfiable'), { code: 'PGRST103' })
    t = load((q) => {
      if (q.table !== 'payments') return undefined
      return q.selectOpts && q.selectOpts.head ? { data: null, error: null, count: 20 } : { data: null, error: rangeErr, count: null }
    })
    const res = await t.mod.getPaymentHistory(t.c({ query: { page: '2' } }))
    expect(res.status).toBe(200)
    expect(res.body.data.payments).toEqual([])
    expect(res.body.data.total).toBe(20)
    expect(res.body.data.page).toBe(2)
    const head = t.db.calls.find(c => c.selectOpts && c.selectOpts.head)
    expect(head.filters).toEqual(expect.arrayContaining([['eq', 'user_id', 'u1'], ['neq', 'status', 'ABANDONED']]))
  })

  it('B1: a genuine history error is still thrown', async () => {
    t = load((q) => (q.table === 'payments' ? { data: null, error: new Error('db down'), count: null } : undefined))
    await expect(t.mod.getPaymentHistory(t.c())).rejects.toThrow('db down')
  })

  it('G3: getPendingPayment returns the caller\'s fresh PENDING checkout for the scan, scoped to user + scan + PENDING', async () => {
    t = load((q) => (q.table === 'payments' ? { data: pendingRow({ created_at: minutesAgo(5) }), error: null } : undefined))
    const res = await t.mod.getPendingPayment(t.c({ query: { scanId: SCAN } }))
    expect(res.body.data.pending).toMatchObject({ reference: 'old-ref', fixTier: 'FIX', amountCents: 4900, currency: 'USD' })
    expect(t.db.calls[0].filters).toEqual(expect.arrayContaining([['eq', 'user_id', 'u1'], ['eq', 'scan_id', SCAN], ['eq', 'status', 'PENDING']]))
  })

  it('G3: a stale or missing PENDING row is reported as null; a bad scanId is a 400', async () => {
    t = load((q) => (q.table === 'payments' ? { data: pendingRow({ created_at: minutesAgo(45) }), error: null } : undefined))
    expect((await t.mod.getPendingPayment(t.c({ query: { scanId: SCAN } }))).body.data.pending).toBeNull()
    t.restore()
    t = load(() => ({ data: null, error: null }))
    expect((await t.mod.getPendingPayment(t.c({ query: { scanId: SCAN } }))).body.data.pending).toBeNull()
    expect((await t.mod.getPendingPayment(t.c({ query: { scanId: 'nope' } }))).status).toBe(400)
  })
})
