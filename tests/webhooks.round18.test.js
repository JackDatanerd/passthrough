// Webhooks round 18 — the independent pass found:
//   B1  the refusal stamp held only the NEWEST refusal, so a scanner's 'unsigned' request overwrote a real provider's 'signature' refusal
//       and Admin → Webhooks never showed the "deliveries are being refused" notice.
//   B2  contest answered "not delivered — accept the dispute instead" while a paid retry round had the scan at FIX_GENERATING.
//   G1  payments.dispute_due_at drove nothing: an open dispute near Paystack's ~16 h auto-accept raised no alert from this app.
//   G2  no way to check the webhook setup (secrets, IP list, migrations, Paystack key) before a real delivery failed.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore
afterEach(() => { restore?.(); restore = null; vi.unstubAllGlobals() })

const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString()
const hoursAhead = h => new Date(Date.now() + h * 3600 * 1000).toISOString()

function loadController(world, extra = {}) {
  const alerts = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async (e, subject, message) => { alerts.push({ subject, message }); return true } },
    ...extra,
  })
  restore = l.restore
  return { mod: l.mod, alerts }
}
const kvEnv = (extra = {}) => { const m = new Map(); return { RATE_LIMIT_KV: { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } }, ...extra } }

// ── B1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B1: scanner-shaped refusals cannot hide a real signature refusal', () => {
  const lib = (world, quota = async () => true) => {
    const l = loadWithStubs('lib/webhookRejections.js', { 'middleware/rateLimiter.js': { hitQuota: quota } })
    restore = l.restore
    return l.mod
  }
  const newWorld = () => { const w = createWorld({ system_state: [] }); w.unique.system_state = [['key']]; return w }

  it('a later unsigned refusal leaves the signature refusal flagged', async () => {
    const w = newWorld(); const m = lib(w)
    await m.recordRejection({}, 'paystack', 'signature', w.db)
    await m.recordRejection({}, 'paystack', 'unsigned', w.db)
    await m.recordRejection({}, 'paystack', 'too-large', w.db)
    const r = await m.readRejections(w.db)
    expect(r.paystack.reason).toBe('signature')
    expect(m.rejectedSinceLastEvent(r, { paystack: null, resend: null })).toEqual(['paystack'])
  })
  it('flagged refusals have their own quota, so junk cannot consume the slot a real one needs', async () => {
    const w = newWorld()
    const used = new Set()
    const m = lib(w, async (env, key) => { if (used.has(key)) return false; used.add(key); return true })
    expect(await m.recordRejection({}, 'paystack', 'unsigned', w.db)).toBe(true)
    expect(await m.recordRejection({}, 'paystack', 'unsigned', w.db)).toBe(false)   // throttled
    expect(await m.recordRejection({}, 'paystack', 'signature', w.db)).toBe(true)   // not affected
  })
  it('with only unflagged refusals nothing is raised, and a flagged one older than a delivery that got through clears', async () => {
    const w = newWorld(); const m = lib(w)
    await m.recordRejection({}, 'resend', 'unsigned', w.db)
    expect(m.rejectedSinceLastEvent(await m.readRejections(w.db), { paystack: null, resend: null })).toEqual([])
    await m.recordRejection({}, 'resend', 'signature', w.db)
    const r = await m.readRejections(w.db)
    expect(m.rejectedSinceLastEvent(r, { paystack: null, resend: new Date(Date.now() + 60000).toISOString() })).toEqual([])
  })
  it('the health output keeps the flagged refusal as lastRejected even after scanner noise', async () => {
    const w = createWorld({ webhook_events: [], payments: [], system_state: [] }); w.unique.system_state = [['key']]
    const { mod } = loadController(w)
    w.t.system_state.push({ key: 'webhook_rejected_flagged:paystack', value: { last_at: hoursAgo(2), last_reason: 'signature' } })
    w.t.system_state.push({ key: 'webhook_rejected:paystack', value: { last_at: hoursAgo(0.1), last_reason: 'unsigned' } })
    const h = await mod.computeWebhookHealth(w.db)
    expect(h.lastRejected.paystack.reason).toBe('signature')
    expect(h.rejectedSinceLastEvent).toEqual(['paystack'])
  })
})

