// Webhooks round 16 — the independent pass found:
//   B1  a retried event looks "stuck" the instant it is picked up (received_at never moves), so Replay/Dismiss were offered for a running
//       event and the hourly re-drive ran it alongside the live delivery. last_attempt_at (0090) is the clock now.
//   G1  "Contest" could not finish a fraud-claim dispute: the evidence id was thrown away and never sent; the decline also always carried the
//       whole payment amount instead of what was disputed.
//   B2  the Accept confirmation promised the whole amount.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require_ = createRequire(import.meta.url)
const { loadWithStubs } = require_('./helpers/loadWithStubs.cjs')
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore
afterEach(() => { restore?.(); restore = null; vi.unstubAllGlobals() })

const ctx = ({ env = {}, params = {}, query = {}, body = {}, user = { id: 'admin1' } } = {}) => ({
  env,
  req: { param: k => params[k], query: k => query[k], json: async () => body, header: () => undefined },
  get: () => user,
  json: (b, s = 200) => ({ body: b, status: s }),
})
function load(world, extra = {}) {
  const audit = []
  const alerts = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async (c, db, action, type, id, meta) => { audit.push({ action, id, meta }) } },
    'services/email.service.js': { sendOwnerAlert: async (e, subject) => { alerts.push(subject); return true } },
    ...extra,
  })
  restore = l.restore
  return { mod: l.mod, audit, alerts }
}
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString()

// ── B1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B1: a retried event is not "stuck" while it is being worked on', () => {
  const failedRow = o => ({ id: 'e1', provider: 'paystack', event_key: 'charge.success:1', event_type: 'charge.success', reference: 'r1', status: 'FAILED', attempts: 1, redrives: 0, received_at: hoursAgo(3), payload: { event: 'charge.success', data: { reference: 'r1', amount: 100, currency: 'USD' } }, ...o })
  const rig = rows => {
    const world = createWorld({ payments: [], webhook_events: rows })
    world.unique.webhook_events = [['provider', 'event_key']]
    return { world, ...load(world) }
  }

  it('a live redelivery of a FAILED row stamps last_attempt_at, so the row is not replayable/dismissable and the re-drive leaves it alone', async () => {
    const first = failedRow()
    const { world, mod } = rig([first])
    const r = await mod.recordEvent(world.db, { eventKey: 'charge.success:1', eventType: 'charge.success', reference: 'r1', payload: {} })
    expect(r.mode).toBe('retry')
    const row = world.t.webhook_events[0]
    expect(row.status).toBe('RECEIVED')
    expect(Date.parse(row.last_attempt_at)).toBeGreaterThan(Date.now() - 5000)
    expect(row.received_at).toBe(first.received_at)   // untouched: the FIRST receipt is still what the list shows

    const list = await mod.listWebhookEvents(ctx({}))
    expect(list.body.data[0]).toMatchObject({ status: 'RECEIVED', replayable: false, dismissable: false })

    const out = await mod.redriveStaleEvents({}, { waitUntil() {} })
    expect(out.redriven).toEqual([])
    expect(world.t.webhook_events[0].redrives).toBe(0)
  })

  it('replay and dismiss answer 409 "still being processed" for such a row', async () => {
    const { world, mod } = rig([failedRow()])
    await mod.recordEvent(world.db, { eventKey: 'charge.success:1', eventType: 'charge.success', reference: 'r1', payload: {} })
    const rep = await mod.replayWebhookEvent(ctx({ params: { id: 'e1' } }))
    expect(rep.status).toBe(409)
    const dis = await mod.dismissWebhookEvent(ctx({ params: { id: 'e1' }, body: {} }))
    expect(dis.status).toBe(409)
  })

  it('once the worker really died (no pickup for 15+ minutes) the row is stuck again and the re-drive takes it', async () => {
    const { world, mod } = rig([failedRow({ status: 'RECEIVED', attempts: 2, last_attempt_at: hoursAgo(1) })])
    const list = await mod.listWebhookEvents(ctx({}))
    expect(list.body.data[0]).toMatchObject({ replayable: true, dismissable: true })
    const out = await mod.redriveStaleEvents({}, { waitUntil() {} })
    expect(out.redriven).toEqual(['e1'])
    expect(world.t.webhook_events[0].redrives).toBe(1)
  })

  it('a replay stamps the pickup too (a second admin / the sweep cannot start it again)', async () => {
    const { world, mod } = rig([failedRow()])
    const out = await mod.replayWebhookEvent(ctx({ params: { id: 'e1' } }))
    expect(out.status).toBe(200)
    expect(Date.parse(world.t.webhook_events[0].last_attempt_at)).toBeGreaterThan(Date.now() - 10000)
  })

  it('the attention filter measures from last_attempt_at', async () => {
    const { world, mod } = rig([failedRow()])
    await mod.listWebhookEvents(ctx({ query: { status: 'ATTENTION' } }))
    const call = world.calls.find(x => x.table === 'webhook_events')
    expect(call.or[0]).toMatch(/and\(status\.eq\.RECEIVED,last_attempt_at\.lt\./)
  })

  it('before migration 0090 everything falls back to received_at instead of failing', async () => {
    const { world, mod } = rig([failedRow({ status: 'RECEIVED', attempts: 2 })])
    // first query naming the column fails, as PostgREST would
    world.failNext('webhook_events', 'select', { code: '42703', message: 'column webhook_events.last_attempt_at does not exist' })
    const list = await mod.listWebhookEvents(ctx({}))
    expect(list.status).toBe(200)
    expect(list.body.data[0]).toMatchObject({ status: 'RECEIVED', replayable: true })   // received 3h ago, no better clock available
  })

  it('the dashboard count uses the same clock (and falls back before 0090)', () => {
    const src = fs.readFileSync(new URL('../src/controllers/admin.controller.js', import.meta.url), 'utf8')
    expect(src).toMatch(/stuckCount\('last_attempt_at'\)/)
    expect(src).toMatch(/stuckCount\('received_at'\)/)
  })

  it('migration 0090 adds the column NOT NULL DEFAULT now() and backfills from received_at', () => {
    const sql = fs.readFileSync(new URL('../supabase/migrations/0090_webhooks_round16.sql', import.meta.url), 'utf8')
    expect(sql).toMatch(/add column if not exists last_attempt_at timestamptz not null default now\(\)/)
    expect(sql).toMatch(/set last_attempt_at = received_at/)
  })
})

