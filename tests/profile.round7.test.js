import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Profile & Dashboard (Section 6), audit round 7: a profile edit is version-checked (a draft made
// from an older profile cannot overwrite a newer one), the export carries the scan analysis and
// partial refunds, and PUT /profile has its own per-account limiter.

function setup(resolver) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/verification.js': { recordTombstones: async () => {} },
  })
  const c = (over = {}) => ({
    env: {},
    get: () => ({ id: over.userId ?? 'u1' }),
    req: { json: async () => over.body ?? {}, query: k => over.query?.[k] },
    json: (body, status = 200) => ({ body, status }),
    body: (raw, status = 200, headers = {}) => ({ raw, status, headers }),
  })
  return { mod, restore, c, db }
}
let t
afterEach(() => t?.restore())

const good = { skills: ['SQL'] }
const rpcCall = () => t.db.calls.find(c => c.op === 'rpc')

describe('getProfileData — version', () => {
  it('reports the version the editor must send back: savedAt|editedAt', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: { resumeData: { name: 'J' }, savedAt: 'S1', editedAt: 'E1' } }, error: null } : undefined)
    expect((await t.mod.getProfileData(t.c())).body.data.version).toBe('S1|E1')
  })
  it('an unedited profile has an empty edit half', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: { resumeData: { name: 'J' }, savedAt: 'S1' } }, error: null } : undefined)
    expect((await t.mod.getProfileData(t.c())).body.data.version).toBe('S1|')
  })
})