// ── B2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B2: contest is available while a retry round is running on delivered work', () => {
  const pay = { id: 'p1' }
  it('workWasDelivered', () => {
    const { mod } = loadController(createWorld({}))
    expect(mod.workWasDelivered({ fix_payment_id: 'p1', status: 'FIX_DELIVERED' }, pay)).toBe(true)
    expect(mod.workWasDelivered({ fix_payment_id: 'p1', status: 'FIX_GENERATING', fix_retry_count: 1, resume_ats_path: 'a/b.docx' }, pay)).toBe(true)
    expect(mod.workWasDelivered({ fix_payment_id: 'p1', status: 'FIX_GENERATING', fix_retry_count: 0, resume_ats_path: null }, pay)).toBe(false)   // first generation, nothing delivered
    expect(mod.workWasDelivered({ fix_payment_id: 'p1', status: 'FIX_GENERATING', fix_retry_count: 1, resume_ats_path: null }, pay)).toBe(false)
    expect(mod.workWasDelivered({ fix_payment_id: 'p1', status: 'FIX_PURCHASED' }, pay)).toBe(false)
    expect(mod.workWasDelivered({ fix_payment_id: 'other', status: 'FIX_DELIVERED' }, pay)).toBe(false)
    expect(mod.workWasDelivered(null, pay)).toBe(false)
  })
  const run = async scan => {
    const log = []
    const world = createWorld({
      users: [{ id: 'u1', email: 'b@x.co' }],
      payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', user_id: 'u1', scan_id: 's1', fix_tier: 'FIX', amount_cents: 2900, currency: 'USD', paid_at: '2026-09-28T10:00:00Z', dispute_id: '777' }],
      scans: [{ id: 's1', status: 'FIX_DELIVERED', fix_payment_id: 'p1', fix_tier: 'FIX', verification_code: 'ABCD1234', verification_status: 'ACTIVE', ...scan }],
    })
    const { mod } = loadController(world, { 'services/paystack.service.js': {
      fetchDispute: async () => ({ data: { refund_amount: null } }),
      getDisputeUploadUrl: async (e, id, n) => ({ signedUrl: 'https://s3.example/put', fileName: n }),
      uploadDisputeProof: async () => { log.push('upload') },
      declineDispute: async () => { log.push('decline'); return { status: true } },
    } })
    const out = await mod.contestPaymentDispute({ env: { FRONTEND_URL: 'https://passthrough.dev' }, req: { param: () => 'ref1', json: async () => ({}) }, get: () => ({ id: 'a' }), json: (b, s = 200) => ({ body: b, status: s }) })
    return { out, log }
  }
  it('a retry round on delivered files still contests', async () => {
    const { out, log } = await run({ status: 'FIX_GENERATING', fix_retry_count: 1, resume_ats_path: 'x/y.docx' })
    expect(out.status).toBe(200); expect(log).toEqual(['upload', 'decline'])
  })
  it('a first-time generation (nothing delivered) is still refused', async () => {
    const { out, log } = await run({ status: 'FIX_GENERATING', fix_retry_count: 0, resume_ats_path: null })
    expect(out.status).toBe(409); expect(log).toEqual([])
  })
})

