import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 14 — B5 register response carries the STORED attribution start, B6 the code-limit notice is only marked
// sent after the mail was accepted, B7 the per-code sign-up count has an index to run on.

let t
afterEach(() => t?.restore())
const read = p => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

describe('B6 — limit-reached notice is retried until it is actually sent', () => {
  const run = async (results) => {
    const kv = new Map(), calls = []
    t = loadWithStubs('services/referral.service.js', {
      'services/email.service.js': {
        sendOwnerAlert: async () => {},
        sendPartnerCodeLimitReached: async () => { calls.push(1); return results.shift() },
      },
    })
    const db = createFakeSupabase(q => {
      if (q.table === 'commission_ledger') return { data: null, count: 0, error: null }
      if (q.table === 'referral_codes') return { data: { code: 'K20', usage_limit: 5, uses_so_far: 5 }, error: null }
      return undefined
    })
    const env = { RATE_LIMIT_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v) } } }
    const go = () => t.mod.afterConversionNotices(db, env, { id: 'c1', code: 'K20' }, { name: 'K', email: 'k@x.co' })
    return { go, calls, kv }
  }
  it('a failed send leaves no key, so the next conversion tries again; a successful send is marked once', async () => {
    const r = await run([false, true, true])
    await r.go(); expect(r.calls).toHaveLength(1); expect(r.kv.size).toBe(0)
    await r.go(); expect(r.calls).toHaveLength(2); expect(r.kv.size).toBe(1)
    await r.go(); expect(r.calls).toHaveLength(2)        // already told: no third mail
  })
  it('a send that throws does not mark the notice or break the conversion path', async () => {
    const r = await run([Promise.reject(new Error('resend down'))])
    await expect(r.go()).resolves.toBeUndefined()
    expect(r.kv.size).toBe(0)
  })
})

describe('B5 — setUserAttribution reports the stored start', () => {
  const load = (current) => {
    t = loadWithStubs('services/referral.service.js', {})
    const updates = []
    const db = createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: { id: 'c1', code: 'K20', active: true, tier_prices: { FIX: 1 }, partner_id: 'p1', partners: { status: 'ACTIVE', email: 'p@x.co' } }, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: current, error: null }
      if (q.table === 'users') { updates.push(q); return { data: null, error: null } }
      return undefined
    })
    return { svc: t.mod, db }
  }
  it('returns the capture time it stored, not "now"', async () => {
    const { svc, db } = load(null)
    const at = new Date(Date.now() - 5 * 86400000).toISOString()
    const out = await svc.setUserAttribution(db, { id: 'u1', email: 'b@x.co' }, 'k20', at)
    expect(out.stored).toBe(true)
    expect(out.referredAt).toBe(at)
  })
  it('register uses it for the response', () => {
    expect(read('src/controllers/auth.controller.js')).toMatch(/user\.referredAt = out\.referredAt \|\|/)
  })
})

describe('B7 — migration 0085', () => {
  const sql = read('supabase/migrations/0085_partners_section4_round14.sql')
  it('adds a partial index on users.referred_by_code, records itself, and EXPECTED_SCHEMA_VERSION follows', () => {
    expect(sql).toMatch(/create index if not exists idx_users_referred_by_code\s+on users \(referred_by_code\)\s+where referred_by_code is not null/)
    expect(sql).toMatch(/insert into applied_migrations \(version, name\) values \(85, '0085_partners_section4_round14'\)/)
    expect(read('src/config/constants.js')).toMatch(/EXPECTED_SCHEMA_VERSION:\s*(8[5-9]|9\d)/)
  })
})
