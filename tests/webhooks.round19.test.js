// Webhooks round 19 — the independent pass found:
//   G1  a DISPUTED payment older than the 45-day sweep windows was never looked at again: a lost resolve webhook left it DISPUTED for good.
//   G2  the merchant's own answer to a dispute (contest / accept) was recorded nowhere but the admin audit log.
//   B1  the deadline pages kept firing after the dispute had been answered.
//   B2  the dispute evidence described a rewritten resume for the credential-only (BADGE) tier.
//   B3  a chunked body (no Content-Length) was buffered whole before the size cap was checked.
//   B4  DISPUTE_WARN_HOURS used its own parsing, outside the strict numeric-env convention.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr; vi.unstubAllGlobals() })

const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString()
const hoursAhead = h => new Date(Date.now() + h * 3600 * 1000).toISOString()
const daysAgo = d => hoursAgo(d * 24)
const kvEnv = (extra = {}) => { const m = new Map(); return { RATE_LIMIT_KV: { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } }, ...extra } }

function load(world, paystack = {}, extra = {}) {
  const alerts = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { alerts.push({ subject, message }); return true }, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': paystack,
    ...extra,
  })
  restore = l.restore
  return { mod: l.mod, alerts }
}
const jsonCtx = (over = {}) => ({ env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { param: () => 'ref1', json: async () => ({}) }, get: () => ({ id: 'a' }), json: (b, s = 200) => ({ body: b, status: s }), ...over })

// ── B3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B3: the body is read with a cap while streaming', () => {
  const { readBodyCapped } = require_('../src/lib/readBody.js')
  const streamOf = chunks => new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close() } })
  it('returns the bytes when under the cap, null the moment it is over', async () => {
    const ok = await readBodyCapped({ req: { raw: { body: streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]) } } }, 10)
    expect([...ok]).toEqual([1, 2, 3])
    let pulled = 0
    const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(100)) } })
    expect(await readBodyCapped({ req: { raw: { body: endless } } }, 250)).toBeNull()
    expect(pulled).toBeLessThan(10)   // it stopped reading; it did not drain the stream
  })
  it('falls back to arrayBuffer() where no stream is exposed, still capped', async () => {
    expect([...await readBodyCapped({ req: { arrayBuffer: async () => new Uint8Array([9]).buffer } }, 5)]).toEqual([9])
    expect(await readBodyCapped({ req: { arrayBuffer: async () => new Uint8Array(6).buffer } }, 5)).toBeNull()
  })
  it('both webhook handlers answer 413 for an over-cap chunked body', async () => {
    const mk = () => { const big = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(100 * 1024)) } }); return { env: { PAYSTACK_SECRET_KEY: 'sk_test_x', RESEND_WEBHOOK_SECRET: 'whsec_dGVzdA==' }, executionCtx: { waitUntil() {} },
      req: { header: () => undefined, raw: { body: big }, arrayBuffer: async () => { throw new Error('must not buffer') } }, text: (t, s) => ({ text: t, status: s }) } }
    const w = createWorld({})
    const a = load(w)
    expect((await a.mod.handlePaystack(mk())).status).toBe(413)
    restore()
    const l = loadWithStubs('controllers/resend-webhook.controller.js', { 'config/supabase.js': { getSupabase: () => w.db } })
    restore = l.restore
    expect((await l.mod.handleResend(mk())).status).toBe(413)
  })
})

// ── B4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B4: DISPUTE_WARN_HOURS is parsed strictly', () => {
  it('malformed or out of range falls back to 6; 1-15 is honoured', () => {
    const { mod } = load(createWorld({}))
    for (const bad of ['7h', '0', '0.5', '16', '-2', 'abc', '']) expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: bad })).toBe(6 * 3600000)
    expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: '1' })).toBe(3600000)
    expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: '15' })).toBe(15 * 3600000)
    expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: ' 9.5 ' })).toBe(9.5 * 3600000)
  })
  it('validateEnv knows the name', () => {
    expect(require_('../src/lib/numEnv.js').NUMERIC_ENV.DISPUTE_WARN_HOURS).toEqual({ min: 1, max: 15, integer: false })
  })
})

