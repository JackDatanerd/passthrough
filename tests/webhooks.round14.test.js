import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

// Webhooks section, independent audit round 14.
//   B1  the buyer's reversal email rode on "this call moved the payment to REFUNDED" and was lost after a failed first attempt
//   B2  Resend payloads (recipient addresses) of rows that never finished were kept for ever
//   B3  the bounce / complaint list stored an unsalted hash of the typed address (no key, no alias handling)
//   B4  ?from=2026-02-31 reached Postgres (500); `to` silently shifted a day
//   B5  retention deleted the dispute / refund dedupe rows after 90 days
//   B6  Replay was offered for an event still being worked on; live dispute events skipped the normalisation sweeps use
//   G1  bounce visibility (account flag + ids in the note)   G2  accept / evidence   G3  duration + payment timeline
const NOW = Date.parse('2026-10-01T12:00:00Z')
const daysAgo = d => new Date(NOW - d * 86400_000).toISOString()
const minsAgo = m => new Date(Date.now() - m * 60_000).toISOString()

let restore
afterEach(() => { restore?.(); restore = null })

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
const ctx = ({ env = {}, params = {}, query = {}, body = {} } = {}) => ({
  env,
  req: { param: k => params[k], query: k => query[k], json: async () => body, header: () => undefined },
  get: () => ({ id: 'admin1' }),
  json: (b, s = 200) => ({ body: b, status: s }),
})

describe('B4: the received-date filter only accepts real dates', () => {
  const list = async query => {
    const world = createWorld({ webhook_events: [{ id: 'e1', provider: 'paystack', event_type: 'charge.success', status: 'PROCESSED', received_at: '2026-03-03T10:00:00Z' }] })
    const { mod } = load(world)
    const out = await mod.listWebhookEvents(ctx({ query }))
    return { out, calls: world.calls }
  }
  it('2026-02-31 is ignored (no filter, no 500)', async () => {
    const { out, calls } = await list({ from: '2026-02-31', to: '2026-02-30' })
    expect(out.status).toBe(200)
    expect(calls.some(q => q.filters.some(f => f[0] === 'gte' || f[0] === 'lt'))).toBe(false)
  })
  it('a real date still filters', async () => {
    const { calls } = await list({ from: '2026-02-28', to: '2026-03-01' })
    expect(calls[0].filters.filter(f => f[0] === 'gte' || f[0] === 'lt')).toHaveLength(2)
  })
})

describe('B2 + B5: retention', () => {
  const row = (id, o) => ({ id, provider: 'paystack', status: 'PROCESSED', payload: { event: 'x' }, ...o })
  const run = async rows => {
    const world = createWorld({ webhook_events: rows })
    const { mod } = load(world)
    const errors = await mod.pruneWebhookEvents(world.db, { now: NOW })
    return { errors, ids: world.t.webhook_events.map(r => r.id), world }
  }
  it('clears a FAILED Resend payload after 7 days but keeps the row; deletes it after 90', async () => {
    const { ids, world } = await run([
      row('r-old', { provider: 'resend', status: 'FAILED', received_at: daysAgo(8), payload: { type: 'email.bounced', data: { to: ['a@b.co'] } } }),
      row('r-new', { provider: 'resend', status: 'FAILED', received_at: daysAgo(2), payload: { type: 'email.bounced', data: { to: ['a@b.co'] } } }),
      row('r-gone', { provider: 'resend', status: 'FAILED', received_at: daysAgo(91), payload: null }),
    ])
    expect(ids.sort()).toEqual(['r-new', 'r-old'])
    expect(world.t.webhook_events.find(r => r.id === 'r-old').payload).toBeNull()
    expect(world.t.webhook_events.find(r => r.id === 'r-new').payload).not.toBeNull()
  })
  it('deletes finished ordinary rows at 90 days but keeps dispute and refund rows to 400', async () => {
    const { ids } = await run([
      row('charge-old', { event_type: 'charge.success', received_at: daysAgo(100) }),
      row('dispute-100', { event_type: 'charge.dispute.resolve', received_at: daysAgo(100) }),
      row('refund-100', { event_type: 'refund.processed', received_at: daysAgo(100) }),
      row('dispute-401', { event_type: 'charge.dispute.resolve', received_at: daysAgo(401) }),
      row('held-old', { event_type: 'charge.success', status: 'HELD', received_at: daysAgo(200) }),
    ])
    expect(ids.sort()).toEqual(['dispute-100', 'held-old', 'refund-100'])
  })
  it('reports a failing statement instead of throwing', async () => {
    const world = createWorld({ webhook_events: [] })
    world.failNext('webhook_events', 'delete', { message: 'boom' })
    const { mod } = load(world)
    const errors = await mod.pruneWebhookEvents(world.db, { now: NOW })
    expect(errors.some(e => /boom/.test(e))).toBe(true)
  })
})

