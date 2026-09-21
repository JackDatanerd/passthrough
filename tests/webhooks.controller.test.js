import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { hmacSha512Hex } from '../src/lib/crypto.js'

const SECRET = 'sk_test_secret'

// Builds a webhook handler wired to a fake DB / queue / mailer and returns a
// `fire(event)` that signs the body like Paystack does and waits for the
// background (waitUntil) work to finish.
function harness(opts = {}) {
  const state = { scanUpdates: [], paymentUpdates: [], queue: [], alerts: [], ledgerInserts: [], kv: new Map() }
  const paymentRow = 'paymentRow' in opts ? opts.paymentRow : { amount_cents: 2900, currency: 'USD' }
  const updatedRows = opts.updatedRows ?? [{ id: 'pay1', paystack_ref: 'ref-1', fix_tier: 'FIX', scan_id: 'scan1', referral_code_id: null, amount_cents: 2900 }]

  const db = createFakeSupabase(q => {
    if (q.table === 'payments' && q.op === 'select') return { data: paymentRow, error: null }
    if (q.table === 'payments' && q.op === 'update') { state.paymentUpdates.push(q.patch); return { data: updatedRows, error: null } }
    if (q.table === 'scans' && q.op === 'update') { state.scanUpdates.push({ patch: q.patch, id: eqValue(q, 'id') }); return { error: opts.scanUpdateError || null } }
    if (q.table === 'referral_codes') return { data: { id: 'rc1', partner_id: 'p1' }, error: null }
    if (q.table === 'partners') return { data: { commission_rate: 0.2 }, error: null }
    if (q.table === 'commission_ledger') { state.ledgerInserts.push(q.values); return { error: opts.ledgerError || null } }
    return undefined
  })

  const { mod, restore } = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message) => { state.alerts.push({ subject, message }); return true } },
  })

  async function fire(event, { signature, kv = true } = {}) {
    const text = typeof event === 'string' ? event : JSON.stringify(event)
    const sig = signature ?? await hmacSha512Hex(SECRET, text)
    const pending = []
    const c = {
      env: {
        PAYSTACK_SECRET_KEY: SECRET,
        FIX_QUEUE: { send: async m => { if (opts.queueError) throw opts.queueError; state.queue.push(m) } },
        ...(kv ? { RATE_LIMIT_KV: { get: async k => state.kv.get(k) ?? null, put: async (k, v) => { state.kv.set(k, v) } } } : {}),
      },
      req: { text: async () => text, header: h => (h === 'x-paystack-signature' ? sig : undefined) },
      executionCtx: { waitUntil: p => pending.push(p) },
      text: (t, s) => ({ text: t, status: s }),
    }
    const res = await mod.handlePaystack(c)
    await Promise.all(pending)
    return res
  }
  return { fire, state, db, restore }
}

const chargeSuccess = (over = {}) => ({
  event: 'charge.success',
  data: { reference: 'ref-1', amount: 2900, currency: 'USD', metadata: { scanId: 'scan1' }, authorization: { authorization_code: 'AUTH_x' }, ...over },
})

let realConsoleError
beforeEach(() => { realConsoleError = console.error; console.error = () => {} })
afterEach(() => { console.error = realConsoleError })

describe('handlePaystack — signature', () => {
  let h
  afterEach(() => h?.restore())

  it('rejects a bad signature with 401 and touches nothing', async () => {
    h = harness()
    const res = await h.fire(chargeSuccess(), { signature: 'deadbeef' })
    expect(res.status).toBe(401)
    expect(h.db.calls).toHaveLength(0)
    expect(h.state.queue).toHaveLength(0)
  })

  it('rejects a missing signature', async () => {
    h = harness()
    const res = await h.fire(chargeSuccess(), { signature: '' })
    expect(res.status).toBe(401)
  })

  it('emails the owner about a signature mismatch only ONCE per cooldown window', async () => {
    h = harness()
    await h.fire(chargeSuccess(), { signature: 'bad1' })
    await h.fire(chargeSuccess(), { signature: 'bad2' })
    await h.fire(chargeSuccess(), { signature: 'bad3' })
    expect(h.state.alerts.filter(a => /signature mismatch/i.test(a.subject))).toHaveLength(1)
  })

  it('answers 200 to an unparseable body (so Paystack does not retry forever)', async () => {
    h = harness()
    const res = await h.fire('not json{{')
    expect(res.status).toBe(200)
  })
})