// ── B2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B2: dispute evidence describes what the tier actually delivered', () => {
  const world = tier => createWorld({
    users: [{ id: 'u1', email: 'b@x.co', name: 'Buyer' }],
    payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', user_id: 'u1', scan_id: 's1', fix_tier: tier, amount_cents: 900, currency: 'USD', paid_at: '2026-09-28T10:00:00Z', dispute_id: '777' }],
    scans: [{ id: 's1', status: 'FIX_DELIVERED', fix_payment_id: 'p1', fix_tier: tier, verification_code: 'ABCD1234', verification_status: 'ACTIVE' }],
  })
  const evidenceText = async tier => {
    let fields
    const { mod } = load(world(tier), { addDisputeEvidence: async (e, id, f) => { fields = f; return { data: { id: 5 } } } })
    await mod.submitDisputeEvidence(jsonCtx({ req: { param: () => 'ref1', json: async () => ({ customerPhone: '+254700000000' }) } }))
    return fields.service_details
  }
  const proofLines = async tier => {
    let lines
    const { mod } = load(world(tier), {
      fetchDispute: async () => ({ data: {} }), getDisputeUploadUrl: async (e, id, n) => ({ signedUrl: 'https://s3.example/x', fileName: n }),
      uploadDisputeProof: async () => {}, declineDispute: async () => ({ status: true }) },
      { 'lib/proofPdf.js': { buildProofPdf: ({ lines: l }) => { lines = l; return new Uint8Array([1]) } } })
    const out = await mod.contestPaymentDispute(jsonCtx())
    expect(out.status).toBe(200)
    return lines.join('\n')
  }
  it('BADGE (Credential only): a credential, never a rewritten resume', async () => {
    const ev = await evidenceText('BADGE'); const pf = await proofLines('BADGE')
    for (const t of [ev, pf]) { expect(t).toMatch(/credential/i); expect(t).not.toMatch(/rewritten resume|resume fix/i) }
    expect(ev).toMatch(/Credential only/)
  })
  it('FIX keeps the rewritten-resume wording', async () => {
    expect(await evidenceText('FIX')).toMatch(/rewritten resume/)
    expect(await proofLines('FIX')).toMatch(/rewritten resume/)
  })
})

