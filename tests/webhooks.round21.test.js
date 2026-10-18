// Webhooks round 21: G1/B1 a dispute answered in Paystack's own dashboard is recorded as answered (it kept counting "overdue" and kept
// offering Contest / Accept), B2 a made-up signature / svix header can no longer raise the admin "deliveries are being refused" notice.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')
const cryptoLib = require_('../src/lib/crypto.js')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr; vi.unstubAllGlobals() })
const hoursAhead = h => new Date(Date.now() + h * 3600 * 1000).toISOString()
const SECRET = 'sk_test_round21'

function load(world, paystack = {}) {
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async () => true, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': paystack,
  })
  restore = l.restore
  return l.mod
}
const disputedPayment = (over = {}) => ({ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', amount_cents: 900, currency: 'USD', scan_id: 's1', user_id: 'u1', dispute_id: '777', dispute_due_at: hoursAhead(3), dispute_answered_at: null, dispute_answer: null, ...over })

describe('G1/B1: a dispute answered in the Paystack dashboard is recorded as answered', () => {
  it('the deadline check stamps a dispute Paystack lists as awaiting the bank, and does not page', async () => {
    const world = createWorld({ payments: [disputedPayment()] })
    const alerts = []
    const l = loadWithStubs('controllers/webhooks.controller.js', {
      'config/supabase.js': { getSupabase: () => world.db },
      'services/email.service.js': { sendOwnerAlert: async (e, s) => { alerts.push(s); return true } },
      'services/paystack.service.js': { fetchDispute: async () => ({ data: { id: 777, status: 'awaiting-bank-feedback' } }) },
    })
    restore = l.restore
    const r = await l.mod.checkDisputeDeadlines({}, { waitUntil() {} }, world.db)
    expect(r.alerted).toEqual([])
    expect(world.t.payments[0].dispute_answer).toBe('contested')
    expect(world.t.payments[0].dispute_answered_at).toBeTruthy()
    expect(alerts).toEqual([])
    expect(r.answered).toBe(1)   // openDisputeSummary / the Admin -> Payments countdown read dispute_answered_at (round 20 B3 tests)
  })
  it('the sweep stamps it too (no dispute id on the payment needed), and leaves an unanswered one alone', async () => {
    const world = createWorld({ payments: [
      disputedPayment(), disputedPayment({ id: 'p2', paystack_ref: 'ref2', dispute_id: '888' }),
    ], webhook_events: [] })
    const mod = load(world)
    const mk = (id, ref, status) => ({ id, status, resolution: null, refund_amount: 900, currency: 'USD', dueAt: hoursAhead(2), transaction: { reference: ref, amount: 900, currency: 'USD' } })
    const r = await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk_test_x' }, { waitUntil() {} }, world.db, {
      list: async () => ({ data: [mk(777, 'ref1', 'awaiting-bank-feedback'), mk(888, 'ref2', 'awaiting-merchant-feedback')] }),
    })
    expect(r.answeredElsewhere).toEqual(['ref1'])
    expect(world.t.payments.find(p => p.id === 'p1').dispute_answer).toBe('contested')
    expect(world.t.payments.find(p => p.id === 'p2').dispute_answer).toBeNull()
  })
  it('never overwrites an answer already recorded, and only touches DISPUTED payments', async () => {
    const world = createWorld({ payments: [
      disputedPayment({ dispute_answer: 'accepted', dispute_answered_at: '2026-01-01T00:00:00.000Z' }),
      disputedPayment({ id: 'p3', paystack_ref: 'ref3', status: 'SUCCESS' }),
    ] })
    const mod = load(world)
    expect(await mod.markDisputeAnsweredOutside(world.db, { id: 'p1' })).toBe(false)
    expect(await mod.markDisputeAnsweredOutside(world.db, { paystack_ref: 'ref3' })).toBe(false)
    expect(world.t.payments[0].dispute_answer).toBe('accepted')
    expect(world.t.payments[1].dispute_answer).toBeNull()
  })
})

describe('B2: refusals that cannot be Paystack / Resend are not flagged', () => {
  async function fire({ body = '{"event":"charge.success","data":{}}', sig, env = { PAYSTACK_SECRET_KEY: SECRET }, headers = {} }) {
    const w = createWorld({ webhook_events: [], payments: [], system_state: [] })
    w.unique.webhook_events = [['provider', 'event_key']]; w.unique.system_state = [['key']]
    const mod = load(w)
    const bytes = new TextEncoder().encode(body)
    const hdr = { 'x-paystack-signature': sig ?? await cryptoLib.hmacSha512Hex(SECRET, bytes), ...headers }
    const pending = []
    const c = { env, req: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), header: h => hdr[h.toLowerCase()] },
      executionCtx: { waitUntil: p => pending.push(p) }, text: (t, s) => ({ text: t, status: s }) }
    const res = await mod.handlePaystack(c); await Promise.all(pending)
    const row = w.t.system_state.find(r => r.key.startsWith('webhook_rejected'))
    return { res, key: row && row.key, reason: row && row.value.last_reason }
  }
  it('a made-up 128-hex signature on a body that is not a Paystack event is scanner noise', async () => {
    const { res, key, reason } = await fire({ sig: 'a'.repeat(128), body: 'hello' })
    expect(res.status).toBe(401)
    expect(reason).toBe('unsigned'); expect(key).toBe('webhook_rejected:paystack')
  })
  it('a wrong-key delivery that looks exactly like Paystack still raises the notice (the rotated-key case)', async () => {
    const { reason } = await fire({ sig: 'a'.repeat(128) })
    expect(reason).toBe('signature')
  })
  it('a bad signature from outside the IP allow-list cannot be Paystack: unsigned, not flagged', async () => {
    const { res, reason } = await fire({ sig: 'a'.repeat(128), env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_WEBHOOK_IPS: '52.31.139.75' }, headers: { 'cf-connecting-ip': '203.0.113.9' } })
    expect(res.status).toBe(403)
    expect(reason).toBe('unsigned')
  })
  it('a CORRECTLY signed request from a blocked IP is still flagged "ip"', async () => {
    const { reason } = await fire({ env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_WEBHOOK_IPS: '52.31.139.75' }, headers: { 'cf-connecting-ip': '203.0.113.9' } })
    expect(reason).toBe('ip')
  })
  it('svix headers must have a real shape', () => {
    const l = loadWithStubs('lib/webhookRejections.js', { 'middleware/rateLimiter.js': { hitQuota: async () => true } })
    restore = l.restore
    const ok = { id: 'msg_2abcDEF123456789', timestamp: '1760000000', signature: 'v1,' + 'Ab1+/'.repeat(9) }
    expect(l.mod.looksLikeSvixDelivery(ok)).toBe(true)
    expect(l.mod.looksLikeSvixDelivery({ ...ok, id: 'x' })).toBe(false)
    expect(l.mod.looksLikeSvixDelivery({ ...ok, timestamp: 'now' })).toBe(false)
    expect(l.mod.looksLikeSvixDelivery({ ...ok, signature: 'junk' })).toBe(false)
  })
})
