import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { checkSchema, checkReferralUsage, computeHealth } from '../src/lib/health.js'
import constants from '../src/config/constants.js'
import ledger from '../src/config/migrationLedger.js'

// Database layer round 5 (the SQL itself is exercised in migrations.0100.pglite.test.js; this is the Worker side).

let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', PAYSTACK_CURRENCY: 'USD', OWNER_ALERT_EMAIL: 'owner@x.co', ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1', email: 'a@x.co' } : undefined),
  req: { param: k => (over.params || {})[k ?? 'id'] ?? 'p1', query: k => (over.query || {})[k], json: async () => over.body ?? {}, header: () => undefined },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})

describe('B4 — a tier price above the payments column is refused before it reaches the database', () => {
  const run = async tierPrices => {
    const inserts = []
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: { id: 'p1', name: 'K', email: 'k@x.co', status: 'ACTIVE', dashboard_token: 'd' }, error: null }
      if (q.table === 'referral_codes' && q.op === 'insert') { inserts.push(q.values); return { data: { id: 'c1', ...q.values }, error: null } }
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {}, sendReferralCodeCreated: async () => true } })
    let err = null
    try { await t.mod.adminCreateReferralCode(ctxOf({ body: { code: 'BIGPRICE', tierPrices, confirmLowPrice: true } })) } catch (e) { err = e }
    return { err, inserts }
  }
  it('3,000,000,000 (valid for the old CHECK, overflows int4) is rejected', async () => {
    const { err, inserts } = await run({ FIX: 3000000000 })
    expect(err).toBeTruthy()
    expect(String(err.message || err)).toMatch(/allowed maximum/)
    expect(inserts).toHaveLength(0)
  })
  it('a normal price still goes through', async () => {
    const { err, inserts } = await run({ FIX: 3900 })
    expect(err).toBeNull()
    expect(inserts).toHaveLength(1)
  })
})

describe('G1 — the ledger check compares file NAMES, not just version numbers', () => {
  const E = constants.EXPECTED_SCHEMA_VERSION
  const stateDb = (ledgerRows) => ({
    from(table) {
      if (table === 'applied_migrations') return { select: () => ({ gte: async () => ({ data: ledgerRows, error: null }) }) }
      const q = { }
      q.select = () => q; q.eq = () => q
      q.maybeSingle = async () => ({ data: { value: { version: E }, updated_at: 'x' } })
      return q
    },
  })
  const full = (over = {}) => Array.from({ length: E - 81 }, (_, i) => ({ version: 82 + i, name: ledger.LEDGER_NAMES[82 + i], ...(over[82 + i] || {}) }))
  it('a complete, correctly named ledger carries no note', async () => {
    const r = await checkSchema(stateDb(full()))
    expect(r).toMatchObject({ ok: true, renamed: [], renamedNote: null })
  })
  it('version 96 held by a DIFFERENT file than the one this code expects is reported (the skipped-migration case), without failing the check', async () => {
    const r = await checkSchema(stateDb(full({ 96: { name: '0096_partners_section4_round18' } })))
    expect(r.ok).toBe(true)
    expect(r.renamed).toEqual([{ version: 96, expected: ledger.LEDGER_NAMES[96], recorded: '0096_partners_section4_round18' }])
    expect(r.renamedNote).toMatch(/0096 \(recorded "0096_partners_section4_round18", expected "0096_paper_size"\)/)
  })
  it('a missing version is still a failure, as before', async () => {
    const rows = full().filter(x => x.version !== 90)
    const r = await checkSchema(stateDb(rows))
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([90])
  })
  it('rows without a name (an older fake / a partial read) are not called renamed', async () => {
    const r = await checkSchema(stateDb(full().map(x => ({ version: x.version }))))
    expect(r.renamed).toEqual([])
  })
})

