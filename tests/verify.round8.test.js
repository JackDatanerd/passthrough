import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { publicFirstName } from '../src/lib/text.js'
import constants from '../src/config/constants.js'

// Round-8 (fresh clone) audit of Section 7 (Verify).
const CODE = 'AB3XY7K2PQ'

describe('B1: a title or surname-first name is never the public first name', () => {
  const cases = [
    ['Dr. Priya Patel', 'Priya'], ['Eng. John Kamau', 'John'], ['Mr. Otieno Odhiambo', 'Otieno'], ['CPA Jane Doe', 'Jane'],
    ['Hon. Amina Yusuf', 'Amina'], ['Rev. Peter Njoroge', 'Peter'], ['Prof. Dr. Ing. Hans', 'Hans'], ['Er. Rahul Sharma', 'Rahul'],
    ['Doe, Jane', 'Jane'], ['Smith, John A.', 'John'], ['Jane Doe, CPA', 'Jane'],
    ['JOHN SMITH', 'John'], ["O'BRIEN Tom", "O'Brien"], ['ANNE-MARIE LEE', 'Anne-Marie'],
    // left exactly as written
    ['Mary Ann Smith', 'Mary'], ['McDonald Ray', 'McDonald'], ['DeShawn Lee', 'DeShawn'], ['J. Smith', 'J.'], ['李 明', '李'], ['J.R. Smith', 'J.R.'], ['JR Smith', 'JR'], ['Åsa Berg', 'Åsa'],
    // given names that merely LOOK like titles stay names unless written as an abbreviation
    ['Eng Hock Lim', 'Eng'], ['Hon Gil-dong', 'Hon'], ['Er Wei', 'Er'], ['Md Rahman', 'Md'],
  ]
  for (const [input, want] of cases) it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => expect(publicFirstName(input)).toBe(want))
  it('a value that is only a title (a page stored before this fix) shows no name at all', () => {
    for (const stored of ['Dr.', 'Dr', 'Eng.', 'Mr.', 'CPA', 'Doe,', '', '   ', null, undefined, 42, {}]) expect(publicFirstName(stored)).toBeNull()
  })
})

describe('B2: the superseded-fingerprint history is not cut at 20', () => {
  it('the cap is a named constant of at least 200 and scan.controller uses it', () => {
    expect(constants.MAX_HASH_HISTORY).toBeGreaterThanOrEqual(200)
    const src = fs.readFileSync(new URL('../src/controllers/scan.controller.js', import.meta.url), 'utf8')
    expect(src).toContain('history.slice(-c.MAX_HASH_HISTORY)')
    expect(src).not.toContain('history.slice(-20)')
  })
})

function harness(over = {}) {
  const world = createWorld({ scans: [{ id: 'scan1', verification_code: CODE, verification_status: 'ACTIVE', verification_revoked_at: null, ...over }], verification_reports: [] })
  world.unique.verification_reports = [['code', 'reporter_hash']]
  const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db } })
  const ctx = ({ code = CODE, body, ip = '203.0.113.9', ua = 'Mozilla/5.0 Chrome', env = {} } = {}) => {
    const out = {}
    return {
      env: { NODE_ENV: 'production', ...env },
      req: { method: 'POST', param: () => code, query: () => undefined, header: n => ({ 'cf-connecting-ip': ip, 'user-agent': ua })[n.toLowerCase()], json: async () => { if (body === undefined) throw new Error('no body'); return body } },
      get: () => null, executionCtx: { waitUntil: () => {} },
      header: (k, v) => { out[k] = v },
      json: (data, status = 200, h = {}) => ({ status, data, headers: { ...out, ...h } }),
    }
  }
  return { mod, world, ctx, restore }
}
let t
afterEach(() => t?.restore())