describe('handlePaystack — fulfillment', () => {
  let h
  afterEach(() => h?.restore())

  // REGRESSION: `fix_tier,` (undefined variable) instead of `fix_tier: fixTier`
  // threw a ReferenceError here. The payment was already SUCCESS, so nothing
  // retried and the customer never received their fix.
  it('marks the scan FIX_PURCHASED with the paid tier and enqueues generateFix', async () => {
    h = harness()
    const res = await h.fire(chargeSuccess())
    expect(res.status).toBe(200)
    expect(h.state.scanUpdates).toHaveLength(1)
    expect(h.state.scanUpdates[0].patch).toEqual({ fix_purchased: true, fix_tier: 'FIX', status: 'FIX_PURCHASED' })
    expect(h.state.scanUpdates[0].id).toBe('scan1')
    expect(h.state.queue).toEqual([{ type: 'generateFix', scanId: 'scan1' }])
    expect(h.state.alerts).toHaveLength(0)     // no "fulfillment failed" alert on the happy path
  })

  it('a BADGE payment enqueues generateBadge and stores fix_tier BADGE', async () => {
    h = harness({ updatedRows: [{ id: 'pay1', fix_tier: 'BADGE', scan_id: 'scan1', referral_code_id: null, amount_cents: 2900 }] })
    await h.fire(chargeSuccess())
    expect(h.state.scanUpdates[0].patch.fix_tier).toBe('BADGE')
    expect(h.state.queue).toEqual([{ type: 'generateBadge', scanId: 'scan1' }])
  })

  it('defaults a missing fix_tier on the payment row to FIX', async () => {
    h = harness({ updatedRows: [{ id: 'pay1', fix_tier: null, scan_id: 'scan1', referral_code_id: null, amount_cents: 2900 }] })
    await h.fire(chargeSuccess())
    expect(h.state.scanUpdates[0].patch.fix_tier).toBe('FIX')
  })

  it('trusts the payment ROW scan_id over the event metadata scanId', async () => {
    h = harness({ updatedRows: [{ id: 'pay1', fix_tier: 'FIX', scan_id: 'scan-from-row', referral_code_id: null, amount_cents: 2900 }] })
    await h.fire(chargeSuccess({ metadata: { scanId: 'scan-from-metadata' } }))
    expect(h.state.scanUpdates[0].id).toBe('scan-from-row')
    expect(h.state.queue[0].scanId).toBe('scan-from-row')
  })

  it('flips the payment with an atomic PENDING -> SUCCESS update keyed on the reference', async () => {
    h = harness()
    await h.fire(chargeSuccess())
    const upd = h.db.calls.find(q => q.table === 'payments' && q.op === 'update')
    expect(eqValue(upd, 'paystack_ref')).toBe('ref-1')
    expect(eqValue(upd, 'status')).toBe('PENDING')
    expect(upd.patch.status).toBe('SUCCESS')
    expect(upd.patch.paystack_auth_code).toBe('AUTH_x')
  })

  it('is idempotent: an already-processed payment (0 rows updated) fulfils nothing', async () => {
    h = harness({ updatedRows: [] })
    const res = await h.fire(chargeSuccess())
    expect(res.status).toBe(200)
    expect(h.state.scanUpdates).toHaveLength(0)
    expect(h.state.queue).toHaveLength(0)
  })

  it('does NOT fulfil, and alerts the owner, when the amount does not match the payment row', async () => {
    h = harness()
    await h.fire(chargeSuccess({ amount: 100 }))
    expect(h.state.paymentUpdates).toHaveLength(0)
    expect(h.state.queue).toHaveLength(0)
    expect(h.state.alerts.some(a => /mismatch/i.test(a.subject))).toBe(true)
  })

  it('does NOT fulfil on a currency mismatch', async () => {
    h = harness()
    await h.fire(chargeSuccess({ currency: 'KES' }))
    expect(h.state.queue).toHaveLength(0)
  })

  it('ignores a reference with no payment row', async () => {
    h = harness({ paymentRow: null })
    await h.fire(chargeSuccess())
    expect(h.state.queue).toHaveLength(0)
    expect(h.state.paymentUpdates).toHaveLength(0)
  })

  it('ignores events without a reference or scanId', async () => {
    h = harness()
    await h.fire({ event: 'charge.success', data: { amount: 2900, currency: 'USD', metadata: {} } })
    expect(h.db.calls).toHaveLength(0)
  })

  it('ignores unrelated event types', async () => {
    h = harness()
    const res = await h.fire({ event: 'transfer.success', data: {} })
    expect(res.status).toBe(200)
    expect(h.state.queue).toHaveLength(0)
  })
})