describe('G3 — referral usage drift in the health report', () => {
  it('lists codes whose counter disagrees with the ledger', async () => {
    const db = { rpc: async name => name === 'referral_usage_drift' ? { data: [{ code: 'ANN10', uses_so_far: 7, expected: 5 }], error: null } : { data: null, error: null } }
    expect(await checkReferralUsage(db)).toEqual({ ok: false, drift: [{ code: 'ANN10', usesSoFar: 7, expected: 5 }] })
  })
  it('no drift is ok', async () => {
    expect(await checkReferralUsage({ rpc: async () => ({ data: [], error: null }) })).toEqual({ ok: true, drift: [] })
  })
  it('a missing function (0100 not applied) or a client without rpc is unknown, never a failure', async () => {
    expect(await checkReferralUsage({ rpc: async () => ({ data: null, error: { message: 'Could not find the function' } }) })).toMatchObject({ ok: true, unknown: true })
    expect(await checkReferralUsage({})).toMatchObject({ ok: true, unknown: true })
    expect(await checkReferralUsage({ rpc: async () => { throw new Error('boom') } })).toMatchObject({ ok: true, unknown: true })
  })
  it('computeHealth reports drift as a note, not a problem', async () => {
    const E = constants.EXPECTED_SCHEMA_VERSION
    const db = {
      rpc: async () => ({ data: [{ code: 'ANN10', uses_so_far: 7, expected: 5 }], error: null }),
      from(table) {
        if (table === 'applied_migrations') return { select: () => ({ gte: async () => ({ data: Array.from({ length: E - 81 }, (_, i) => ({ version: 82 + i, name: ledger.LEDGER_NAMES[82 + i] })), error: null }) }) }
        const q = { _k: null }
        q.select = () => q; q.eq = (_c, k) => { q._k = k; return q }
        q.maybeSingle = async () => ({ data: q._k === 'schema_version' ? { value: { version: E }, updated_at: 'x' } : q._k === 'cron_heartbeat' ? { value: { at: new Date().toISOString() }, updated_at: 'x' } : null })
        q.upsert = async () => ({ error: null }); q.limit = async () => ({ data: [], error: null })
        return q
      },
    }
    const h = await computeHealth({ SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x' }, db)
    expect(h.problems.join(' ')).not.toMatch(/referral/)
    expect(h.notes.join(' ')).toMatch(/ANN10: counter 7, ledger 5/)
    expect(h.referralUsage.ok).toBe(false)
  })
})

describe('G2 — admin prompt outcomes', () => {
  const load = (handler) => {
    const db = createFakeSupabase(handler)
    t = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return t.mod
  }
  it('returns both generations, busiest first, and flags a small sample', async () => {
    const mod = load(q => {
      if (q.table === 'prompt_outcome_rates') return { data: [{ prompt_version: 'v1', responses: 4, interviews: 3, interview_pct: '75.0' }, { prompt_version: 'v2', responses: 120, interviews: 60, interview_pct: '50.0' }], error: null }
      if (q.table === 'letter_prompt_outcome_rates') return { data: [{ prompt_version: null, responses: 30, interviews: 6, interview_pct: '20.0' }], error: null }
      return undefined
    })
    const res = await mod.adminPromptOutcomes(ctxOf())
    expect(res.status).toBe(200)
    expect(res.body.data.fix.map(r => r.version)).toEqual(['v2', 'v1'])
    expect(res.body.data.fix[1]).toMatchObject({ responses: 4, interviewPct: 75, smallSample: true })
    expect(res.body.data.fix[0].smallSample).toBe(false)
    expect(res.body.data.letter[0]).toMatchObject({ version: null, interviewPct: 20 })
  })
  it('answers 503 with the migration to apply when the view is missing', async () => {
    const mod = load(q => ({ data: null, error: { code: '42P01', message: 'relation "letter_prompt_outcome_rates" does not exist' } }))
    const res = await mod.adminPromptOutcomes(ctxOf())
    expect(res.status).toBe(503)
    expect(res.body.message).toMatch(/0100/)
  })
  it('is mounted on the admin router', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.routes.js'), 'utf8')).toMatch(/router\.get\('\/prompt-outcomes', c\.adminPromptOutcomes\)/)
  })
})
