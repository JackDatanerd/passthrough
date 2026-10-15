import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

// Webhooks section, independent audit round 15.
//   B1  dispute API calls were sent to …/dispute/<id>%2Fresolve (slash encoded) — accept / evidence could never work
//   B2  an accept always refunded the whole payment, whatever the dispute was for
//   B3  replay / re-drive took a row without checking nobody else had it
//   B4  a hard bounce overwrote an earlier spam complaint
//   B5  unfinished Resend rows lost their payload at 7 days and could never be re-driven
//   G1  contest a dispute with a generated proof of delivery        G2  nag while the retired signing key is still set
let restore
afterEach(() => { restore?.(); restore = null; vi.unstubAllGlobals() })

const ctx = ({ env = {}, params = {}, body = {}, user = { id: 'admin1' } } = {}) => ({
  env,
  req: { param: k => params[k], query: () => undefined, json: async () => body, header: () => undefined },
  get: () => user,
  json: (b, s = 200) => ({ body: b, status: s }),
})

describe('B1: dispute calls hit real paths', () => {
  it('id and action are separate path segments (no %2F), verbs and bodies right', async () => {
    const seen = []
    vi.stubGlobal('fetch', async (url, o) => { seen.push([o?.method || 'GET', url, o?.body]); return { ok: true, status: 200, json: async () => ({ status: true, data: { signedUrl: 'https://s3.example/put', fileName: 'f.pdf' } }) } })
    const svc = require_('../src/services/paystack.service.js')
    const env = { PAYSTACK_SECRET_KEY: 'sk' }
    await svc.addDisputeEvidence(env, '1234', { a: 1 })
    await svc.acceptDispute(env, '1234', { message: 'm', refundAmount: 50 })
    await svc.fetchDispute(env, '1234')
    await svc.getDisputeUploadUrl(env, '1234', 'proof x.pdf')
    await svc.declineDispute(env, '1234', { message: 'm', refundAmount: 50, uploadedFilename: 'f.pdf' })
    expect(seen.map(s => s.slice(0, 2))).toEqual([
      ['POST', 'https://api.paystack.co/dispute/1234/evidence'],
      ['PUT', 'https://api.paystack.co/dispute/1234/resolve'],
      ['GET', 'https://api.paystack.co/dispute/1234'],
      ['GET', 'https://api.paystack.co/dispute/1234/upload_url?upload_filename=proof%20x.pdf'],
      ['PUT', 'https://api.paystack.co/dispute/1234/resolve'],
    ])
    expect(JSON.parse(seen[1][2])).toEqual({ resolution: 'merchant-accepted', message: 'm', refund_amount: 50 })
    expect(JSON.parse(seen[4][2])).toEqual({ resolution: 'declined', message: 'm', refund_amount: 50, uploaded_filename: 'f.pdf' })
    expect(seen[2][2]).toBeUndefined()
  })
  it('a hostile id cannot add path segments', async () => {
    const seen = []
    vi.stubGlobal('fetch', async url => { seen.push(url); return { ok: true, status: 200, json: async () => ({ status: true }) } })
    await require_('../src/services/paystack.service.js').fetchDispute({ PAYSTACK_SECRET_KEY: 'sk' }, '1/../../transaction')
    expect(seen[0]).toBe('https://api.paystack.co/dispute/1%2F..%2F..%2Ftransaction')
  })
  it('the signed upload URL must be https', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ status: true, data: { signedUrl: 'http://x/y' } }) }))
    await expect(require_('../src/services/paystack.service.js').getDisputeUploadUrl({ PAYSTACK_SECRET_KEY: 'sk' }, '1', 'a.pdf')).rejects.toThrow(/unreadable/)
  })
})