describe('handlePaystack — failure handling', () => {
  let h
  afterEach(() => h?.restore())

  it('alerts the owner (does not throw) when the scan update fails after the payment flip', async () => {
    h = harness({ scanUpdateError: new Error('db down') })
    const res = await h.fire(chargeSuccess())
    expect(res.status).toBe(200)
    expect(h.state.queue).toHaveLength(0)
    const alert = h.state.alerts.find(a => /fulfillment failed/i.test(a.subject))
    expect(alert).toBeTruthy()
    expect(alert.message).toContain('/api/payments/ref-1/reconcile')
  })

  it('alerts the owner when the queue send fails', async () => {
    h = harness({ queueError: new Error('queue unavailable') })
    await h.fire(chargeSuccess())
    expect(h.state.alerts.some(a => /fulfillment failed/i.test(a.subject))).toBe(true)
  })

  it('alerts the owner when the partner commission could not be recorded, but still fulfils', async () => {
    h = harness({
      updatedRows: [{ id: 'pay1', paystack_ref: 'ref-1', fix_tier: 'FIX', scan_id: 'scan1', referral_code_id: 'rc1', amount_cents: 2900 }],
      ledgerError: { code: '08006', message: 'connection failure' },
    })
    await h.fire(chargeSuccess())
    expect(h.state.queue).toHaveLength(1)                                   // customer still gets their fix
    expect(h.state.alerts.some(a => /commission/i.test(a.subject))).toBe(true)
  })

  it('records the commission ledger row on a referred sale (20% of the charged amount)', async () => {
    h = harness({ updatedRows: [{ id: 'pay1', fix_tier: 'FIX', scan_id: 'scan1', referral_code_id: 'rc1', amount_cents: 2900 }] })
    await h.fire(chargeSuccess())
    expect(h.state.ledgerInserts).toHaveLength(1)
    expect(h.state.ledgerInserts[0].commission_amount_cents).toBe(580)
    expect(h.state.alerts).toHaveLength(0)
  })
})

describe('handlePaystack — disputes and refunds', () => {
  let h
  afterEach(() => h?.restore())

  it('alerts the owner on a dispute and does not fulfil or revoke anything', async () => {
    h = harness()
    const res = await h.fire({ event: 'charge.dispute.create', data: { reference: 'ref-1' } })
    expect(res.status).toBe(200)
    expect(h.state.alerts.some(a => /charge\.dispute/i.test(a.subject))).toBe(true)
    expect(h.state.queue).toHaveLength(0)
    expect(h.state.scanUpdates).toHaveLength(0)
  })

  it('alerts the owner on a refund event', async () => {
    h = harness()
    await h.fire({ event: 'refund.processed', data: { reference: 'ref-1' } })
    expect(h.state.alerts.some(a => /refund/i.test(a.subject))).toBe(true)
  })
})