// ── G1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('G1: open disputes near their auto-accept deadline page the owner', () => {
  const world = () => createWorld({ payments: [
    { id: 'a', paystack_ref: 'ra', status: 'DISPUTED', scan_id: 's', amount_cents: 2900, currency: 'USD', dispute_due_at: hoursAhead(2) },
    { id: 'b', paystack_ref: 'rb', status: 'DISPUTED', scan_id: 's', amount_cents: 2900, currency: 'USD', dispute_due_at: hoursAhead(20) },
    { id: 'c', paystack_ref: 'rc', status: 'DISPUTED', scan_id: 's', amount_cents: 2900, currency: 'USD', dispute_due_at: hoursAgo(1) },
    { id: 'd', paystack_ref: 'rd', status: 'DISPUTED', scan_id: 's', amount_cents: 2900, currency: 'USD', dispute_due_at: hoursAgo(5) },
    { id: 'e', paystack_ref: 're', status: 'SUCCESS', scan_id: 's', amount_cents: 2900, currency: 'USD', dispute_due_at: hoursAhead(1) },
    { id: 'f', paystack_ref: 'rf', status: 'DISPUTED', scan_id: 's', amount_cents: 2900, currency: 'USD', dispute_due_at: null },
  ] })
  it('alerts for a deadline within 6 h and one that just passed; not far-off, long-past, cleared or deadline-less ones', async () => {
    const w = world(); const { mod, alerts } = loadController(w)
    const r = await mod.checkDisputeDeadlines(kvEnv(), {}, w.db)
    expect(r.alerted.sort()).toEqual(['ra', 'rc'])
    expect(alerts.map(a => a.subject).sort()).toEqual(['Dispute deadline approaching — answer it now', 'Dispute deadline has passed'])
    const near = alerts.find(a => /approaching/.test(a.subject)).message
    expect(near).toMatch(/ra/); expect(near).toMatch(/Contest dispute/); expect(near).toMatch(/left/)
  })
  it('is throttled per payment (3 h) and silent for a healthy system', async () => {
    const w = world(); const { mod, alerts } = loadController(w); const env = kvEnv()
    await mod.checkDisputeDeadlines(env, {}, w.db)
    const n = alerts.length
    const again = await mod.checkDisputeDeadlines(env, {}, w.db)
    expect(again.alerted).toEqual([]); expect(alerts).toHaveLength(n)
    const w2 = createWorld({ payments: [{ id: 'x', paystack_ref: 'rx', status: 'SUCCESS', amount_cents: 1, currency: 'USD' }] }); const l2 = loadController(w2)
    expect((await l2.mod.checkDisputeDeadlines(kvEnv(), {}, w2.db)).alerted).toEqual([])
  })
  it('DISPUTE_WARN_HOURS widens the window (strict 1-15, round 14 convention) and a failing query never throws', async () => {
    const w = world(); const { mod } = loadController(w)
    expect(mod.disputeWarnMs({})).toBe(6 * 3600000)
    expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: '99' })).toBe(6 * 3600000)   // out of range = malformed -> default
    expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: '12' })).toBe(12 * 3600000)
    expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: '0.5' })).toBe(6 * 3600000)
    expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: '7h' })).toBe(6 * 3600000)
    expect(mod.disputeWarnMs({ DISPUTE_WARN_HOURS: '0' })).toBe(6 * 3600000)
    const r = await mod.checkDisputeDeadlines(kvEnv({ DISPUTE_WARN_HOURS: '15' }), {}, w.db)
    expect(r.alerted).toEqual(expect.arrayContaining(['ra', 'rc']))
    const broken = { from: () => { throw new Error('db down') } }
    const r2 = await mod.checkDisputeDeadlines(kvEnv(), {}, broken)
    expect(r2.error).toMatch(/db down/)
  })
})

