// Webhooks round 23: B1 Resend has its own (larger) limiter; B2 an accepted dispute on an already-REFUNDED payment says so;
// B3 an archived dispute is closed; G1 charge.success metadata that disagrees with the payment row alerts the owner.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

let restore, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { restore?.(); restore = null; console.error = realErr })

function load(world, alerts = []) {
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
    'services/email.service.js': { sendOwnerAlert: async (e, s, m) => { alerts.push({ s, m }); return true }, sendPaymentReversed: async () => true },
    'services/referral.service.js': { recordConversion: async () => ({ ok: true }), notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': {},
  })
  restore = l.restore
  return l.mod
}
async function replay(mod, world, ev, key) {
  world.t.webhook_events.push({ id: 'e1', provider: 'paystack', event_key: key, event_type: ev.event, reference: 'ref1', status: 'FAILED', attempts: 1,
    payload: ev, received_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() })
  const ctx = { env: {}, executionCtx: { waitUntil() {} }, req: { param: () => 'e1' }, get: () => ({ id: 'admin1' }), json: (b, s) => ({ b, s }) }
  return mod.replayWebhookEvent(ctx)
}

describe('B1: Resend webhook limiter', () => {
  it('the resend route uses its own limiter, with a larger ceiling than the Paystack one', () => {
    const routes = fs.readFileSync('src/routes/webhooks.routes.js', 'utf8')
    expect(routes).toMatch(/post\('\/resend', rl\.webhookResend/)
    expect(routes).toMatch(/post\('\/resend\/', rl\.webhookResend/)
    expect(routes).toMatch(/post\('\/paystack', rl\.webhook,/)
    const rl = require_('../src/middleware/rateLimiter')
    expect(typeof rl.webhookResend).toBe('function')
  })
})

describe('B2: accepted dispute on an already REFUNDED payment', () => {
  it('says the sale is already refunded instead of telling the owner to Reverse it', async () => {
    const alerts = []
    const world = createWorld({ payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'REFUNDED', amount_cents: 900, currency: 'USD', scan_id: 's1', user_id: 'u1' }], webhook_events: [] })
    const mod = load(world, alerts)
    const ev = { event: 'charge.dispute.resolve', data: { id: 5, status: 'resolved', resolution: 'merchant-accepted', refund_amount: 900, transaction: { reference: 'ref1' } } }
    const r = await replay(mod, world, ev, 'charge.dispute.resolve:5')
    expect(r.b.data.note).toBe('dispute lost — payment already REFUNDED')
    const text = alerts.map(a => a.m).join('\n')
    expect(text).toMatch(/already REFUNDED/)
    expect(text).not.toMatch(/Use Admin → Payments → Reverse/)
    expect(world.t.payments[0].status).toBe('REFUNDED')
  })
})

describe('B3: archived dispute is not open', () => {
  it('sweepDisputes leaves a SUCCESS payment alone when Paystack lists its dispute as archived with no resolution', async () => {
    const world = createWorld({ payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'SUCCESS', amount_cents: 900, currency: 'USD', scan_id: 's1' }], webhook_events: [] })
    const mod = load(world)
    const list = async () => ({ data: [{ id: 9, status: 'archived', resolution: null, refund_amount: 900, transaction: { reference: 'ref1' } }] })
    const r = await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'sk' }, { waitUntil() {} }, world.db, { list })
    expect(r.actioned).toHaveLength(0)
    expect(world.t.payments[0].status).toBe('SUCCESS')
  })
})

describe('G1: charge.success metadata vs payment row', () => {
  async function run(meta) {
    const alerts = []
    const world = createWorld({ payments: [{ id: 'p1', paystack_ref: 'ref1', status: 'SUCCESS', amount_cents: 900, currency: 'USD', scan_id: 's1', user_id: 'u1' }], webhook_events: [] })
    const mod = load(world, alerts)
    const ev = { event: 'charge.success', data: { id: 1, reference: 'ref1', amount: 900, currency: 'USD', metadata: meta } }
    await replay(mod, world, ev, 'charge.success:1')
    return alerts.filter(a => /metadata does not match/.test(a.s))
  }
  it('alerts when the metadata names a different scan or user', async () => {
    const a = await run({ scanId: 'other', userId: 'u1' })
    expect(a).toHaveLength(1)
    expect(a[0].m).toMatch(/scanId: metadata other vs payment s1/)
  })
  it('stays quiet when the metadata agrees or is absent', async () => {
    expect(await run({ scanId: 's1', userId: 'u1' })).toHaveLength(0)
    expect(await run(undefined)).toHaveLength(0)
  })
})