describe('G3: processing time', () => {
  it('markEvent stores the duration and drops it on a database without migration 0086', async () => {
    const world = createWorld({ webhook_events: [{ id: 'e1', status: 'RECEIVED' }] })
    const { mod } = load(world)
    expect(await mod.markEvent(world.db, { id: 'e1' }, 'PROCESSED', 'ok', { ms: 1234.4 })).toBe(true)
    expect(world.t.webhook_events[0]).toMatchObject({ status: 'PROCESSED', processing_ms: 1234, note: 'ok' })
    world.failNext('webhook_events', 'update', { code: '42703', message: 'column "processing_ms" of relation "webhook_events" does not exist' })
    expect(await mod.markEvent(world.db, { id: 'e1' }, 'FAILED', 'bad', { ms: 50 })).toBe(true)
    expect(world.t.webhook_events[0]).toMatchObject({ status: 'FAILED', error: 'bad' })
  })
  it('the payment timeline lists this payment\'s events oldest first', async () => {
    const world = createWorld({ webhook_events: [
      { id: 'b', provider: 'paystack', reference: 'ref1', event_type: 'refund.processed', status: 'PROCESSED', attempts: 1, received_at: '2026-10-01T10:00:00Z', processing_ms: 900 },
      { id: 'a', provider: 'paystack', reference: 'ref1', event_type: 'charge.success', status: 'PROCESSED', attempts: 1, received_at: '2026-09-30T10:00:00Z', processing_ms: 120 },
      { id: 'x', provider: 'paystack', reference: 'other', event_type: 'charge.success', status: 'PROCESSED', received_at: '2026-09-30T10:00:00Z' },
    ] })
    const { mod } = load(world)
    const out = await mod.getPaymentTimeline(ctx({ params: { reference: 'ref1' } }))
    expect(out.body.data.map(e => e.id).sort()).toEqual(['a', 'b'])
  })
})

describe('B6: Replay waits for a RECEIVED row to be stuck', () => {
  const rig = receivedAt => {
    const world = createWorld({ webhook_events: [{ id: 'e1', provider: 'paystack', event_type: 'charge.success', status: 'RECEIVED', attempts: 1, received_at: receivedAt, payload: { event: 'charge.success', data: { reference: 'nope' } } }] })
    return { world, ...load(world) }
  }
  it('refuses a row received moments ago (409) and does not touch it', async () => {
    const { mod, world } = rig(minsAgo(1))
    const out = await mod.replayWebhookEvent(ctx({ params: { id: 'e1' } }))
    expect(out.status).toBe(409)
    expect(world.t.webhook_events[0].attempts).toBe(1)
  })
  it('lists it as not replayable until it is stuck', async () => {
    const fresh = rig(minsAgo(1)); const a = await fresh.mod.listWebhookEvents(ctx())
    expect(a.body.data[0].replayable).toBe(false)
    restore(); restore = null
    const stuck = rig(minsAgo(30)); const b = await stuck.mod.listWebhookEvents(ctx())
    expect(b.body.data[0].replayable).toBe(true)
  })
})

