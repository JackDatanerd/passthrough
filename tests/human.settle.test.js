import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Experts Phase 1: the two guarded hooks in fulfillment.service.js. A human payment settles through humanSettle ONLY: no scan claim,
// no fix queue, no commission, no fix receipt, no auto-refund; a repeat moves nothing; a refund closes the job once.

const NOW = Date.now()
function seed(payOver = {}) {
  const world = createWorld({
    payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: null, user_id: 'u1', status: 'PENDING', amount_cents: 11900, currency: 'USD', fix_tier: null,
                 product_kind: 'human_forty_eight_hour', referral_code_id: null, receipt_sent_at: null, created_at: new Date(NOW).toISOString(), ...payOver }],
    scans: [{ id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false, fix_payment_id: null, updated_at: new Date(NOW).toISOString() }],
    users: [{ id: 'u1', email: 'a@b.c', name: 'A', deleted_at: null }],
    human_jobs: [{ id: 'j1', payment_id: 'p1', tier: 'forty_eight_hour', customer_user_id: 'u1', job_number: 'HJ-AAAAAA', state: 'awaiting_payment', expert_id: null }],
    system_state: [{ key: 'human_pilot', value: { prices: { polish: 1, seven_day: 1, forty_eight_hour: 1, twenty_four_hour: 1, cover_letter: 1 }, pay: { polish: 1, seven_day: 1, forty_eight_hour: 1, twenty_four_hour: 1, cover_letter: 1 },
      tiers_enabled: { polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true }, turnaround_hours: { forty_eight_hour: 48 }, internal_buffer_hours: { forty_eight_hour: 4 },
      pilot_cap_orders: 15, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3 } }],
    commission_ledger: [],
  })
  const calls = []
  world.rpcs.human_job_confirm_payment = args => { calls.push(['confirm', args]); const j = world.t.human_jobs[0]; if (j.state !== 'awaiting_payment') return { data: { ok: true, already: true, state: j.state }, error: null }; j.state = 'offered'; return { data: { ok: true, already: false, job_id: j.id, state: 'offered' }, error: null } }
  world.rpcs.human_job_reverse = args => { calls.push(['reverse', args]); const j = world.t.human_jobs[0]; if (['refunded', 'cancelled'].includes(j.state)) return { data: { ok: true, already: true }, error: null }; j.state = 'refunded'; return { data: { ok: true, already: false, state: 'refunded' }, error: null } }
  return { world, calls }
}

let t
afterEach(() => t?.restore())
function setup(world) {
  const sent = { received: [], receipts: [], reversed: [], notices: [] }
  const queue = []
  const { mod, restore } = loadWithStubs('services/fulfillment.service.js', {
    'services/email.service.js': {
      sendPaymentReceipt: async (...a) => { sent.receipts.push(a); return true },
      sendPaymentReversed: async (...a) => { sent.reversed.push(a); return true },
      sendHumanOrderReceived: async (env, db, to, name, o) => { sent.received.push([to, o.jobNumber]); return true },
      sendOwnerNotice: async (env, s) => { sent.notices.push(s); return true },
      sendOwnerAlert: async () => {},
    },
  })
  const env = { FIX_QUEUE: { send: async m => { queue.push(m) } } }
  return { mod, restore, sent, queue, env, settle: () => mod.settlePayment(env, world.db, { ...world.t.payments[0] }, { source: 'webhook' }) }
}