function load(world, extra = {}) {
  const audit = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async (c, db, action, type, id, meta) => { audit.push({ action, id, meta }) } },
    'services/email.service.js': { sendOwnerAlert: async () => true },
    ...extra,
  })
  restore = l.restore
  return { mod: l.mod, audit }
}
const basePayment = o => ({ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', user_id: 'u1', scan_id: 's1', fix_tier: 'FIX', amount_cents: 2900, currency: 'USD', paid_at: '2026-09-28T10:00:00Z', dispute_id: '777', ...o })

describe('B2: accept refunds what was disputed', () => {
  const rig = (claimed, paymentOver = {}, over = {}) => {
    const calls = []
    const world = createWorld({ users: [{ id: 'u1', email: 'b@x.co', name: 'Bea' }], payments: [basePayment(paymentOver)] })
    const stub = {
      fetchDispute: async () => ({ data: { refund_amount: claimed } }),
      acceptDispute: async (e, id, o) => { calls.push(o); return { status: true } },
      listDisputes: async () => ({ data: [] }),
      ...over,
    }
    return { calls, ...load(world, { 'services/paystack.service.js': stub }) }
  }
  const accept = mod => mod.acceptPaymentDispute(ctx({ params: { reference: 'ref1' } }))
  it('a partial dispute refunds only that part, says the payment is not auto-reversed, and audits it', async () => {
    const { mod, calls, audit } = rig(1000)
    const out = await accept(mod)
    expect(calls[0].refundAmount).toBe(1000)
    expect(out.body.message).toMatch(/NOT reversed/)
    expect(audit[0].meta).toMatchObject({ refundAmount: 1000, partial: true })
  })
  it('no stated amount, or one above what was paid, refunds the whole payment', async () => {
    for (const claimed of [null, 0, 99999]) {
      const { mod, calls } = rig(claimed)
      await accept(mod)
      expect(calls[0].refundAmount).toBe(2900)
      restore(); restore = null
    }
  })
  it('an amount found through the dispute list is used too', async () => {
    const { mod, calls } = rig(null, { dispute_id: null }, { listDisputes: async () => ({ data: [{ id: 5, refund_amount: 700, transaction: { reference: 'ref1' } }] }) })
    await accept(mod)
    expect(calls[0].refundAmount).toBe(700)
  })
  it('if the dispute cannot be read nothing is accepted (502)', async () => {
    const { mod, calls } = rig(null, {}, { fetchDispute: async () => { throw new Error('timed out') } })
    expect((await accept(mod)).status).toBe(502)
    expect(calls).toHaveLength(0)
  })
})

describe('G1: contest a dispute with a proof of delivery', () => {
  const rig = ({ scan = {}, paymentOver = {}, stub = {} } = {}) => {
    const log = []
    const world = createWorld({
      users: [{ id: 'u1', email: 'buyer@x.co' }],
      payments: [basePayment(paymentOver)],
      scans: [{ id: 's1', status: 'FIX_DELIVERED', fix_payment_id: 'p1', fix_tier: 'FIX', verification_code: 'ABCD1234', verification_status: 'ACTIVE', ...scan }],
    })
    const paystack = {
      listDisputes: async () => ({ data: [] }),
      getDisputeUploadUrl: async (e, id, name) => { log.push(['url', id, name]); return { signedUrl: 'https://s3.example/put', fileName: 'stored-' + name } },
      uploadDisputeProof: async (url, bytes, type) => { log.push(['upload', url, bytes, type]) },
      declineDispute: async (e, id, o) => { log.push(['decline', id, o]); return { status: true } },
      ...stub,
    }
    return { world, log, ...load(world, { 'services/paystack.service.js': paystack }) }
  }
  const run = (mod, body = {}) => mod.contestPaymentDispute(ctx({ env: { FRONTEND_URL: 'https://passthrough.dev' }, params: { reference: 'ref1' }, body }))
  it('uploads a real PDF, then declines quoting the stored file name; the payment itself is untouched', async () => {
    const { mod, world, log, audit } = rig()
    const out = await run(mod, { note: 'delivered on 29 Sep' })
    expect(out.status).toBe(200)
    expect(log.map(l => l[0])).toEqual(['url', 'upload', 'decline'])
    expect(log[0][2]).toBe('proof-ref1.pdf')
    const bytes = log[1][2]
    const text = new TextDecoder().decode(bytes)
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toMatch(/ref1/); expect(text).toMatch(/29 Sep/); expect(text).toMatch(/passthrough\.dev\/v\/ABCD1234/)
    expect(log[1][3]).toBe('application/pdf')
    expect(log[2][2]).toEqual({ message: 'delivered on 29 Sep', refundAmount: 2900, uploadedFilename: 'stored-proof-ref1.pdf' })
    expect(world.t.payments[0].status).toBe('DISPUTED')
    expect(audit[0]).toMatchObject({ action: 'payment.dispute_contest', id: 'p1' })
    expect(JSON.stringify(audit)).not.toContain('29 Sep')
  })
  it('refuses when nothing was delivered, another payment owns the scan, or the payment is not DISPUTED', async () => {
    for (const o of [{ scan: { status: 'FIX_PURCHASED' } }, { scan: { fix_payment_id: 'other' } }, { paymentOver: { scan_id: null } }, { paymentOver: { status: 'SUCCESS' } }]) {
      const { mod, log } = rig(o)
      expect((await run(mod)).status).toBe(409)
      expect(log).toHaveLength(0)
      restore(); restore = null
    }
  })
  it('a failed upload never resolves the dispute', async () => {
    const { mod, log } = rig({ stub: { uploadDisputeProof: async () => { throw new Error('storage down') } } })
    expect((await run(mod)).status).toBe(502)
    expect(log.map(l => l[0])).toEqual(['url'])
  })
  it('a Paystack refusal of the decline is shown as-is (422)', async () => {
    const { mod } = rig({ stub: { declineDispute: async () => { throw Object.assign(new Error('Dispute already resolved'), { paystackRejected: true }) } } })
    const out = await run(mod)
    expect(out.status).toBe(422); expect(out.body.message).toMatch(/already resolved/)
  })
  it('the proof writer escapes, wraps and paginates', () => {
    const { buildProofPdf } = require_('../src/lib/proofPdf.js')
    const t = new TextDecoder().decode(buildProofPdf({ title: 'T (x)', lines: ['a (b) \\ c é', 'w '.repeat(6000)] }))
    expect(t).toMatch(/\\\(b\\\)/); expect(t).toMatch(/\/Count [2-9]/); expect(t).not.toMatch(/é/)
    expect(t.endsWith('%%EOF\n')).toBe(true)
  })
})

describe('B3: a stored event is claimed before it is run', () => {
  const rig = () => {
    const world = createWorld({ webhook_events: [{ id: 'e1', provider: 'paystack', event_type: 'charge.success', status: 'FAILED', attempts: 2, received_at: '2026-10-01T10:00:00Z', payload: { event: 'x', data: {} } }] })
    return { world, ...load(world) }
  }
  it('of two runs that read the same row, only the first gets it', async () => {
    const { mod, world } = rig()
    const snapshot = { ...world.t.webhook_events[0] }
    expect((await mod.claimEvent(world.db, snapshot, { status: 'RECEIVED', attempts: 3 })).ok).toBe(true)
    expect((await mod.claimEvent(world.db, snapshot, { status: 'RECEIVED', attempts: 3 })).ok).toBe(false)
    expect(world.t.webhook_events[0].attempts).toBe(3)
  })
  it('replay answers 409, and runs nothing, when the row moved between the read and the claim', async () => {
    const { mod, world } = rig()
    const real = world.db.from.bind(world.db)
    let n = 0
    world.db.from = t => { if (t === 'webhook_events' && ++n === 2) world.t.webhook_events[0].attempts = 9; return real(t) }   // 1st = the read, 2nd = the claim
    const out = await mod.replayWebhookEvent(ctx({ params: { id: 'e1' } }))
    expect(out.status).toBe(409)
    expect(out.body.message).toMatch(/changed while you were looking/)
    expect(world.t.webhook_events[0]).toMatchObject({ status: 'FAILED', attempts: 9 })
  })
})

describe('B4: a complaint is not downgraded by a later bounce', () => {
  const sup = () => require_('../src/lib/emailSuppression.js')
  it('mail suppression: complaint then bounce stays a complaint; bounce then complaint becomes one', async () => {
    const world = createWorld({})
    const { recordSuppression } = sup()
    const env = { SUPPRESSION_HASH_KEY: 'k' }
    await recordSuppression(world.db, 'a@b.co', 'complaint', env)
    await recordSuppression(world.db, 'a@b.co', 'bounce', env)
    expect(world.t.email_suppressions).toHaveLength(1)
    expect(world.t.email_suppressions[0].reason).toBe('complaint')
    const w2 = createWorld({})
    await recordSuppression(w2.db, 'c@d.co', 'bounce', env)
    await recordSuppression(w2.db, 'c@d.co', 'complaint', env)
    expect(w2.t.email_suppressions[0].reason).toBe('complaint')
  })
  it('account flag: a bounce never replaces a complaint flag, but still reports the account', async () => {
    const world = createWorld({ users: [{ id: 'u1', email: 'a@b.co', email_bounce_type: 'complaint', email_bounced_at: 'then' }, { id: 'u2', email: 'a@b.co', email_bounce_type: null }] })
    const ids = await sup().flagAccountBounce(world.db, 'A@b.co', 'bounce')
    expect(ids.sort()).toEqual(['u1', 'u2'])
    expect(world.t.users[0]).toMatchObject({ email_bounce_type: 'complaint', email_bounced_at: 'then' })
    expect(world.t.users[1].email_bounce_type).toBe('bounce')
    await sup().flagAccountBounce(world.db, 'a@b.co', 'complaint')
    expect(world.t.users[1].email_bounce_type).toBe('complaint')
  })
})

describe('G2: the retired signing key is flagged while it stays set', () => {
  const kvStore = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } } }
  it('alerts once a week, never when unset or identical to the current key, and never throws', async () => {
    const alerts = []
    const { mod } = load(createWorld({}), { 'services/email.service.js': { sendOwnerAlert: async (env, subject) => { alerts.push(subject); return true } } })
    const ex = { waitUntil: () => {} }
    const env = { PAYSTACK_SECRET_KEY: 'new', PAYSTACK_SECRET_KEY_PREVIOUS: 'old', RATE_LIMIT_KV: kvStore() }
    expect((await mod.checkRetiredSecret(env, ex)).alerted).toBe(true)
    expect((await mod.checkRetiredSecret(env, ex)).alerted).toBe(false)
    expect((await mod.checkRetiredSecret({ PAYSTACK_SECRET_KEY: 'new' }, ex)).alerted).toBe(false)
    expect((await mod.checkRetiredSecret({ PAYSTACK_SECRET_KEY: 'same', PAYSTACK_SECRET_KEY_PREVIOUS: 'same' }, ex)).alerted).toBe(false)
    expect((await mod.checkRetiredSecret(null, ex)).alerted).toBe(false)
    expect(alerts).toHaveLength(1)
  })
})