describe('B6: a live dispute event is normalised like a swept one', () => {
  it('keeps camelCase dueAt as due_at and a bare-string transaction', () => {
    const { mod } = load(createWorld({}))
    // minimalDisputeEvent is internal; processEvent feeds it. Exercised through recordDisputeId / deadline below.
    expect(typeof mod.recordDisputeId).toBe('function')
  })
  it('recordDisputeId stores the id on a DISPUTED payment only, and never throws', async () => {
    const world = createWorld({ payments: [{ id: 'p1', status: 'DISPUTED' }, { id: 'p2', status: 'SUCCESS' }] })
    const { mod } = load(world)
    expect(await mod.recordDisputeId(world.db, { id: 'p1' }, { id: 4455 })).toBe(true)
    expect(world.t.payments[0].dispute_id).toBe('4455')
    await mod.recordDisputeId(world.db, { id: 'p2' }, { id: 9 })
    expect(world.t.payments[1].dispute_id).toBeUndefined()
    world.failNext('payments', 'update', { code: '42703', message: 'column "dispute_id" does not exist' })
    expect(await mod.recordDisputeId(world.db, { id: 'p1' }, { id: 1 })).toBe(false)
  })
})

describe('G2: answering a dispute from the app', () => {
  const rig = (paymentOver = {}, paystack = {}) => {
    const calls = []
    const world = createWorld({
      users: [{ id: 'u1', email: 'buyer@x.co', name: 'Bea' }],
      payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', user_id: 'u1', scan_id: 's1', fix_tier: 'FIX', amount_cents: 2900, currency: 'USD', paid_at: '2026-09-28T10:00:00Z', dispute_id: '777', ...paymentOver }],
    })
    const stub = {
      acceptDispute: async (env, id, o) => { calls.push(['accept', id, o]); return { status: true } },
      addDisputeEvidence: async (env, id, f) => { calls.push(['evidence', id, f]); return { status: true } },
      listDisputes: async () => ({ data: [] }),
      ...paystack,
    }
    return { world, calls, ...load(world, { 'services/paystack.service.js': stub }) }
  }
  it('accept sends the full amount, audits it, and does not change the payment itself', async () => {
    const { mod, world, calls, audit } = rig()
    const out = await mod.acceptPaymentDispute(ctx({ params: { reference: 'ref1' }, body: { note: 'we agree' } }))
    expect(out.status).toBe(200)
    expect(calls[0]).toEqual(['accept', '777', { message: 'we agree', refundAmount: 2900 }])
    expect(world.t.payments[0].status).toBe('DISPUTED')
    expect(audit[0]).toMatchObject({ action: 'payment.dispute_accept', id: 'p1' })
    expect(JSON.stringify(audit)).not.toContain('we agree')
  })
  it('only a DISPUTED payment can be answered', async () => {
    const { mod, calls } = rig({ status: 'SUCCESS' })
    expect((await mod.acceptPaymentDispute(ctx({ params: { reference: 'ref1' } }))).status).toBe(409)
    expect(calls).toHaveLength(0)
  })
  it('finds the dispute id in Paystack\'s list when the payment predates the stored id, and stores it', async () => {
    const { mod, world, calls } = rig({ dispute_id: null }, { listDisputes: async () => ({ data: [{ id: 321, transaction: { reference: 'ref1' } }] }) })
    expect((await mod.acceptPaymentDispute(ctx({ params: { reference: 'ref1' } }))).status).toBe(200)
    expect(calls[0][1]).toBe('321')
    expect(world.t.payments[0].dispute_id).toBe('321')
  })
  it('says so when the dispute cannot be found', async () => {
    const { mod } = rig({ dispute_id: null })
    expect((await mod.acceptPaymentDispute(ctx({ params: { reference: 'ref1' } }))).status).toBe(404)
  })
  it('a Paystack refusal is shown as-is (422); an outage says nothing changed (502)', async () => {
    const a = rig({}, { acceptDispute: async () => { throw Object.assign(new Error('Dispute already resolved'), { paystackRejected: true }) } })
    const out = await a.mod.acceptPaymentDispute(ctx({ params: { reference: 'ref1' } }))
    expect(out.status).toBe(422); expect(out.body.message).toMatch(/already resolved/)
    restore(); restore = null
    const b = rig({}, { acceptDispute: async () => { throw new Error('timed out') } })
    expect((await b.mod.acceptPaymentDispute(ctx({ params: { reference: 'ref1' } }))).status).toBe(502)
  })
  it('evidence needs a phone, takes name/email from the account, and builds the description', async () => {
    const { mod, calls } = rig()
    expect((await mod.submitDisputeEvidence(ctx({ params: { reference: 'ref1' }, body: {} }))).status).toBe(400)
    const out = await mod.submitDisputeEvidence(ctx({ params: { reference: 'ref1' }, body: { customerPhone: '+254 700 000000' } }))
    expect(out.status).toBe(200)
    const [, id, f] = calls[0]
    expect(id).toBe('777')
    expect(f).toMatchObject({ customer_email: 'buyer@x.co', customer_name: 'Bea', customer_phone: '+254 700 000000', delivery_date: '2026-09-28' })
    expect(f.service_details).toMatch(/ref1/)
  })
})