describe('feature gap: POST /api/verify/:code/report', () => {
  it('stores the report and answers success', async () => {
    t = harness()
    const r = await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE', details: 'Not the person on the call', email: ' Reader@Example.COM ' } }))
    expect(r.status).toBe(200); expect(r.data.success).toBe(true)
    const rows = t.world.t.verification_reports
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code: CODE, reason: 'FAKE', details: 'Not the person on the call', reporter_email: 'reader@example.com' })
    expect(rows[0].reporter_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].reporter_hash).not.toContain('203.0.113')
  })
  it('works for a lowercase code in the URL', async () => {
    t = harness()
    expect((await t.mod.reportVerification(t.ctx({ code: CODE.toLowerCase(), body: { reason: 'OTHER' } }))).status).toBe(200)
    expect(t.world.t.verification_reports[0].code).toBe(CODE)
  })
  it('a second report from the same network is absorbed: same answer, one row', async () => {
    t = harness()
    await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE' } }))
    const again = await t.mod.reportVerification(t.ctx({ body: { reason: 'WRONG' } }))
    expect(again.status).toBe(200)
    expect(t.world.t.verification_reports).toHaveLength(1)
  })
  it('a different network is a separate report', async () => {
    t = harness()
    await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE' }, ip: '198.51.100.1' }))
    await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE' }, ip: '198.51.100.99' }))
    expect(t.world.t.verification_reports).toHaveLength(2)
  })
  it('the honeypot answers like success and stores nothing', async () => {
    t = harness()
    const r = await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE', trap: 'http://spam' } }))
    expect(r.status).toBe(200); expect(r.data.success).toBe(true)
    expect(t.world.t.verification_reports).toHaveLength(0)
  })
  it('rejects a bad reason, a non-object body, no body, a bad e-mail, a note over 1000 characters', async () => {
    t = harness()
    for (const body of [{ reason: 'NOPE' }, {}, null, [], 'x', { reason: 'FAKE', email: 'not-an-email' }, { reason: 'FAKE', details: 'x'.repeat(1001) }, undefined]) {
      const r = await t.mod.reportVerification(t.ctx({ body }))
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    expect(t.world.t.verification_reports).toHaveLength(0)
  })
  it('control characters in the note are stripped and an empty note is null', async () => {
    t = harness()
    await t.mod.reportVerification(t.ctx({ body: { reason: 'OTHER', details: 'a\u0000b\u202ec' } }))
    expect(t.world.t.verification_reports[0].details).toBe('abc')
    t.world.t.verification_reports.length = 0
    await t.mod.reportVerification(t.ctx({ body: { reason: 'OTHER', details: '   ', email: '' }, ip: '198.51.100.7' }))
    expect(t.world.t.verification_reports[0]).toMatchObject({ details: null, reporter_email: null })
  })
  it('an unknown code is a 404 and a revoked page is a 410, neither stores anything', async () => {
    t = harness()
    expect((await t.mod.reportVerification(t.ctx({ code: 'ZZ3XY7K2PQ', body: { reason: 'FAKE' } }))).status).toBe(404)
    expect((await t.mod.reportVerification(t.ctx({ code: 'not a code', body: { reason: 'FAKE' } }))).status).toBe(404)
    t.world.t.scans[0].verification_status = 'REVOKED'
    expect((await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE' } }))).status).toBe(410)
    expect(t.world.t.verification_reports).toHaveLength(0)
  })
  it('with Turnstile configured, a report without a token is refused', async () => {
    t = harness()
    const r = await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE' }, env: { TURNSTILE_SECRET_KEY: 'secret' } }))
    expect(r.status).toBe(400)
    expect(t.world.t.verification_reports).toHaveLength(0)
  })
  it('is routed as POST /:code/report behind its own limiter, separate from the read budget', () => {
    const routes = fs.readFileSync(new URL('../src/routes/verify.routes.js', import.meta.url), 'utf8')
    expect(routes).toMatch(/router\.post\('\/:code\/report',\s+rl\.verifyReport,\s+c\.reportVerification\)/)
    const rl = require('../src/middleware/rateLimiter')
    expect(typeof rl.verifyReport).toBe('function')
    expect(rl.verifyReport).not.toBe(rl.verifyRead)
  })
})

describe('admin: list, review and revoke-settles-reports', () => {
  function adminHarness() {
    const world = createWorld({
      scans: [{ id: 'scan1', verification_code: CODE, verification_status: 'ACTIVE', verification_revoked_reason: null }],
      verification_reports: [
        { id: 'r1', code: CODE, reason: 'FAKE', details: 'x', reporter_email: null, reporter_hash: 'h1', status: 'OPEN', created_at: '2026-10-02T00:00:00Z', reviewed_at: null },
        { id: 'r2', code: 'GONE222222', reason: 'WRONG', details: null, reporter_email: 'a@b.co', reporter_hash: 'h2', status: 'OPEN', created_at: '2026-10-03T00:00:00Z', reviewed_at: null },
        { id: 'r3', code: CODE, reason: 'OTHER', details: null, reporter_email: null, reporter_hash: 'h3', status: 'DISMISSED', created_at: '2026-10-01T00:00:00Z', reviewed_at: '2026-10-02T00:00:00Z' },
      ],
    })
    const { mod, restore } = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => world.db } })
    const ctx = ({ query = {}, param = {}, body } = {}) => ({
      env: {}, req: { query: k => query[k], param: k => param[k], json: async () => body },
      get: k => (k === 'user' ? { id: 'admin-1' } : null),
      json: (data, status = 200) => ({ status, data }),
    })
    return { mod, world, ctx, restore }
  }
  it('lists open reports, each with the page\'s current state (OPEN is oldest first since round 10, closed ones newest first; the in-memory fake does not sort)', async () => {
    t = adminHarness()
    const r = await t.mod.adminListVerificationReports(t.ctx())
    const byId = Object.fromEntries(r.data.data.map(x => [x.id, x]))
    expect(Object.keys(byId).sort()).toEqual(['r1', 'r2'])
    expect(byId.r1).toMatchObject({ scanId: 'scan1', pageStatus: 'ACTIVE', reason: 'FAKE' })
    expect(byId.r2).toMatchObject({ scanId: null, pageStatus: 'GONE', reporterEmail: 'a@b.co' })
    // Ordering is asserted behaviourally in verify.round12.test.js (this double does not sort).
  })
  it('filters by status and treats an unknown status as OPEN', async () => {
    t = adminHarness()
    expect((await t.mod.adminListVerificationReports(t.ctx({ query: { status: 'dismissed' } }))).data.data.map(x => x.id)).toEqual(['r3'])
    expect((await t.mod.adminListVerificationReports(t.ctx({ query: { status: 'bogus' } }))).data.data).toHaveLength(2)
  })
  it('review stamps who and when; unknown id is 404; bad status is 400', async () => {
    t = adminHarness()
    const ok = await t.mod.adminReviewVerificationReport(t.ctx({ param: { id: 'r1' }, body: { status: 'DISMISSED' } }))
    expect(ok.status).toBe(200)
    expect(t.world.t.verification_reports.find(x => x.id === 'r1')).toMatchObject({ status: 'DISMISSED', reviewed_by: 'admin-1' })
    expect((await t.mod.adminReviewVerificationReport(t.ctx({ param: { id: 'nope' }, body: { status: 'ACTIONED' } }))).status).toBe(404)
    expect((await t.mod.adminReviewVerificationReport(t.ctx({ param: { id: 'r1' }, body: { status: 'OPEN' } }))).status).toBe(400)
  })
  it('revoking the page closes its open reports as ACTIONED and leaves other pages\' alone', async () => {
    t = adminHarness()
    const r = await t.mod.adminSetVerification(t.ctx({ param: { id: 'scan1' }, body: { action: 'revoke' } }))
    expect(r.status).toBe(200)
    const rows = t.world.t.verification_reports
    expect(rows.find(x => x.id === 'r1').status).toBe('ACTIONED')
    expect(rows.find(x => x.id === 'r2').status).toBe('OPEN')
    expect(rows.find(x => x.id === 'r3').status).toBe('DISMISSED')
  })
  it('the routes are admin-gated paths', () => {
    const routes = fs.readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8')
    expect(routes).toContain("router.get('/verification-reports', c.adminListVerificationReports)")
    expect(routes).toContain("router.patch('/verification-reports/:id', validateUuidParam(), c.adminReviewVerificationReport)")
  })
})