// ── G2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('G2: the webhook setup self-test', () => {
  const GOOD_RESEND = 'whsec_' + btoa('0123456789abcdef0123456789abcdef')
  const goodEnv = { PAYSTACK_SECRET_KEY: 'sk_live_abc', RESEND_WEBHOOK_SECRET: GOOD_RESEND }
  const newWorld = () => { const w = createWorld({ webhook_events: [{ id: 'e', provider: 'paystack', event_key: 'k', event_type: 'charge.success', reference: 'r', status: 'PROCESSED', attempts: 1, received_at: hoursAgo(1) }], payments: [], payment_refunds: [], system_state: [] }); w.unique.system_state = [['key']]; return w }
  const rig = (paystack = {}) => { const w = newWorld(); return { w, ...loadController(w, { 'services/paystack.service.js': { listDisputes: async () => ({ data: [] }), ...paystack } }) } }
  const by = (out, id) => out.checks.find(c => c.id === id)

  it('a healthy setup is all OK, and gives the URLs to register', async () => {
    const { w, mod } = rig()
    const out = await mod.buildSelfTest(goodEnv, w.db, { origin: 'https://api.passthrough.dev/' })
    expect(out.checks.filter(c => c.status === 'fail')).toEqual([])
    expect(by(out, 'paystack-secret').status).toBe('ok'); expect(by(out, 'paystack-secret').detail).toMatch(/live-mode/)
    expect(by(out, 'resend-secret').status).toBe('ok'); expect(by(out, 'paystack-api').status).toBe('ok')
    expect(out.ok).toBe(true)
    expect(out.endpoints).toEqual({ paystack: 'https://api.passthrough.dev/api/webhooks/paystack', resend: 'https://api.passthrough.dev/api/webhooks/resend' })
  })
  it('missing / malformed secrets fail', async () => {
    const { w, mod } = rig()
    const out = await mod.buildSelfTest({}, w.db)
    expect(by(out, 'paystack-secret').status).toBe('fail'); expect(by(out, 'resend-secret').status).toBe('fail'); expect(out.ok).toBe(false)
    const bad = await mod.buildSelfTest({ ...goodEnv, RESEND_WEBHOOK_SECRET: 'whsec_not base64 !!' }, w.db)
    expect(by(bad, 'resend-secret').status).toBe('fail')
    const pub = await mod.buildSelfTest({ ...goodEnv, PAYSTACK_SECRET_KEY: 'pk_live_xyz' }, w.db)
    expect(by(pub, 'paystack-secret').status).toBe('warn')
  })
  it('Paystack refusing the key fails; a retired key and a bad IP list are called out', async () => {
    const { w, mod } = rig({ listDisputes: async () => { throw new Error('Invalid key') } })
    const out = await mod.buildSelfTest({ ...goodEnv, PAYSTACK_SECRET_KEY_PREVIOUS: 'sk_test_old', PAYSTACK_WEBHOOK_IPS: 'nonsense' }, w.db)
    expect(by(out, 'paystack-api').status).toBe('fail'); expect(by(out, 'paystack-api').detail).toMatch(/Invalid key/)
    expect(by(out, 'paystack-previous').status).toBe('warn')
    expect(by(out, 'paystack-ips').status).toBe('fail')
    const some = await mod.buildSelfTest({ ...goodEnv, PAYSTACK_WEBHOOK_IPS: '52.31.139.75, nonsense' }, w.db)
    expect(by(some, 'paystack-ips').status).toBe('warn')
    const ok = await mod.buildSelfTest({ ...goodEnv, PAYSTACK_WEBHOOK_IPS: '52.31.139.75' }, w.db)
    expect(by(ok, 'paystack-ips').status).toBe('ok')
  })
  it('an unapplied migration is named; a refused-delivery state fails the delivery check', async () => {
    const { w, mod } = rig()
    const db = { from: t => { const q = w.db.from(t); const sel = q.select.bind(q); q.select = (cols, o) => (t === 'webhook_events' && cols === 'last_attempt_at') ? { limit: async () => ({ error: { message: 'column does not exist' } }) } : sel(cols, o); return q } }
    const out = await mod.buildSelfTest(goodEnv, db)
    expect(by(out, 'schema').status).toBe('warn'); expect(by(out, 'schema').detail).toMatch(/0090/)
    w.t.system_state.push({ key: 'webhook_rejected_flagged:paystack', value: { last_at: hoursAgo(0.5), last_reason: 'signature' } })
    const refused = await mod.buildSelfTest(goodEnv, w.db)
    expect(by(refused, 'delivery').status).toBe('fail'); expect(by(refused, 'delivery').detail).toMatch(/paystack/)
  })
  it('sends nothing to the inbox and the route handler wraps it', async () => {
    const { w, mod } = rig()
    const before = w.t.webhook_events.length
    const res = await mod.getWebhookSelfTest({ env: goodEnv, req: { url: 'https://api.passthrough.dev/api/admin/webhook-events/self-test' }, json: (b, s = 200) => ({ body: b, status: s }) })
    expect(res.status).toBe(200); expect(res.body.data.endpoints.paystack).toBe('https://api.passthrough.dev/api/webhooks/paystack')
    expect(w.t.webhook_events).toHaveLength(before)
  })
})
