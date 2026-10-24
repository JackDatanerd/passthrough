// Webhooks round 30 (section 8, independent pass).
//   B1  sweepDisputes: a closed dispute with an unrecognised resolution is marked answered and paged, not skipped in silence.
//   B2  a reminder for a dispute the payment does not track no longer overwrites the tracked dispute id / deadline.
//   G1  the setup self-test warns about a test-mode Paystack key on a public https URL.
//   X1  ats.service stripDateNoise: "4G / 5G" strip is Unicode-aware (no `u` flag used to eat "10GB" -> " B").
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')
let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr })

function setup(over = {}) {
  const w = createWorld({ payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', dispute_id: '200', dispute_due_at: '2030-01-01T00:00:00.000Z', amount_cents: 2900, currency: 'USD', scan_id: 's1', user_id: 'u1', ...over }],
    webhook_events: [], system_state: [], scans: [], users: [], commission_ledger: [] })
  w.unique.webhook_events = [['provider', 'event_key']]
  const alerts = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => w.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async (e, s) => { alerts.push(s); return true } },
    'services/paystack.service.js': { listDisputes: async () => ({ data: [] }), fetchDispute: async () => ({ data: {} }) },
  })
  restore = l.restore
  return { w, mod: l.mod, alerts }
}
const sweep = (mod, w, d) => mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'k' }, { waitUntil() {} }, w.db, { list: async () => ({ data: [d] }) })

describe('B1: unrecognised resolution', () => {
  it('marks the payment answered and emails the owner', async () => {
    const { w, mod, alerts } = setup()
    const r = await sweep(mod, w, { id: 200, status: 'archived', resolution: null, transaction: { reference: 'ref1' } })
    expect(r.actioned).toHaveLength(0)
    expect(w.t.payments[0].dispute_answer).toBe('resolved')
    expect(w.t.payments[0].status).toBe('DISPUTED')
    expect(alerts.some(s => /unrecognised outcome/.test(s))).toBe(true)
  })
})

describe('B2: stale reminder', () => {
  it('leaves the tracked dispute id and deadline alone', async () => {
    const { w, mod } = setup()
    const ev = { event: 'charge.dispute.remind', data: { id: 100, status: 'awaiting-merchant-feedback', due_at: '2030-02-02T00:00:00.000Z', transaction: { reference: 'ref1' } } }
    const body = JSON.stringify(ev)
    const key = await (async () => { const { sha256Bytes } = require_('../src/lib/crypto'); return sha256Bytes(new TextEncoder().encode(body)) })()
    expect(typeof mod.eventKeyFor(ev, key)).toBe('string')
    // run the handler through a stored-event replay
    w.t.webhook_events.push({ id: 'e1', provider: 'paystack', event_key: 'k', event_type: ev.event, reference: 'ref1', status: 'FAILED', attempts: 1, payload: ev, received_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() })
    const ctx = { env: {}, executionCtx: { waitUntil() {} }, req: { param: () => 'e1' }, get: () => ({ id: 'a' }), json: (b, s) => ({ b, s }) }
    await mod.replayWebhookEvent(ctx)
    expect(w.t.payments[0].dispute_id).toBe('200')
    expect(w.t.payments[0].dispute_due_at).toBe('2030-01-01T00:00:00.000Z')
  })
})

describe('G1: self-test key mode', () => {
  it('warns for sk_test_ on a public https origin, not on localhost', async () => {
    const { w, mod } = setup()
    const env = { PAYSTACK_SECRET_KEY: 'sk_test_abc' }
    const pub = await mod.buildSelfTest(env, w.db, { origin: 'https://api.example.com' })
    expect(pub.checks.find(c => c.id === 'paystack-secret').status).toBe('warn')
    const loc = await mod.buildSelfTest(env, w.db, { origin: 'http://localhost:4000' })
    expect(loc.checks.find(c => c.id === 'paystack-secret').status).toBe('ok')
  })
})

describe('X1: ats stripDateNoise', () => {
  it('keeps 10GB and ABC5G, still strips a bare 5G', () => {
    const src = require_('node:fs').readFileSync(new URL('../src/services/ats.service.js', import.meta.url), 'utf8')
    const line = src.split('\n').find(l => l.includes('// 4G / 5G'))
    const re = eval(line.match(/replace\((\/.*\/[a-z]*),/)[1])
    expect(re.flags).toContain('u')
    expect('Scaled to 10GB'.replace(re, ' ')).toBe('Scaled to 10GB')
    expect('ABC5G'.replace(re, ' ')).toBe('ABC5G')
    expect('Rolled out 5G network'.replace(re, ' ')).toBe('Rolled out   network')
  })
})
