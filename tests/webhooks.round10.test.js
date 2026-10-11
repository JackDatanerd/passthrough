import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { hmacSha512Hex } from '../src/lib/crypto.js'

// Webhooks round 10 (Section 8, independent pass): dispute sweep (G1/B4), chargeback reversal in the reversal
// sweep (G2), previous-secret verification (G3), unreadable signed body (G4), allowlist matching (B2),
// out-of-range inbox page (B3), deferred partner notice (B1), HELD is not "recovered" (B5).

const SECRET = 'sk_live_new'
const OLD_SECRET = 'sk_live_old'
let realConsoleError
beforeEach(() => { realConsoleError = console.error; console.error = () => {} })
afterEach(() => { console.error = realConsoleError })

function webhookMod(world, { disputes = [], listError = null } = {}) {
  const state = { alerts: [], kv: new Map(), listCalls: 0 }
  const { mod, restore } = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message, opts) => { state.alerts.push({ subject, message, opts }); return true },
      sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': {
      listRefunds: async () => ({ data: [] }),
      listDisputes: async () => { state.listCalls++; if (listError) throw listError; return { data: disputes } },
    },
  })
  return { mod, restore, state }
}
const env = state => ({ PAYSTACK_SECRET_KEY: SECRET, RATE_LIMIT_KV: { get: async k => state.kv.get(k) ?? null, put: async (k, v) => { state.kv.set(k, v) } } })