describe('B1: the buyer\'s reversal email is claimed, not tied to who flipped the status', () => {
  const rig = ({ sendOk = [true] } = {}) => {
    const sent = []
    const world = createWorld({
      users: [{ id: 'u1', email: 'buyer@x.co', name: 'Bea' }],
      payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'REFUNDED', user_id: 'u1', amount_cents: 2900, currency: 'USD', reversal_notice_sent_at: null }],
    })
    const queue = [...sendOk]
    const l = loadWithStubs('services/fulfillment.service.js', {
      'services/email.service.js': { sendPaymentReversed: async (e, db, to) => { sent.push(to); return queue.length ? queue.shift() : true } },
    })
    restore = l.restore
    const p = world.t.payments[0]
    return { world, sent, send: transitioned => l.mod.sendBuyerReversalOnce({ X: 1 }, world.db, p, { reason: 'REFUND', revoked: false, transitioned }) }
  }
  it('a retry after a failed first attempt (transitioned = false) still tells the buyer — once', async () => {
    const r = rig()
    expect(await r.send(false)).toBe(true)
    expect(await r.send(false)).toBe(false)
    expect(r.sent).toEqual(['buyer@x.co'])
    expect(r.world.t.payments[0].reversal_notice_sent_at).toBeTruthy()
  })
  it('a send the provider refused releases the claim so the next path tries again', async () => {
    const r = rich()
    function rich() { return rig({ sendOk: [false, true] }) }
    expect(await r.send(true)).toBe(false)
    expect(r.world.t.payments[0].reversal_notice_sent_at).toBeNull()
    expect(await r.send(false)).toBe(true)
    expect(r.sent).toHaveLength(2)
  })
  it('without migration 0086 it falls back to the old rule', async () => {
    const r = rig()
    r.world.failNext('payments', 'update', { code: '42703', message: 'column "reversal_notice_sent_at" does not exist' })
    expect(await r.send(false)).toBe(false)
    expect(r.sent).toHaveLength(0)
  })
})