// ── G1 / B2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('G1: contest finishes a fraud-claim dispute (evidence id) and declines for the disputed amount', () => {
  const basePayment = o => ({ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', user_id: 'u1', scan_id: 's1', fix_tier: 'FIX', amount_cents: 2900, currency: 'USD', paid_at: '2026-09-28T10:00:00Z', dispute_id: '777', dispute_evidence_id: null, ...o })
  const rig = ({ paymentOver = {}, claimed = null, stub = {} } = {}) => {
    const calls = []
    const world = createWorld({
      users: [{ id: 'u1', email: 'buyer@x.co', name: 'Bea' }],
      payments: [basePayment(paymentOver)],
      scans: [{ id: 's1', status: 'FIX_DELIVERED', fix_payment_id: 'p1', fix_tier: 'FIX', verification_code: 'ABCD1234', verification_status: 'ACTIVE' }],
    })
    const paystack = {
      listDisputes: async () => ({ data: [] }),
      fetchDispute: async () => ({ data: { refund_amount: claimed } }),
      addDisputeEvidence: async (e, id, f) => { calls.push(['evidence', id, f]); return { status: true, data: { id: 4242 } } },
      getDisputeUploadUrl: async (e, id, name) => ({ signedUrl: 'https://s3.example/put', fileName: name }),
      uploadDisputeProof: async () => {},
      declineDispute: async (e, id, o) => { calls.push(['decline', id, o]); return { status: true } },
      ...stub,
    }
    return { world, calls, ...load(world, { 'services/paystack.service.js': paystack }) }
  }
  const env = { FRONTEND_URL: 'https://usepassthrough.com' }
  const evidence = mod => mod.submitDisputeEvidence(ctx({ env, params: { reference: 'ref1' }, body: { customerPhone: '+254 700 000000' } }))
  const contest = mod => mod.contestPaymentDispute(ctx({ env, params: { reference: 'ref1' } }))

  it('sending evidence remembers Paystack\'s evidence id (tied to the dispute) and tells the admin to Contest next', async () => {
    const { mod, world } = rig()
    const out = await evidence(mod)
    expect(out.status).toBe(200)
    expect(world.t.payments[0].dispute_evidence_id).toBe('777:4242')
    expect(out.body.message).toMatch(/press Contest next/)
  })

  it('a contest after evidence quotes the evidence id; one without evidence sends none', async () => {
    const a = rig()
    await evidence(a.mod)
    await contest(a.mod)
    expect(a.calls.find(c => c[0] === 'decline')[2].evidence).toBe('4242')
    restore(); restore = null
    const b = rig()
    await contest(b.mod)
    const decl = b.calls.find(c => c[0] === 'decline')[2]
    expect(decl.evidence).toBeUndefined()
  })

  it('evidence stored for ANOTHER dispute on the same payment is never quoted', async () => {
    const { mod, calls } = rig({ paymentOver: { dispute_evidence_id: '555:4242' } })
    await contest(mod)
    expect(calls.find(c => c[0] === 'decline')[2].evidence).toBeUndefined()
  })

  it('the decline carries the amount the dispute is for, not always the whole payment', async () => {
    const part = rig({ claimed: 1000 })
    await contest(part.mod)
    expect(part.calls.find(c => c[0] === 'decline')[2].refundAmount).toBe(1000)
    restore(); restore = null
    const whole = rig({ claimed: null })
    await contest(whole.mod)
    expect(whole.calls.find(c => c[0] === 'decline')[2].refundAmount).toBe(2900)
  })

  it('a refusal that names evidence, with none on file, tells the admin the next step', async () => {
    const { mod } = rig({ stub: { declineDispute: async () => { throw Object.assign(new Error('evidence is required for a fraud claim'), { paystackRejected: true }) } } })
    const out = await contest(mod)
    expect(out.status).toBe(422)
    expect(out.body.message).toMatch(/Send evidence/)
  })

  it('a contest still works when the evidence column is missing (before 0090)', async () => {
    const { mod, world, calls } = rig()
    world.failNext('payments', 'select', { code: '42703', message: 'column payments.dispute_evidence_id does not exist' })
    const out = await contest(mod)
    expect(out.status).toBe(200)
    expect(calls.find(c => c[0] === 'decline')).toBeTruthy()
  })

  it('the service sends `evidence` on the resolve call only when there is one', async () => {
    const seen = []
    vi.stubGlobal('fetch', async (url, o) => { seen.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ status: true }) } })
    const svc = require_('../src/services/paystack.service.js')
    await svc.declineDispute({ PAYSTACK_SECRET_KEY: 'sk' }, '1', { message: 'm', refundAmount: 5, uploadedFilename: 'f.pdf', evidence: '4242' })
    await svc.declineDispute({ PAYSTACK_SECRET_KEY: 'sk' }, '1', { message: 'm', refundAmount: 5, uploadedFilename: 'f.pdf' })
    expect(seen[0]).toMatchObject({ resolution: 'declined', evidence: '4242' })
    expect('evidence' in seen[1]).toBe(false)
  })

  it('B2: the Accept confirmation no longer promises the whole payment', () => {
    const src = fs.readFileSync(new URL('../frontend/src/pages/admin/AdminPayments.jsx', import.meta.url), 'utf8')
    expect(src).toMatch(/refunds the buyer the disputed amount \(up to/)
  })
})
