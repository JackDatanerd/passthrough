import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Webhooks round 11 (G1): hourly retry of automatic refunds that failed or never completed.

const NOW = Date.parse('2026-09-20T12:00:00Z')
const minsAgo = m => new Date(NOW - m * 60_000).toISOString()

function setup(tables, { duplicate = async () => ({ status: 'QUEUED' }), undeliverable = async () => ({ status: 'QUEUED' }), enabled = true } = {}) {
  const world = createWorld({ payments: [], scans: [], users: [], ...tables })
  const calls = { dup: [], und: [], alerts: [], quota: new Map(), refunded: [] }
  const { mod, restore } = loadWithStubs('services/reconcile.service.js', {
    'services/refund.service.js': {
      autoRefundEnabled: () => enabled, autoRefundUndeliverableEnabled: () => enabled,
      autoRefundDuplicate: async (...a) => { calls.dup.push(a[2].id); return duplicate(...a) },
      autoRefundUndeliverable: async (...a) => { calls.und.push([a[2].id, a[3].outcome]); return undeliverable(...a) },
    },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message, opts) => { calls.alerts.push({ subject, message, opts }); return true } },
    'middleware/rateLimiter.js': {
      hitQuota: async (env, key, max) => { const n = (calls.quota.get(key) || 0) + 1; calls.quota.set(key, n); return n <= max },
      refundQuota: async (env, key) => { calls.quota.set(key, (calls.quota.get(key) || 1) - 1); calls.refunded.push(key) },
    },
  })
  return { world, mod, restore, calls, env: { RATE_LIMIT_KV: { get: async () => null, put: async () => {} } } }
}
const pay = (id, over = {}) => ({ id, paystack_ref: 'ref-' + id, scan_id: 'scan-' + id, user_id: 'u1', status: 'SUCCESS', amount_cents: 2900, currency: 'USD', created_at: minsAgo(60), ...over })

let t
afterEach(() => t?.restore())

describe('sweepFailedAutoRefunds', () => {
  it('refunds a duplicate payment (another payment owns the scan) and an undeliverable one (no scan / deleted owner)', async () => {
    t = setup({
      payments: [pay('dup'), pay('none', { scan_id: null }), pay('gone'), pay('fine')],
      scans: [
        { id: 'scan-dup', user_id: 'u1', fix_payment_id: 'other', fix_purchased: true },
        { id: 'scan-gone', user_id: 'u2', fix_payment_id: null, fix_purchased: false },
        { id: 'scan-fine', user_id: 'u1', fix_payment_id: 'pfine', fix_purchased: true },
      ],
      users: [{ id: 'u2', deleted_at: '2026-09-01T00:00:00Z' }, { id: 'u1', deleted_at: null }],
    })
    // pay('fine') has id 'fine' but scan.fix_payment_id 'pfine' → treated as a duplicate; make it the owner instead
    t.world.t.scans.find(s => s.id === 'scan-fine').fix_payment_id = 'fine'
    const r = await t.mod.sweepFailedAutoRefunds(t.env, t.world.db, { now: NOW })
    expect(r.candidates).toBe(3)
    expect(t.calls.dup).toEqual(['dup'])
    expect(t.calls.und.map(x => x[0]).sort()).toEqual(['gone', 'none'])
    expect(r.queued).toHaveLength(3)
    expect(t.calls.alerts.some(a => /re-queued/.test(a.subject))).toBe(true)
  })
  it('leaves a payment younger than 20 minutes (the live path may still be working) and a non-SUCCESS one', async () => {
    t = setup({ payments: [pay('young', { scan_id: null, created_at: minsAgo(5) }), pay('refunded', { scan_id: null, status: 'REFUNDED' })] })
    const r = await t.mod.sweepFailedAutoRefunds(t.env, t.world.db, { now: NOW })
    expect(r.candidates).toBe(0)
    expect(t.calls.und).toEqual([])
  })
  it('does nothing when both auto-refund switches are off', async () => {
    t = setup({ payments: [pay('x', { scan_id: null })] }, { enabled: false })
    const r = await t.mod.sweepFailedAutoRefunds(t.env, t.world.db, { now: NOW })
    expect(r.candidates).toBe(0)
    expect(t.calls.und).toEqual([])
  })
  it('an IN_PROGRESS refund is not an attempt: the retry slot is handed back', async () => {
    t = setup({ payments: [pay('x', { scan_id: null })] }, { undeliverable: async () => ({ status: 'IN_PROGRESS' }) })
    const r = await t.mod.sweepFailedAutoRefunds(t.env, t.world.db, { now: NOW })
    expect(r.inProgress).toBe(1)
    expect(t.calls.refunded).toEqual(['autorefund-retry:x'])
    expect(t.calls.quota.get('autorefund-retry:x')).toBe(0)
  })
  it('gives up after 5 failed attempts and pages the owner to refund by hand', async () => {
    t = setup({ payments: [pay('x', { scan_id: null })] }, { undeliverable: async () => ({ status: 'FAILED', reason: 'PAYSTACK_ERROR' }) })
    for (let i = 0; i < 5; i++) await t.mod.sweepFailedAutoRefunds(t.env, t.world.db, { now: NOW })
    expect(t.calls.und).toHaveLength(5)
    const r = await t.mod.sweepFailedAutoRefunds(t.env, t.world.db, { now: NOW })
    expect(t.calls.und).toHaveLength(5)          // no sixth attempt
    expect(r.gaveUp).toHaveLength(1)
    expect(t.calls.alerts.some(a => /gave up/.test(a.subject))).toBe(true)
  })
  it('a thrown refund call is recorded as failed and does not stop the rest', async () => {
    let n = 0
    t = setup({ payments: [pay('a', { scan_id: null }), pay('b', { scan_id: null })] }, { undeliverable: async () => { if (n++ === 0) throw new Error('net'); return { status: 'QUEUED' } } })
    const r = await t.mod.sweepFailedAutoRefunds(t.env, t.world.db, { now: NOW })
    expect(r.failed).toHaveLength(1)
    expect(r.queued).toHaveLength(1)
  })
})
