import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Experts audit A6 (B1): a payment that arrives for a human job that is already closed is refunded, never silently kept.
const NOW = Date.now()
function seed(jobState) {
  const world = createWorld({
    payments: [{ id: 'p1', paystack_ref: 'ref1', scan_id: null, user_id: 'u1', status: 'ABANDONED', amount_cents: 11900, currency: 'USD', product_kind: 'human_forty_eight_hour', created_at: new Date(NOW).toISOString() }],
    users: [{ id: 'u1', email: 'a@b.c', name: 'A', deleted_at: null }],
    human_jobs: [{ id: 'j1', payment_id: 'p1', tier: 'forty_eight_hour', customer_user_id: 'u1', job_number: 'HJ-AAAAAA', state: jobState, expert_id: null }],
    system_state: [{ key: 'human_pilot', value: { prices: { polish: 1, seven_day: 1, forty_eight_hour: 1, twenty_four_hour: 1, cover_letter: 1 }, pay: { polish: 1, seven_day: 1, forty_eight_hour: 1, twenty_four_hour: 1, cover_letter: 1 },
      tiers_enabled: { polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true }, turnaround_hours: { forty_eight_hour: 48 }, internal_buffer_hours: { forty_eight_hour: 4 },
      pilot_cap_orders: 15, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3 } }],
  })
  world.rpcs.human_job_confirm_payment = () => ({ data: { ok: true, already: true, job_id: 'j1', state: jobState }, error: null })
  return world
}
let t
afterEach(() => t?.restore())
function setup(world, queueRefund) {
  const alerts = []
  const { mod, restore } = loadWithStubs('services/fulfillment.service.js', {
    'services/email.service.js': { sendOwnerAlert: async (env, subject, msg, o) => { alerts.push([subject, o && o.dedupeKey]) }, sendOwnerNotice: async () => true, sendHumanOrderReceived: async () => true },
    'services/refund.service.js': { queueRefund },
  })
  return { mod, restore, alerts, settle: () => mod.settlePayment({}, world.db, { ...world.t.payments[0], status: 'PENDING' }, { source: 'webhook' }) }
}

describe('late payment on a closed human job (B1/G1)', () => {
  for (const state of ['cancelled', 'refunded']) {
    it(`${state}: the whole payment is refunded and the owner is told once`, async () => {
      const calls = []; const world = seed(state)
      t = setup(world, async (env, db, pay, opts) => { calls.push([pay.id, opts]); return { ok: true, amountCents: pay.amount_cents } })
      expect(await t.settle()).toMatchObject({ outcome: 'LATE_PAYMENT_REFUNDED', human: true })
      expect(calls).toHaveLength(1); expect(calls[0][1].amountCents).toBeUndefined()
      expect(t.alerts.map(a => a[1])).toEqual(['human-late-pay-p1'])
    })
  }
  it('a refund already in flight is neither an error nor an alert', async () => {
    t = setup(seed('cancelled'), async () => ({ ok: false, code: 'OPEN_REFUND', status: 409, message: 'x' }))
    expect(await t.settle()).toMatchObject({ outcome: 'LATE_PAYMENT_REFUND_IN_FLIGHT' }); expect(t.alerts).toEqual([])
  })
  it('a failed refund is reported to the owner with the payment to fix by hand', async () => {
    t = setup(seed('cancelled'), async () => ({ ok: false, code: 'PAYSTACK_ERROR', status: 502, message: 'boom' }))
    expect(await t.settle()).toMatchObject({ outcome: 'LATE_PAYMENT_REFUND_FAILED' }); expect(t.alerts[0][1]).toBe('human-late-pay-fail-p1')
  })
  it('a thrown refund is caught the same way and never breaks settlement', async () => {
    const spy = console.error; console.error = () => {}
    try { t = setup(seed('cancelled'), async () => { throw new Error('db down') }); expect(await t.settle()).toMatchObject({ outcome: 'LATE_PAYMENT_REFUND_FAILED' }) } finally { console.error = spy }
  })
  it('a live job (offered) is still ALREADY_FULFILLED and never refunded', async () => {
    let called = false; t = setup(seed('offered'), async () => { called = true; return { ok: true } })
    expect(await t.settle()).toMatchObject({ outcome: 'ALREADY_FULFILLED' }); expect(called).toBe(false)
  })
})
