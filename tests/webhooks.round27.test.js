import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')

// Webhooks section, independent audit round 27.
//   B1  the sweep skipped an ACCEPTED (lost) resolution of an older dispute while a newer one was tracked; the live handler reverses the sale
//   G1  Accept / Contest / Send evidence could not carry the merchant's note or a delivery address from the admin UI (UI side: frontend test)
//   G2  the proof of delivery and Paystack's delivery_date used the PAYMENT date; scans.fix_delivered_at (0110) is the delivery time
let restore, realErr
afterEach(() => { restore?.(); restore = null; if (realErr) console.error = realErr })

const ctx = ({ env = {}, params = {}, body = {}, user = { id: 'admin1' } } = {}) => ({
  env, executionCtx: { waitUntil() {} },
  req: { param: k => params[k], query: () => undefined, json: async () => body, header: () => undefined },
  get: () => user,
  json: (b, s = 200) => ({ body: b, status: s }),
})
function load(world, paystack = {}) {
  const audit = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/adminAudit.js': { logAdminAction: async (c, db, action, type, id, meta) => { audit.push({ action, id, meta }) } },
    'services/email.service.js': { sendOwnerAlert: async () => true, sendPaymentReversed: async () => true },
    'services/referral.service.js': { notifyPartnerReversal: async () => {} },
    'services/paystack.service.js': { listDisputes: async () => ({ data: [] }), fetchDispute: async () => ({ data: { refund_amount: null } }), ...paystack },
  })
  restore = l.restore
  return { mod: l.mod, audit }
}
const pay = o => ({ id: 'p1', paystack_ref: 'ref1', status: 'DISPUTED', user_id: 'u1', scan_id: 's1', fix_tier: 'FIX', amount_cents: 2900, currency: 'USD', paid_at: '2026-09-28T10:00:00Z', dispute_id: '777', ...o })

describe('B1: an accepted resolution of an older dispute is not skipped by the sweep', () => {
  const sweep = async (resolution, trackedId = '200') => {
    realErr = console.error; console.error = () => {}
    const world = createWorld({ payments: [pay({ dispute_id: trackedId })], webhook_events: [], scans: [{ id: 's1', fix_payment_id: 'p1' }], users: [], commission_ledger: [], system_state: [] })
    world.unique.webhook_events = [['provider', 'event_key']]
    const { mod } = load(world)
    const d = { id: 100, status: 'resolved', resolution, refund_amount: 2900, transaction: { reference: 'ref1' } }
    const r = await mod.sweepDisputes({ PAYSTACK_SECRET_KEY: 'k' }, { waitUntil() {} }, world.db, { list: async () => ({ data: [d] }) })
    return { r, status: world.t.payments[0].status }
  }
  it('older dispute ACCEPTED in full while dispute 200 is tracked: sale reversed, like the live webhook', async () => {
    const { r, status } = await sweep('merchant-accepted')
    expect(status).toBe('REFUNDED')
    expect(r.actioned.length).toBe(1)
  })
  it('older dispute DECLINED while dispute 200 is tracked: still left alone (round 26 behaviour kept)', async () => {
    const { r, status } = await sweep('declined')
    expect(status).toBe('DISPUTED')
    expect(r.actioned).toEqual([])
  })
  it('the tracked dispute accepted is unchanged: reversed', async () => {
    const { status } = await sweep('merchant-accepted', '100')
    expect(status).toBe('REFUNDED')
  })
})

describe('G2: proof of delivery and evidence carry the real delivery time', () => {
  const world0 = (scan = {}, payment = {}) => createWorld({
    users: [{ id: 'u1', email: 'buyer@x.co', name: 'Bea' }], payments: [pay(payment)],
    scans: [{ id: 's1', status: 'FIX_DELIVERED', fix_payment_id: 'p1', fix_tier: 'FIX', verification_code: 'ABCD1234', verification_status: 'ACTIVE', ...scan }],
  })
  it('contest PDF states the delivered-at time and the receipt email time', async () => {
    const log = []
    const world = world0({ fix_delivered_at: '2026-09-29T08:15:00.000Z' }, { receipt_delivered_at: '2026-09-28T10:01:00.000Z' })
    const { mod } = load(world, {
      getDisputeUploadUrl: async (e, id, n) => ({ signedUrl: 'https://s3.example/put', fileName: n }),
      uploadDisputeProof: async (u, bytes) => { log.push(new TextDecoder().decode(bytes)) },
      declineDispute: async () => ({ status: true }),
    })
    const out = await mod.contestPaymentDispute(ctx({ env: { FRONTEND_URL: 'https://usepassthrough.com' }, params: { reference: 'ref1' } }))
    expect(out.status).toBe(200)
    expect(log[0]).toMatch(/Delivery: completed on 2026-09-29T08:15:00\.000Z/)
    expect(log[0]).toMatch(/receipt emailed[^)]*2026-09-28T10:01:00\.000Z/)
  })
  it('without a recorded delivery time the PDF says only "completed" (no invented date)', async () => {
    const log = []
    const { mod } = load(world0(), {
      getDisputeUploadUrl: async (e, id, n) => ({ signedUrl: 'https://s3.example/put', fileName: n }),
      uploadDisputeProof: async (u, bytes) => { log.push(new TextDecoder().decode(bytes)) },
      declineDispute: async () => ({ status: true }),
    })
    await mod.contestPaymentDispute(ctx({ env: {}, params: { reference: 'ref1' } }))
    expect(log[0]).toMatch(/Delivery: completed\./)
    expect(log[0]).not.toMatch(/receipt emailed/)
  })
  it('evidence delivery_date is the delivery day, falling back to the paid day; address is passed through', async () => {
    const sent = []
    const mk = scan => load(world0(scan), { addDisputeEvidence: async (e, id, f) => { sent.push(f); return { data: { id: 5 } } } }).mod
    let mod = mk({ fix_delivered_at: '2026-09-30T23:30:00.000Z' })
    await mod.submitDisputeEvidence(ctx({ params: { reference: 'ref1' }, body: { customerPhone: '+1 415 555 0100', deliveryAddress: ' Austin, TX ' } }))
    expect(sent[0].delivery_date).toBe('2026-09-30')
    expect(sent[0].delivery_address).toBe('Austin, TX')
    expect(sent[0].service_details).toMatch(/, delivered on 2026-09-30/)
    restore(); restore = null
    mod = mk({})
    await mod.submitDisputeEvidence(ctx({ params: { reference: 'ref1' }, body: { customerPhone: '+1 415 555 0100' } }))
    expect(sent[1].delivery_date).toBe('2026-09-28')
    expect(sent[1].service_details).not.toMatch(/, delivered on \d/)
  })
})