describe('human payment settlement (settlePayment hook)', () => {
  it('confirms the job once: outcome FULFILLED, then ALREADY_FULFILLED on every repeat; one email, one owner notice', async () => {
    const { world, calls } = seed(); t = setup(world)
    const r1 = await t.settle()
    expect(r1).toMatchObject({ outcome: 'FULFILLED', won: true, human: true, conversion: null })
    expect(world.t.payments[0].status).toBe('SUCCESS')
    expect(world.t.human_jobs[0].state).toBe('offered')
    for (let i = 0; i < 3; i++) expect(await t.settle()).toMatchObject({ outcome: 'ALREADY_FULFILLED', human: true })
    expect(calls.filter(c => c[0] === 'confirm')).toHaveLength(4)          // every path calls it ...
    expect(t.sent.received).toEqual([['a@b.c', 'HJ-AAAAAA']])               // ... but only the first confirmation mails
    expect(t.sent.notices).toHaveLength(1)
  })

  it('passes the deadline from the settings (48 hours, buffer 4) to the database function', async () => {
    const { world, calls } = seed(); t = setup(world)
    await t.settle()
    const a = calls.find(c => c[0] === 'confirm')[1]
    const hours = (new Date(a.p_promised) - Date.now()) / 3600e3
    expect(hours).toBeGreaterThan(47.9); expect(hours).toBeLessThan(48.1)
    expect((new Date(a.p_promised) - new Date(a.p_internal)) / 3600e3).toBeCloseTo(4, 1)
  })

  it('touches nothing of the AI-fix path: the scan is not claimed, nothing is queued, no commission, no fix receipt, no refund', async () => {
    const { world } = seed({ referral_code_id: 'rc-should-be-ignored' }); t = setup(world)
    await t.settle(); await t.settle()
    expect(world.t.scans[0]).toMatchObject({ fix_purchased: false, fix_payment_id: null, status: 'COMPLETE_PASS' })
    expect(t.queue).toEqual([])
    expect(world.t.commission_ledger).toHaveLength(0)
    expect(t.sent.receipts).toEqual([])
    expect(world.t.payments[0].refund_claimed_at ?? null).toBeNull()
  })

  it('a payment with no job is reported (HUMAN_NO_JOB) and never queues a fix or throws', async () => {
    const { world } = seed(); world.t.human_jobs.length = 0; t = setup(world)
    const spy = console.error; console.error = () => {}
    try { expect(await t.settle()).toMatchObject({ outcome: 'HUMAN_NO_JOB' }) } finally { console.error = spy }
    expect(t.queue).toEqual([])
  })

  it('an AI-fix payment (product_kind null) still takes the old path exactly as before', async () => {
    const { world } = seed({ product_kind: null, scan_id: 's1', fix_tier: 'FIX' }); t = setup(world)
    const r = await t.settle()
    expect(r.outcome).toBe('FULFILLED')
    expect(r.human).toBeUndefined()
    expect(world.t.scans[0].fix_purchased).toBe(true)
    expect(t.queue).toHaveLength(1)
    expect(t.sent.received).toEqual([])
  })

  it('a REFUNDED payment is never re-settled by a late event', async () => {
    const { world, calls } = seed({ status: 'REFUNDED' }); t = setup(world)
    expect(await t.settle()).toMatchObject({ outcome: 'IGNORED_STATUS', status: 'REFUNDED' })
    expect(calls).toEqual([])
  })
})

describe('human payment reversal (reversePayment hook)', () => {
  it('a refund closes the job once and a repeat changes nothing; the buyer is told by the existing payment_reversed email', async () => {
    const { world, calls } = seed({ status: 'SUCCESS' }); world.t.human_jobs[0].state = 'offered'; t = setup(world)
    const pay = { ...world.t.payments[0] }
    const r1 = await t.mod.reversePayment(world.db, pay, { reason: 'REFUND', env: t.env })
    expect(r1.transitioned).toBe(true)
    expect(world.t.human_jobs[0].state).toBe('refunded')
    const r2 = await t.mod.reversePayment(world.db, pay, { reason: 'REFUND', env: t.env })
    expect(r2.transitioned).toBe(false)
    expect(calls.filter(c => c[0] === 'reverse')).toHaveLength(2)   // idempotent in the database: the second returns already
    expect(t.sent.reversed.length).toBeGreaterThanOrEqual(1)
  })

  it('finds the job even when the caller loaded the payment row without product_kind (pilot on)', async () => {
    const { world } = seed({ status: 'SUCCESS' }); world.t.human_jobs[0].state = 'in_progress'; world.t.human_jobs[0].expert_id = 'e1'; t = setup(world)
    const { product_kind: _omit, ...partial } = world.t.payments[0]
    await t.mod.reversePayment(world.db, partial, { reason: 'DISPUTE', env: { ...t.env, EXPERTS_ENABLED: 'true' } })
    expect(world.t.human_jobs[0].state).toBe('refunded')
  })

  it('pilot OFF: a payment row loaded without product_kind causes no human_jobs query at all (the old behaviour exactly)', async () => {
    const { world } = seed({ status: 'SUCCESS' }); t = setup(world)
    const reads = []; const from = world.db.from.bind(world.db); world.db.from = name => { reads.push(name); return from(name) }
    const { product_kind: _omit, ...partial } = world.t.payments[0]
    await t.mod.reversePayment(world.db, partial, { reason: 'REFUND', env: t.env })
    expect(reads).not.toContain('human_jobs')
  })

  it('an AI-fix payment reversal never looks at human jobs when product_kind is null', async () => {
    const { world, calls } = seed({ product_kind: null, status: 'SUCCESS', scan_id: 's1', fix_tier: 'FIX' }); t = setup(world)
    await t.mod.reversePayment(world.db, { ...world.t.payments[0] }, { reason: 'REFUND', env: t.env })
    expect(calls).toEqual([])
  })
})