// ── G2 + B1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('G2: the merchant\'s answer is recorded', () => {
  const world = () => createWorld({
    users: [{ id: 'u1', email: 'b@x.co', name: 'B' }],
    payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', user_id: 'u1', scan_id: 's1', fix_tier: 'FIX', amount_cents: 2900, currency: 'USD', dispute_id: '777', dispute_due_at: hoursAhead(2) }],
    scans: [{ id: 's1', status: 'FIX_DELIVERED', fix_payment_id: 'p1', fix_tier: 'FIX' }],
  })
  it('accept and contest stamp the payment; evidence alone does not (it does not close the dispute)', async () => {
    let w = world(); let { mod } = load(w, { fetchDispute: async () => ({ data: { refund_amount: 2900 } }), acceptDispute: async () => ({ status: true }), addDisputeEvidence: async () => ({ data: { id: 1 } }) })
    await mod.submitDisputeEvidence(jsonCtx({ req: { param: () => 'ref1', json: async () => ({ customerPhone: '+254700000000' }) } }))
    expect(w.t.payments[0].dispute_answered_at).toBeUndefined()
    await mod.acceptPaymentDispute(jsonCtx())
    expect(w.t.payments[0].dispute_answer).toBe('accepted'); expect(w.t.payments[0].dispute_answered_at).toBeTruthy()
    restore()
    w = world(); ;({ mod } = load(w, { fetchDispute: async () => ({ data: {} }), getDisputeUploadUrl: async (e, i, n) => ({ signedUrl: 'https://s3.example/x', fileName: n }), uploadDisputeProof: async () => {}, declineDispute: async () => ({ status: true }) }))
    await mod.contestPaymentDispute(jsonCtx())
    expect(w.t.payments[0].dispute_answer).toBe('contested')
  })
  it('a failed Paystack call stamps nothing', async () => {
    const w = world(); const { mod } = load(w, { fetchDispute: async () => ({ data: {} }), acceptDispute: async () => { throw Object.assign(new Error('nope'), { paystackRejected: true }) } })
    expect((await mod.acceptPaymentDispute(jsonCtx())).status).toBe(422)
    expect(w.t.payments[0].dispute_answer).toBeUndefined()
  })
  it('a partially accepted resolution leaves the payment DISPUTED and marks it resolved; a new dispute resets the answer', async () => {
    const w = world(); load(w, {})
    const ev = { event: 'charge.dispute.resolve', data: { id: 777, status: 'resolved', resolution: 'merchant-accepted', refund_amount: 1000, transaction: { reference: 'ref1' } } }
    restore(); const a = load(w, {})
    const out = await a.mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk' , ...kvEnv() }, null, w.db, { list: async () => ({ data: [ev.data] }) })
    expect(out.needsHuman).toHaveLength(1)
    expect(w.t.payments[0].status).toBe('DISPUTED'); expect(w.t.payments[0].dispute_answer).toBe('resolved')
    // a brand-new dispute on a SUCCESS payment: marked DISPUTED with a clean slate
    const w2 = world(); w2.t.payments[0].status = 'SUCCESS'; w2.t.payments[0].dispute_answer = 'contested'; w2.t.payments[0].dispute_answered_at = hoursAgo(5)
    restore(); const b = load(w2, {})
    const o2 = await b.mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk', ...kvEnv() }, null, w2.db, { list: async () => ({ data: [{ id: 778, status: 'awaiting-merchant-feedback', refund_amount: 2900, transaction: { reference: 'ref1' } }] }) })
    expect(o2.actioned).toHaveLength(1)
    expect(w2.t.payments[0].status).toBe('DISPUTED'); expect(w2.t.payments[0].dispute_answer).toBeNull()
  })
  it('B1: an answered dispute is not paged; one Paystack says is past our turn is not paged; doubt still pages', async () => {
    const mk = (status, answered) => createWorld({ payments: [{ id: 'a', paystack_ref: 'ra', status: 'DISPUTED', scan_id: 's', amount_cents: 2900, currency: 'USD', dispute_id: '9', dispute_due_at: hoursAhead(2), ...(answered ? { dispute_answered_at: hoursAgo(1), dispute_answer: 'contested' } : {}) }] })
    let w = mk(); let l = load(w, { fetchDispute: async () => ({ data: { status: 'awaiting-merchant-feedback' } }) })
    expect((await l.mod.checkDisputeDeadlines(kvEnv(), {}, w.db)).alerted).toEqual(['ra'])               // still ours: page
    restore()
    w = mk(null, true); l = load(w, { fetchDispute: async () => { throw new Error('must not be asked') } })
    const r1 = await l.mod.checkDisputeDeadlines(kvEnv(), {}, w.db)
    expect(r1.alerted).toEqual([]); expect(r1.answered).toBe(1); restore()
    w = mk(); l = load(w, { fetchDispute: async () => ({ data: { status: 'awaiting-bank-feedback' } }) })
    expect((await l.mod.checkDisputeDeadlines(kvEnv(), {}, w.db)).alerted).toEqual([]); restore()
    w = mk(); l = load(w, { fetchDispute: async () => { throw new Error('paystack down') } })
    expect((await l.mod.checkDisputeDeadlines(kvEnv(), {}, w.db)).alerted).toEqual(['ra'])               // doubt: page anyway
  })
})

