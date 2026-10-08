import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Payments & Pricing round 7 (G3): a SUCCESSFUL queue holds the refund claim for REFUND_POST_QUEUE_HOLD_MS,
// so a re-run (auto-refund fires on every verify / recheck / webhook redelivery) cannot ask Paystack for a
// second refund while its refund list lags behind the one just created.
let t
afterEach(() => { t?.restore?.(); t = null })

function setup({ createRefund } = {}) {
  const writes = []
  const db = createFakeSupabase(q => {
    if (q.table === 'payments' && q.op === 'update') { writes.push(q.patch); return { data: [{ id: 'p1' }], error: null } }
    return undefined
  })
  const calls = { create: 0 }
  const { mod, restore } = loadWithStubs('services/refund.service.js', {
    'services/paystack.service.js': {
      listRefunds: async () => ({ data: [] }),
      createRefund: createRefund || (async () => { calls.create++; return { status: true } }),
    },
  })
  return { mod, restore, db, writes, calls }
}
const payment = { id: 'p1', paystack_ref: 'ref1', amount_cents: 2900, currency: 'USD' }

describe('queueRefund — post-queue claim hold', () => {
  it('after a successful queue, pushes refund_claimed_at out to ~15 minutes so a re-run is CLAIM_LOST', async () => {
    t = setup()
    const r = await t.mod.queueRefund({}, t.db, payment)
    expect(r.ok).toBe(true)
    const claimWrites = t.writes.filter(p => 'refund_claimed_at' in p)
    expect(claimWrites).toHaveLength(2)                                // the claim, then the hold
    const held = Date.parse(claimWrites[1].refund_claimed_at)
    const { REFUND_POST_QUEUE_HOLD_MS, REFUND_CLAIM_TTL_MS } = t.mod
    // claimRefund frees a row when refund_claimed_at < now - TTL, i.e. at held + TTL — which must be ~HOLD from now.
    const freeAt = held + REFUND_CLAIM_TTL_MS
    expect(freeAt - Date.now()).toBeGreaterThan(REFUND_POST_QUEUE_HOLD_MS - 5000)
    expect(freeAt - Date.now()).toBeLessThanOrEqual(REFUND_POST_QUEUE_HOLD_MS)
  })

  it('a failed queue hands the claim straight back (null) and sets no hold', async () => {
    t = setup({ createRefund: async () => { throw new Error('boom') } })
    const r = await t.mod.queueRefund({}, t.db, payment)
    expect(r.ok).toBe(false)
    const claimWrites = t.writes.filter(p => 'refund_claimed_at' in p)
    expect(claimWrites[claimWrites.length - 1].refund_claimed_at).toBeNull()
    expect(claimWrites.some(p => p.refund_claimed_at && Date.parse(p.refund_claimed_at) > Date.now())).toBe(false)
  })
})