describe('retention + schema', () => {
  it('purgeOldVerifyReports deletes reports past the retention window, whatever their status', async () => {
    const { purgeOldVerifyReports } = require('../src/services/retention.service')
    const now = Date.parse('2026-10-10T00:00:00Z')
    const old = new Date(now - (constants.VERIFY_REPORT_RETENTION_DAYS + 1) * 86400000).toISOString()
    const fresh = new Date(now - 86400000).toISOString()
    const world = createWorld({ verification_reports: [{ id: 'a', created_at: old, status: 'OPEN' }, { id: 'b', created_at: old, status: 'DISMISSED' }, { id: 'c', created_at: fresh, status: 'OPEN' }] })
    const out = await purgeOldVerifyReports(world.db, now)
    expect(out.error).toBeUndefined()   // (the in-memory fake does not return deleted rows, so the rows themselves are checked)
    expect(world.t.verification_reports.map(x => x.id)).toEqual(['c'])
  })
  it('migration 0073 exists, is idempotent and ends with the schema_version upsert', () => {
    const sql = fs.readFileSync(new URL('../supabase/migrations/0073_verification_reports.sql', import.meta.url), 'utf8')
    expect(sql).toContain('create table if not exists verification_reports')
    expect(sql).toContain('enable row level security')
    expect(sql.trim().split('\n').slice(-3).join('\n')).toContain("'version', 73")
  })
})