describe('sweepDisputes (G1 / B4)', () => {
  const dispute = (over = {}) => ({ id: 900, status: 'awaiting-merchant-feedback', resolution: null, refund_amount: 2900, due_at: new Date(Date.now() + 10 * 3600_000).toISOString(), transaction: { reference: 'ref-1', amount: 2900, currency: 'USD' }, ...over })
  const world = status => createWorld({
    payments: [{ id: 'pay1', paystack_ref: 'ref-1', status, amount_cents: 2900, currency: 'USD', scan_id: 'scan1', fix_tier: 'FIX', user_id: 'u1' }],
    scans: [{ id: 'scan1', user_id: 'u1', fix_payment_id: 'pay1', verification_code: 'AB3XY7', verification_status: 'ACTIVE' }],
    webhook_events: [], commission_ledger: [],
  })
  let m
  afterEach(() => m?.restore())

  it('marks a SUCCESS payment DISPUTED when an unresolved Paystack dispute was never delivered, and pages the owner', async () => {
    const w = world('SUCCESS'); m = webhookMod(w, { disputes: [dispute()] })
    const r = await m.mod.sweepDisputes(env(m.state), null, w.db)
    expect(r.actioned).toHaveLength(1)
    expect(w.t.payments[0].status).toBe('DISPUTED')
    expect(m.state.alerts.some(a => /dispute\.create/.test(a.subject))).toBe(true)
    expect(m.state.alerts.some(a => /Dispute sweep/.test(a.subject))).toBe(true)
  })
  it('does nothing — and sends nothing — when the payment is already DISPUTED (a healthy system)', async () => {
    const w = world('DISPUTED'); m = webhookMod(w, { disputes: [dispute()] })
    const r = await m.mod.sweepDisputes(env(m.state), null, w.db)
    expect(r.actioned).toHaveLength(0)
    expect(m.state.alerts).toHaveLength(0)
  })
  it('a lost ACCEPTED resolution reverses the sale (REFUNDED, credential revoked)', async () => {
    const w = world('DISPUTED'); m = webhookMod(w, { disputes: [dispute({ status: 'resolved', resolution: 'merchant-accepted' })] })
    const r = await m.mod.sweepDisputes(env(m.state), null, w.db)
    expect(r.actioned).toHaveLength(1)
    expect(w.t.payments[0].status).toBe('REFUNDED')
    expect(w.t.scans[0].verification_status).toBe('REVOKED')
  })
  it('a lost DECLINED resolution puts a DISPUTED payment back to SUCCESS (B4: the create/resolve race)', async () => {
    const w = world('DISPUTED'); m = webhookMod(w, { disputes: [dispute({ status: 'resolved', resolution: 'declined' })] })
    await m.mod.sweepDisputes(env(m.state), null, w.db)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('records what it handled in the inbox, so a LATE real dispute.create cannot re-mark a payment the sweep cleared', async () => {
    const w = world('DISPUTED'); w.unique.webhook_events = [['provider', 'event_key']]
    m = webhookMod(w, { disputes: [dispute({ status: 'resolved', resolution: 'declined' })] })
    await m.mod.sweepDisputes(env(m.state), null, w.db)
    expect(w.t.payments[0].status).toBe('SUCCESS')
    const row = w.t.webhook_events.find(r => r.event_key === 'charge.dispute.resolve:900')
    expect(row && row.status).toBe('PROCESSED')
    // the late create now finds the resolution already processed
    const late = { event: 'charge.dispute.create', data: dispute({ status: 'awaiting-merchant-feedback' }) }
    const bytes = new TextEncoder().encode(JSON.stringify(late))
    const hdr = { 'x-paystack-signature': await hmacSha512Hex(SECRET, bytes) }
    const c = { env: env(m.state), req: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), header: h => hdr[h.toLowerCase()] },
      executionCtx: { waitUntil() {} }, text: (t, s) => ({ text: t, status: s }) }
    await m.mod.handlePaystack(c)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('a declined dispute on a payment that is already SUCCESS is left alone (no hourly re-run)', async () => {
    const w = world('SUCCESS'); m = webhookMod(w, { disputes: [dispute({ status: 'resolved', resolution: 'declined' })] })
    expect((await m.mod.sweepDisputes(env(m.state), null, w.db)).actioned).toHaveLength(0)
  })
  it('a PARTIAL accepted dispute and an unrecognised resolution are left for a human (never re-emailed hourly)', async () => {
    const w = world('DISPUTED'); m = webhookMod(w, { disputes: [dispute({ status: 'resolved', resolution: 'merchant-accepted', refund_amount: 1000 }), dispute({ id: 901, status: 'resolved', resolution: 'weird' })] })
    expect((await m.mod.sweepDisputes(env(m.state), null, w.db)).actioned).toHaveLength(0)
    expect(w.t.payments[0].status).toBe('DISPUTED')
  })
  it('ignores disputes for transactions that are not this app\'s payments', async () => {
    const w = world('SUCCESS'); m = webhookMod(w, { disputes: [dispute({ transaction: { reference: 'someone-else', amount: 100 } })] })
    expect((await m.mod.sweepDisputes(env(m.state), null, w.db)).actioned).toHaveLength(0)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('a failed Paystack list is reported in `error`, never thrown', async () => {
    const w = world('SUCCESS'); m = webhookMod(w, { listError: new Error('Paystack dispute list returned HTTP 500') })
    const r = await m.mod.sweepDisputes(env(m.state), null, w.db)
    expect(r.error).toMatch(/HTTP 500/)
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('does not call Paystack without a secret', async () => {
    const w = world('SUCCESS'); m = webhookMod(w, { disputes: [dispute()] })
    await m.mod.sweepDisputes({}, null, w.db)
    expect(m.state.listCalls).toBe(0)
  })
})

describe('handlePaystack — previous secret (G3), unreadable body (G4), allowlist (B2)', () => {
  let m
  afterEach(() => m?.restore())
  async function fire(rawBody, { secret = SECRET, headers = {}, envOver = {} } = {}) {
    const w = createWorld({ webhook_events: [], payments: [] })
    w.unique.webhook_events = [['provider', 'event_key']]
    m = webhookMod(w)
    const bytes = new TextEncoder().encode(rawBody)
    const hdr = { 'x-paystack-signature': await hmacSha512Hex(secret, bytes), ...headers }
    const pending = []
    const c = { env: { ...env(m.state), ...envOver }, req: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), header: h => hdr[h.toLowerCase()] },
      executionCtx: { waitUntil: p => pending.push(p) }, text: (t, s) => ({ text: t, status: s }) }
    const res = await m.mod.handlePaystack(c); await Promise.all(pending)
    return { res, w, state: m.state }
  }
  const ev = JSON.stringify({ event: 'transfer.success', data: { id: 5 } })

  it('a delivery signed with the PREVIOUS key verifies while it is configured, and is refused when it is not', async () => {
    expect((await fire(ev, { secret: OLD_SECRET, envOver: { PAYSTACK_SECRET_KEY_PREVIOUS: OLD_SECRET } })).res.status).toBe(200)
    expect((await fire(ev, { secret: OLD_SECRET })).res.status).toBe(401)
  })
  it('a wrong key is still refused with a previous key configured', async () => {
    expect((await fire(ev, { secret: 'sk_other', envOver: { PAYSTACK_SECRET_KEY_PREVIOUS: OLD_SECRET } })).res.status).toBe(401)
  })
  it('a signed body that is not an event is acknowledged but alerted (once a day)', async () => {
    const a = await fire('not json at all')
    expect(a.res.status).toBe(200)
    expect(a.state.alerts.some(x => /cannot read/.test(x.subject))).toBe(true)
    const b = await fire(JSON.stringify({ nope: 1 }))
    expect(b.res.status).toBe(200)
  })
  it('the allowlist is address-aware: brackets / upper-case IPv6 / IPv4-mapped forms match; others do not', async () => {
    const list = '52.31.139.75, [2001:DB8::1]'
    expect((await fire(ev, { headers: { 'cf-connecting-ip': '52.31.139.75' }, envOver: { PAYSTACK_WEBHOOK_IPS: list } })).res.status).toBe(200)
    expect((await fire(ev, { headers: { 'cf-connecting-ip': '2001:db8::1' }, envOver: { PAYSTACK_WEBHOOK_IPS: list } })).res.status).toBe(200)
    expect((await fire(ev, { headers: { 'cf-connecting-ip': '::ffff:52.31.139.75' }, envOver: { PAYSTACK_WEBHOOK_IPS: list } })).res.status).toBe(200)
    expect((await fire(ev, { headers: { 'cf-connecting-ip': '6.6.6.6' }, envOver: { PAYSTACK_WEBHOOK_IPS: list } })).res.status).toBe(403)
    expect((await fire(ev, { headers: {}, envOver: { PAYSTACK_WEBHOOK_IPS: list } })).res.status).toBe(403)
  })
})

describe('listWebhookEvents — out-of-range page (B3)', () => {
  it('answers an empty page, not a 500', async () => {
    const w = createWorld({ webhook_events: [] })
    const m = webhookMod(w)
    w.failNext('webhook_events', 'select', { code: 'PGRST103', message: 'Requested range not satisfiable' })
    const c = { env: {}, req: { query: k => ({ page: '99' }[k]) }, json: (b, s) => ({ body: b, status: s || 200 }) }
    const res = await m.mod.listWebhookEvents(c)
    m.restore()
    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual([])
    expect(res.body.meta.page).toBe(99)
  })
})

describe('redriveStaleEvents — HELD is not "recovered" (B5)', () => {
  it('a re-run that ends HELD is re-driven but not announced as recovered', async () => {
    const OLD = new Date(Date.now() - 3 * 3600_000).toISOString()
    const w = createWorld({
      payments: [{ id: 'pay1', paystack_ref: 'ref-1', status: 'PENDING', amount_cents: 2900, currency: 'USD', scan_id: 'scan1' }],
      scans: [{ id: 'scan1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false }],
      webhook_events: [{ id: 'ev1', provider: 'paystack', event_key: 'charge.success:1', event_type: 'charge.success', reference: 'ref-1', status: 'FAILED', attempts: 2, redrives: 0, received_at: OLD,
        payload: { event: 'charge.success', data: { id: 1, reference: 'ref-1', amount: 9999, currency: 'USD' } } }],
    })
    const m = webhookMod(w)
    const r = await m.mod.redriveStaleEvents({ PAYSTACK_SECRET_KEY: SECRET }, { waitUntil() {} })
    m.restore()
    expect(r.redriven).toEqual(['ev1'])
    expect(r.recovered).toHaveLength(0)
    expect(w.t.webhook_events[0].status).toBe('HELD')
  })
})

describe('reconcile.service sweepReversedPayments — chargeback (G2)', () => {
  const NOW = Date.now()
  function rig(status, refunds = []) {
    const world = createWorld({
      payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: 's1', status, amount_cents: 2900, currency: 'USD', created_at: new Date(NOW - 86400_000).toISOString(), last_reconciled_at: null }],
      scans: [{ id: 's1', user_id: 'u1', fix_payment_id: 'p1', verification_code: 'AB3XY7', verification_status: 'ACTIVE' }], commission_ledger: [],
    })
    const alerts = []
    const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
      'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { alerts.push({ subject, message }) } },
      'services/paystack.service.js': { verifyTransaction: async () => ({ data: { status: 'reversed' } }), listRefunds: async () => ({ data: refunds }) },
      'services/referral.service.js': { recordConversion: async () => ({ ok: true }) },
    })
    return { world, alerts, restore, run: () => mod.sweepReversedPayments({ RATE_LIMIT_KV: null }, world.db, { now: NOW }) }
  }
  it('a DISPUTED payment Paystack calls reversed with NO refunds is a lost dispute: reversed, credential revoked', async () => {
    const r = rig('DISPUTED'); const out = await r.run(); r.restore()
    expect(out.reversed).toHaveLength(1)
    expect(r.world.t.payments[0].status).toBe('REFUNDED')
    expect(r.world.t.scans[0].verification_revoked_reason).toBe('DISPUTE')
    expect(r.alerts.some(a => /CHARGED BACK/.test(a.message))).toBe(true)
  })
  it('a SUCCESS payment reversed with no refunds is still only reported (the dispute sweep owns it)', async () => {
    const r = rig('SUCCESS'); const out = await r.run(); r.restore()
    expect(out.reversed).toHaveLength(0)
    expect(out.partial).toHaveLength(1)
    expect(r.world.t.payments[0].status).toBe('SUCCESS')
  })
  it('a DISPUTED payment with a PARTIAL refund is still not reversed', async () => {
    const r = rig('DISPUTED', [{ status: 'processed', amount: 1000, currency: 'USD' }]); const out = await r.run(); r.restore()
    expect(out.reversed).toHaveLength(0)
    expect(r.world.t.payments[0].status).toBe('DISPUTED')
  })
})

describe('reversePayment — partner notice is deferred (B1)', () => {
  it('hands the partner email to `defer` instead of awaiting it, and still awaits it with no defer', async () => {
    const mk = () => createWorld({
      payments: [{ id: 'p1', paystack_ref: 'r1', scan_id: 's1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', user_id: 'u1' }],
      scans: [{ id: 's1', fix_payment_id: 'p1', verification_code: 'AB3XY7', verification_status: 'ACTIVE' }],
      commission_ledger: [{ id: 'l1', payment_id: 'p1', partner_id: 'pt1', referral_code_id: null, gross_amount_cents: 2900, commission_rate: 0.2, commission_amount_cents: 580, currency: 'USD', reverses_ledger_id: null, payout_id: null }],
    })
    let sent = 0, release
    const gate = new Promise(r => { release = r })
    const { mod, restore } = loadWithStubs('services/fulfillment.service.js', {
      'services/referral.service.js': { notifyPartnerReversal: async () => { await gate; sent++ } },
      'services/email.service.js': { sendPaymentReversed: async () => true },
    })
    const deferred = []
    const w1 = mk()
    await mod.reversePayment(w1.db, w1.t.payments[0], { reason: 'REFUND', env: {}, defer: p => deferred.push(p) })   // returns while the notice is still blocked
    expect(sent).toBe(0)
    expect(deferred.length).toBeGreaterThan(0)
    release(); await Promise.all(deferred)
    expect(sent).toBe(1)
    const w2 = mk()
    await mod.reversePayment(w2.db, w2.t.payments[0], { reason: 'REFUND', env: {} })
    expect(sent).toBe(2)
    restore()
  })
})