describe('updateProfile — version check', () => {
  it('passes the version to the RPC so the write is decided atomically in SQL', async () => {
    t = setup(q => q.op === 'rpc' ? { data: true, error: null } : undefined)
    const res = await t.mod.updateProfile(t.c({ body: { resumeData: good, version: 'S1|E1' } }))
    expect(res.body.success).toBe(true)
    expect(rpcCall().args.p_expected_version).toBe('S1|E1')
  })
  it('no version = unconditional (older clients keep working)', async () => {
    t = setup(q => q.op === 'rpc' ? { data: true, error: null } : undefined)
    await t.mod.updateProfile(t.c({ body: { resumeData: good } }))
    expect(rpcCall().args.p_expected_version).toBeNull()
  })
  it('409 PROFILE_CHANGED when the profile moved on since the editor opened', async () => {
    t = setup(q => q.op === 'rpc' ? { data: false, error: null }
      : q.table === 'users' ? { data: { saved_profile: { resumeData: { name: 'New' }, savedAt: 'S2' } }, error: null } : undefined)
    const res = await t.mod.updateProfile(t.c({ body: { resumeData: good, version: 'S1|' } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROFILE_CHANGED')
  })
  it('404 (not 409) when there is no saved profile at all, with or without a version', async () => {
    for (const body of [{ resumeData: good, version: 'S1|' }, { resumeData: good }]) {
      t = setup(q => q.op === 'rpc' ? { data: false, error: null }
        : q.table === 'users' ? { data: { saved_profile: null }, error: null } : undefined)
      expect((await t.mod.updateProfile(t.c({ body }))).status).toBe(404)
      t.restore()
    }
    t = null
  })
  it('an unconditional write that matched nothing is a 404, never a conflict', async () => {
    t = setup(q => q.op === 'rpc' ? { data: false, error: null }
      : q.table === 'users' ? { data: { saved_profile: { resumeData: { name: 'x' }, savedAt: 'S' } }, error: null } : undefined)
    expect((await t.mod.updateProfile(t.c({ body: { resumeData: good } }))).status).toBe(404)
  })
  it('400s a version that is not a short string, before touching the database', async () => {
    for (const version of [5, null, {}, 'x'.repeat(101)]) {
      t = setup()
      expect((await t.mod.updateProfile(t.c({ body: { resumeData: good, version } }))).status, String(version)).toBe(400)
      expect(t.db.calls).toHaveLength(0)
      t.restore()
    }
    t = null
  })
})

describe('exportMyData — completeness', () => {
  const rows = {
    users: { data: { name: 'Jane', email: 'jane@x.com', created_at: 'c1', saved_profile: null }, error: null },
    scans: { data: [{ id: 's1', status: 'COMPLETE_PASS', full_ats_report: { missing: ['sql'] }, quantification_prompts: ['how many?'] }], error: null },
    payments: { data: [{ id: 'p1', amount_cents: 1900 }, { id: 'p2', amount_cents: 500 }], error: null },
    payment_refunds: { data: [{ payment_id: 'p1', amount_cents: 400, created_at: 'r1' }], error: null },
    user_sessions: { data: [], error: null },
    email_logs: { data: [], error: null },
  }
  it('includes the scan analysis report and the follow-up questions', async () => {
    t = setup(q => rows[q.table])
    const res = await t.mod.exportMyData(t.c())
    const cols = t.db.calls.find(c => c.table === 'scans').cols
    expect(cols).toContain('full_ats_report'); expect(cols).toContain('quantification_prompts')
    expect(JSON.parse(res.raw).scans[0]).toMatchObject({ fullAtsReport: { missing: ['sql'] }, quantificationPrompts: ['how many?'] })
  })
  it('attaches partial refunds to their payment (empty list when none), reading only this account\'s payments\' refunds', async () => {
    t = setup(q => rows[q.table])
    const out = JSON.parse((await t.mod.exportMyData(t.c())).raw)
    expect(out.payments.find(p => p.id === 'p1').refunds).toEqual([{ amountCents: 400, createdAt: 'r1' }])
    expect(out.payments.find(p => p.id === 'p2').refunds).toEqual([])
    const q = t.db.calls.find(c => c.table === 'payment_refunds')
    expect(q.filters).toContainEqual(['in', 'payment_id', ['p1', 'p2']])
    expect(q.cols).not.toBe('*')
  })
  it('looks refunds up in chunks (the ids ride in the URL) and skips the lookup with no payments', async () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ id: `p${i}`, amount_cents: 1 }))
    t = setup(q => q.table === 'payments' ? { data: many, error: null } : q.table === 'payment_refunds' ? { data: [], error: null } : rows[q.table])
    await t.mod.exportMyData(t.c())
    expect(t.db.calls.filter(c => c.table === 'payment_refunds')).toHaveLength(3)
    t.restore()
    t = setup(q => q.table === 'payments' ? { data: [], error: null } : rows[q.table])
    await t.mod.exportMyData(t.c())
    expect(t.db.calls.some(c => c.table === 'payment_refunds')).toBe(false)
  })
  it('a failing refunds read fails the export loudly instead of silently omitting them', async () => {
    t = setup(q => q.table === 'payment_refunds' ? { data: null, error: new Error('db down') } : rows[q.table])
    await expect(t.mod.exportMyData(t.c())).rejects.toThrow('db down')
  })
  it('a later part does not repeat payments or refunds', async () => {
    t = setup(q => q.table === 'scans' ? { data: [], count: 600, error: null } : rows[q.table])
    await t.mod.exportMyData(t.c({ query: { part: '2' } }))
    expect(t.db.calls.some(c => c.table === 'payment_refunds')).toBe(false)
  })
})

describe('PUT /api/profile is rate limited per account', () => {
  it('the route runs profileEdit between auth and the handler, and the limiter is keyed by account', async () => {
    const fs = await import('node:fs')
    const route = fs.readFileSync(new URL('../src/routes/profile.routes.js', import.meta.url), 'utf8')
    expect(route).toMatch(/router\.put\(\s*'\/',\s*auth,\s*rl\.profileEdit,\s*c\.updateProfile\)/)
    const lim = fs.readFileSync(new URL('../src/middleware/rateLimiter.js', import.meta.url), 'utf8')
    expect(lim).toMatch(/const profileEdit = makeLimiter\(\{[^}]*keyBy: byAccount/s)
  })
})