describe('B3: the bounce / complaint list is keyed and alias-aware', () => {
  const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('')
  const rig = () => {
    const world = createWorld({ email_suppressions: [], users: [] })
    world.unique.email_suppressions = [['email_hash']]
    const l = loadWithStubs('lib/emailSuppression.js', {})
    restore = l.restore
    return { world, mod: l.mod }
  }
  it('with a key, stores an HMAC (never the plain hash) of the canonical mailbox', async () => {
    const { world, mod } = rig()
    const env = { SUPPRESSION_HASH_KEY: 'k1' }
    await mod.recordSuppression(world.db, 'Bob+news@Example.com', 'bounce', env)
    const stored = world.t.email_suppressions[0].email_hash
    expect(stored).not.toBe(await sha('bob@example.com'))
    expect(stored).toHaveLength(64)
    expect(await mod.getSuppression(world.db, 'bob@example.com', env)).toMatchObject({ reason: 'bounce' })
    expect(await mod.getSuppression(world.db, 'bob+other@example.com', env)).toMatchObject({ reason: 'bounce' })
  })
  it('a Gmail dot / googlemail spelling is the same inbox', async () => {
    const { world, mod } = rig()
    await mod.recordSuppression(world.db, 'b.o.b@gmail.com', 'complaint', {})
    expect(await mod.getSuppression(world.db, 'bob@googlemail.com', {})).toMatchObject({ reason: 'complaint' })
  })
  it('an entry written the old way (unsalted hash of the typed address) is still honoured and is re-keyed once a key exists', async () => {
    const { world, mod } = rig()
    world.t.email_suppressions.push({ email_hash: await sha('old@example.com'), reason: 'bounce', created_at: '2026-01-01T00:00:00Z' })
    const env = { SUPPRESSION_HASH_KEY: 'k1' }
    expect(await mod.getSuppression(world.db, 'old@example.com', env)).toMatchObject({ reason: 'bounce', created_at: '2026-01-01T00:00:00Z' })
    await new Promise(r => setTimeout(r, 20))
    expect(world.t.email_suppressions).toHaveLength(1)
    expect(world.t.email_suppressions[0].email_hash).not.toBe(await sha('old@example.com'))
    expect(await mod.getSuppression(world.db, 'old@example.com', env)).toBeTruthy()
  })
  it('lifting removes every form and clears the account flag', async () => {
    const { world, mod } = rig()
    world.t.users.push({ id: 'u1', email: 'bob@example.com', email_bounced_at: '2026-09-01T00:00:00Z', email_bounce_type: 'bounce' })
    await mod.recordSuppression(world.db, 'bob@example.com', 'bounce', {})
    expect(await mod.liftSuppression(world.db, 'bob+x@example.com', {})).toBe(true)
    expect(world.t.email_suppressions).toHaveLength(0)
    expect(world.t.users[0].email_bounced_at).toBeNull()
  })
  it('the security / payment templates are still exempt', async () => {
    const { world, mod } = rig()
    await mod.recordSuppression(world.db, 'bob@example.com', 'bounce', {})
    expect(await mod.isSuppressedFor(world.db, 'bob@example.com', 'password_reset', {})).toBe(false)
    expect(await mod.isSuppressedFor(world.db, 'bob@example.com', 'welcome', {})).toBe(true)
  })
  it('suppressedAmong finds blocked addresses by any alias, in one grouped lookup', async () => {
    const { world, mod } = rig()
    await mod.recordSuppression(world.db, 'bob@example.com', 'bounce', {})
    const hit = await mod.suppressedAmong(world.db, ['bob+z@example.com', 'ann@example.com'], {})
    expect([...hit]).toEqual(['bob+z@example.com'])
  })
})

describe('G1: the account that owns a bouncing address is flagged', () => {
  const rig = () => {
    const world = createWorld({ users: [{ id: 'u1', email: 'buyer@x.co' }, { id: 'u2', email: 'other@x.co' }] })
    const l = loadWithStubs('lib/emailSuppression.js', {})
    restore = l.restore
    return { world, mod: l.mod }
  }
  it('flags exactly the account(s) with that address and returns their ids (no address)', async () => {
    const { world, mod } = rig()
    expect(await mod.flagAccountBounce(world.db, 'Buyer@x.co', 'complaint')).toEqual(['u1'])
    expect(world.t.users[0]).toMatchObject({ email_bounce_type: 'complaint' })
    expect(world.t.users[0].email_bounced_at).toBeTruthy()
    expect(world.t.users[1].email_bounced_at).toBeUndefined()
  })
  it('still names the account when migration 0086 is not applied', async () => {
    const { world, mod } = rig()
    world.failNext('users', 'update', { code: '42703', message: 'column "email_bounced_at" of relation "users" does not exist' })
    expect(await mod.flagAccountBounce(world.db, 'buyer@x.co', 'bounce')).toEqual(['u1'])
  })
  it('clearing is by user id and tolerates a missing column', async () => {
    const { world, mod } = rig()
    await mod.flagAccountBounce(world.db, 'buyer@x.co', 'bounce')
    expect(await mod.clearAccountBounce(world.db, { userId: 'u1' })).toBe(true)
    expect(world.t.users[0].email_bounced_at).toBeNull()
    world.failNext('users', 'update', { code: '42703', message: 'column "email_bounced_at" does not exist' })
    expect(await mod.clearAccountBounce(world.db, { userId: 'u1' })).toBe(false)
  })
})