// ── G1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('G1: disputes older than the sweep windows are still caught up', () => {
  const world = (over = {}) => createWorld({
    payments: [{ id: 'old', paystack_ref: 'ref-old', status: 'DISPUTED', scan_id: 's1', user_id: 'u1', fix_tier: 'FIX', amount_cents: 2900, currency: 'USD', dispute_id: '555', disputed_at: daysAgo(60), created_at: daysAgo(61), ...over }],
    scans: [{ id: 's1', user_id: 'u1', fix_payment_id: 'old', verification_code: 'AB3XY7', verification_status: 'ACTIVE' }],
    webhook_events: [], commission_ledger: [], users: [{ id: 'u1', email: 'b@x.co' }],
  })
  const run = async (w, dispute) => {
    const calls = []
    const { mod, alerts } = load(w, { listDisputes: async () => ({ data: [] }), fetchDispute: async (e, id) => { calls.push(id); return { data: dispute } } })
    const r = await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk', ...kvEnv() }, null, w.db)
    return { r, calls, alerts }
  }
  it('a lost ACCEPTED resolution on a 60-day-old dispute reverses the sale', async () => {
    const w = world()
    const { r, calls } = await run(w, { id: 555, status: 'resolved', resolution: 'merchant-accepted', refund_amount: 2900, transaction: { reference: 'ref-old' } })
    expect(calls).toEqual(['555'])
    expect(r.actioned).toHaveLength(1); expect(w.t.payments[0].status).toBe('REFUNDED')
  })
  it('a lost DECLINED resolution (we won) puts it back to SUCCESS', async () => {
    const w = world()
    await run(w, { id: 555, status: 'resolved', resolution: 'declined', refund_amount: 2900, transaction: { reference: 'ref-old' } })
    expect(w.t.payments[0].status).toBe('SUCCESS')
  })
  it('still unresolved: nothing changes; a payload without a transaction object still maps to the payment', async () => {
    const w = world()
    const { r } = await run(w, { id: 555, status: 'awaiting-bank-feedback', resolution: null, refund_amount: 2900 })
    expect(r.actioned).toHaveLength(0); expect(w.t.payments[0].status).toBe('DISPUTED')
    const w2 = world()
    await run(w2, { id: 555, status: 'resolved', resolution: 'merchant-accepted', refund_amount: 2900 })   // no transaction in the fetch answer
    expect(w2.t.payments[0].status).toBe('REFUNDED')
  })
  it('a dispute already listed is not fetched or handled twice', async () => {
    const w = world(); const calls = []
    const d = { id: 555, status: 'resolved', resolution: 'merchant-accepted', refund_amount: 2900, transaction: { reference: 'ref-old' } }
    const { mod } = load(w, { listDisputes: async () => ({ data: [d] }), fetchDispute: async (e, id) => { calls.push(id); return { data: d } } })
    const r = await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk', ...kvEnv() }, null, w.db, { list: async () => ({ data: [d] }) })
    expect(r.actioned).toHaveLength(1); expect(calls).toEqual([])   // the listed copy was used; Paystack was not asked again by id
  })
  it('a Paystack failure on one old dispute never breaks the sweep', async () => {
    const w = world()
    const { mod } = load(w, { listDisputes: async () => ({ data: [] }), fetchDispute: async () => { throw new Error('paystack down') } })
    const r = await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk', ...kvEnv() }, null, w.db)
    expect(r.error).toBeNull(); expect(w.t.payments[0].status).toBe('DISPUTED')
  })
})

// ── self-test ───────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('self-test probes the round-19 column and the refund RPC', () => {
  it('names 0097 / 0053 when they are missing', async () => {
    const w = createWorld({ webhook_events: [], payments: [], payment_refunds: [], users: [], system_state: [] })
    const db = { from: t => w.db.from(t), rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.record_refund_and_total' } }) }
    const { mod } = load(w, { listDisputes: async () => ({ data: [] }) })
    const out = await mod.buildSelfTest({ PAYSTACK_SECRET_KEY: 'sk_test_abc' }, db, {})
    const schema = out.checks.find(c => c.id === 'schema')
    expect(schema.detail).toMatch(/0053/)
  })
})
