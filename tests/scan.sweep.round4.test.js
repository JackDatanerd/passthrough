// Scan/ATS round 4 — the hourly stuck-scan sweep (src/index.js), driven through the real scheduled handler.
import { describe, it, expect } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'

// index.js reaches getSupabase through a CommonJS require(), which vi.mock cannot intercept — so the module is stubbed in
// the require cache BEFORE index.js is first loaded (the pattern tests/helpers/loadWithStubs.cjs uses for the controllers).
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const state = { db: null }
const sbPath = require.resolve('../src/config/supabase.js')
const realSupabase = require('../src/config/supabase.js')
require.cache[sbPath].exports = { ...realSupabase, getSupabase: () => state.db }

const todayStartUtc = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d }
const hoursAgo = h => new Date(Date.now() - h * 3600_000).toISOString()

async function runSweep(resolver) {
  // The health sweep reads the recorded schema version; give it one so it stays quiet.
  state.db = createFakeSupabase(q => (q.table === 'system_state' ? { data: { value: { version: 72 } }, error: null } : resolver(q)))
  const { default: worker } = await import('../src/index.js')
  const pending = []
  const env = { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 'j'.repeat(40), FRONTEND_URL: 'https://x.test' }
  worker.scheduled({ cron: '0 * * * *' }, env, { waitUntil: p => pending.push(p) })
  await Promise.allSettled(pending)
  return state.db
}
const scanUpdates = db => db.calls.filter(c => c.table === 'scans' && c.op === 'update')
const eq = (q, col) => (q.filters.find(f => f[0] === 'eq' && f[1] === col) || [])[2]

describe('stuck FIX_GENERATING scans', () => {
  it('a redelivery that died (files already delivered, retry count 0) goes back to FIX_DELIVERED — not to ERROR', async () => {
    const db = await runSweep(q => {
      if (q.table === 'scans' && q.op === 'update' && q.patch.status === 'FIX_DELIVERED') return { data: [{ id: 's1' }], error: null }
    })
    const recover = scanUpdates(db).find(q => q.patch.status === 'FIX_DELIVERED')
    expect(recover).toBeTruthy()
    expect(eq(recover, 'status')).toBe('FIX_GENERATING')
    expect(recover.filters).toEqual(expect.arrayContaining([['eq', 'fix_retry_count', 0], ['not', 'resume_ats_path', 'is', null]]))
    expect(recover.filters.some(f => f[0] === 'lt' && f[1] === 'updated_at')).toBe(true)
  })
  it('runs BEFORE the blanket ERROR flip, so a recovered scan is never also errored', async () => {
    const db = await runSweep(() => undefined)
    const order = scanUpdates(db).map(q => q.patch.status)
    expect(order.indexOf('FIX_DELIVERED')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('FIX_DELIVERED')).toBeLessThan(order.indexOf('ERROR'))
  })
})

describe('refunding the slot of a scan that got stuck', () => {
  const stuck = over => ({ id: 's1', user_id: 'u1', fix_purchased: false, created_at: hoursAgo(30), ...over })
  const resolverWith = row => q => {
    if (q.table === 'scans' && q.op === 'update' && q.patch.status === 'ERROR') return { data: [row], error: null }
    if (q.op === 'rpc') return { data: true, error: null }
  }
  const refunds = db => db.calls.filter(c => c.op === 'rpc' && c.name === 'decrement_scan_count')
  it('a scan created before today but RETRIED today is refunded (the slot was spent today)', async () => {
    const db = await runSweep(resolverWith(stuck({ scan_slot_spent_at: new Date().toISOString() })))
    expect(refunds(db)).toHaveLength(1)
  })
  it('a scan whose slot was spent before today is not refunded', async () => {
    const old = new Date(todayStartUtc().getTime() - 3600_000).toISOString()
    expect(refunds(await runSweep(resolverWith(stuck({ scan_slot_spent_at: old })))).length).toBe(0)
    expect(refunds(await runSweep(resolverWith(stuck()))).length).toBe(0)           // no stamp: created_at decides, as before
  })
  it('a scan created today and never retried is still refunded; a paid or anonymous one never is', async () => {
    expect(refunds(await runSweep(resolverWith(stuck({ created_at: hoursAgo(0.2) })))).length).toBe(1)
    expect(refunds(await runSweep(resolverWith(stuck({ created_at: hoursAgo(0.2), fix_purchased: true })))).length).toBe(0)
    expect(refunds(await runSweep(resolverWith(stuck({ created_at: hoursAgo(0.2), user_id: null })))).length).toBe(0)
  })
  it('selects every column, so a database that has not yet had migration 0072 does not break the sweep', async () => {
    const db = await runSweep(resolverWith(stuck()))
    const flip = scanUpdates(db).find(q => q.patch.status === 'ERROR')
    expect(flip.cols).toBe('*')
  })
})
