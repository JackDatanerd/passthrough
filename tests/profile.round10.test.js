import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import constants from '../src/config/constants.js'

// Profile & Dashboard (Section 6), round 10: readable default names, DB-backed unique names with a retry on a
// lost race, "save the fixed version", restore-previous-version, preference error text, migration 0075.

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

function setup(resolver) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/verification.js': { recordTombstones: async () => {} },
    'services/fulfillment.service.js': { abandonPendingForScans: async () => 0 },
  })
  const c = (over = {}) => ({
    env: {},
    get: () => ({ id: 'u1' }),
    req: { json: async () => over.body ?? {}, query: k => over.query?.[k], param: k => over.params?.[k] },
    json: (body, status = 200) => ({ body, status }),
    body: (text, status = 200, headers = {}) => ({ text, status, headers }),
  })
  return { mod, restore, c, db }
}
let t
afterEach(() => t?.restore())

const scanRow = (over = {}) => ({ id: ID1, user_id: 'u1', status: 'COMPLETE_PASS', original_resume_data: { skills: ['SQL'] }, role_category: 'software_engineering', ...over })

describe('default profile names read like words, not taxonomy keys', () => {
  it('saving as another profile without a name uses the role label', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow(), error: null } : q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: ID2, error: null } : undefined)
    const res = await t.mod.saveProfile(t.c({ body: { scanId: ID1, asExtra: true } }))
    expect(res.body.data.label).toBe('Software Engineering')
  })
  it('"Copy as another profile" is "<Role> copy"', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: { resumeData: { skills: ['a'] }, roleCategory: 'product_management' } }, error: null }
      : q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: ID2, error: null } : undefined)
    const res = await t.mod.duplicatePrimary(t.c({ body: {} }))
    expect(res.body.data.label).toBe('Product Management copy')
  })
})

describe('unique names survive a lost race', () => {
  it('a unique violation from the database re-reads the names and takes the next free one', async () => {
    let rpcCalls = 0, listCalls = 0
    t = setup(q => {
      if (q.table === 'scans') return { data: scanRow(), error: null }
      if (q.table === 'saved_profiles') { listCalls++; return { data: listCalls === 1 ? [] : [{ id: 'z', label: 'Design' }], error: null } }
      if (q.op === 'rpc') { rpcCalls++; return rpcCalls === 1 ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_saved_profiles_user_label"' } } : { data: ID2, error: null } }
    })
    const res = await t.mod.saveProfile(t.c({ body: { scanId: ID1, asExtra: true, label: 'Design' } }))
    expect(res.status).toBe(200)
    expect(res.body.data.label).toBe('Design (2)')
    expect(rpcCalls).toBe(2)
  })
  it('any other database error still fails the request', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow(), error: null } : q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: null, error: { code: '57014', message: 'timeout' } } : undefined)
    await expect(t.mod.saveProfile(t.c({ body: { scanId: ID1, asExtra: true, label: 'x' } }))).rejects.toMatchObject({ code: '57014' })
  })
  it('a rename that loses the race is a 409 LABEL_TAKEN, not a 500', async () => {
    t = setup(q => q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: null, error: { code: '23505', message: 'dup' } } : undefined)
    const res = await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { label: 'Taken' } }))
    expect(res.status).toBe(409); expect(res.body.code).toBe('LABEL_TAKEN')
  })
})

describe('saving the fixed version as the profile', () => {
  const delivered = { name: 'Ada', skills: ['Fixed'] }
  const edited = { name: 'Ada', skills: ['Edited by hand'] }
  it('uses the delivered resume (the person\'s own edits to it first) of a FIX_DELIVERED scan', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow({ status: 'FIX_DELIVERED', rewritten_resume_data: edited, user_edited_resume_data: edited }), error: null } : q.op === 'rpc' ? { data: true, error: null } : undefined)
    const res = await t.mod.saveProfile(t.c({ body: { scanId: ID1, source: 'delivered' } }))
    expect(res.status).toBe(200)
    expect(t.db.calls.find(c => c.op === 'rpc').args.p_profile.resumeData).toEqual(edited)   // an owner's edit writes BOTH columns
    t.restore()
    // Round 16: after edit -> Try Again the newer rewrite is the delivered content; the stale edit must not win.
    t = setup(q => q.table === 'scans' ? { data: scanRow({ status: 'FIX_DELIVERED', rewritten_resume_data: delivered, user_edited_resume_data: edited }), error: null } : q.op === 'rpc' ? { data: true, error: null } : undefined)
    await t.mod.saveProfile(t.c({ body: { scanId: ID1, source: 'delivered' } }))
    expect(t.db.calls.find(c => c.op === 'rpc').args.p_profile.resumeData).toEqual(delivered)
    t.restore()
    t = setup(q => q.table === 'scans' ? { data: scanRow({ status: 'FIX_DELIVERED', rewritten_resume_data: delivered }), error: null } : q.op === 'rpc' ? { data: true, error: null } : undefined)
    await t.mod.saveProfile(t.c({ body: { scanId: ID1, source: 'delivered' } }))
    expect(t.db.calls.find(c => c.op === 'rpc').args.p_profile.resumeData).toEqual(delivered)
  })
  it('works for "keep as another profile" too', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow({ status: 'FIX_DELIVERED', rewritten_resume_data: delivered }), error: null } : q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: ID2, error: null } : undefined)
    await t.mod.saveProfile(t.c({ body: { scanId: ID1, asExtra: true, source: 'delivered' } }))
    expect(t.db.calls.find(c => c.op === 'rpc').args.p_resume).toEqual(delivered)
  })
  it('refuses when no fix was delivered, and an unknown source', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow({ status: 'COMPLETE_PASS', rewritten_resume_data: delivered }), error: null } : undefined)
    expect((await t.mod.saveProfile(t.c({ body: { scanId: ID1, source: 'delivered' } }))).status).toBe(400)
    expect((await t.mod.saveProfile(t.c({ body: { scanId: ID1, source: 'bogus' } }))).status).toBe(400)
    expect(t.db.calls.some(c => c.op === 'rpc')).toBe(false)
  })
  it('the default is still the original resume', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow({ status: 'FIX_DELIVERED', rewritten_resume_data: delivered }), error: null } : q.op === 'rpc' ? { data: true, error: null } : undefined)
    await t.mod.saveProfile(t.c({ body: { scanId: ID1 } }))
    expect(t.db.calls.find(c => c.op === 'rpc').args.p_profile.resumeData).toEqual({ skills: ['SQL'] })
  })
})

describe('restore the previous version', () => {
  it('swaps via the RPC, passing the stamp the person saw', async () => {
    t = setup(q => q.op === 'rpc' ? { data: 'ok', error: null } : undefined)
    const res = await t.mod.restorePreviousProfile(t.c({ body: { replacedAt: '2026-10-01T00:00:00+00:00' } }))
    expect(res.status).toBe(200)
    expect(t.db.calls.find(c => c.op === 'rpc')).toMatchObject({ name: 'restore_previous_profile', args: { p_user_id: 'u1', p_expected_replaced_at: '2026-10-01T00:00:00+00:00' } })
  })
  it('maps none → 404 and conflict → 409 PROFILE_CHANGED; rejects a non-string stamp', async () => {
    t = setup(q => q.op === 'rpc' ? { data: 'none', error: null } : undefined)
    expect((await t.mod.restorePreviousProfile(t.c())).status).toBe(404)
    t.restore()
    t = setup(q => q.op === 'rpc' ? { data: 'conflict', error: null } : undefined)
    const r = await t.mod.restorePreviousProfile(t.c({ body: { replacedAt: 'x' } }))
    expect(r.status).toBe(409); expect(r.body.code).toBe('PROFILE_CHANGED')
    expect((await t.mod.restorePreviousProfile(t.c({ body: { replacedAt: 5 } }))).status).toBe(400)
  })
  it('GET /profile reports the previous version as a summary (no resume content)', async () => {
    const prev = { resumeData: { name: 'Ada', experience: [{ title: 'Eng', dates: '2020 – Present' }], skills: ['a', 'b'] }, roleCategory: 'design', replacedAt: 'R', savedAt: 'S' }
    t = setup(q => q.table === 'users' ? { data: { saved_profile: null, saved_profile_prev: prev }, error: null } : q.table === 'saved_profiles' ? { data: [], error: null } : undefined)
    const res = await t.mod.getProfile(t.c())
    expect(res.body.data.previousVersion).toEqual({ replacedAt: 'R', savedAt: 'S', editedAt: null,
      summary: { name: 'Ada', roleCategory: 'design', latestTitle: 'Eng', jobCount: 1, educationCount: 0, skillCount: 2 } })
    expect(JSON.stringify(res.body.data.previousVersion)).not.toContain('"experience"')
  })
  it('removing the saved profile removes its previous version too', async () => {
    t = setup(() => ({ data: null, error: null }))
    await t.mod.deleteProfile(t.c())
    const upd = t.db.calls.find(c => c.table === 'users' && c.op === 'update')
    expect(upd.patch).toEqual({ saved_profile: null, saved_profile_prev: null })
  })
  it('the export carries the previous version', async () => {
    t = setup(q => q.table === 'users' ? { data: { name: 'A', email: 'a@x', saved_profile_prev: { resumeData: { skills: ['old'] } } }, error: null }
      : q.table === 'scans' ? { data: [], count: 0, error: null } : { data: [], error: null })
    const res = await t.mod.exportMyData(t.c())
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text).previousSavedProfile).toEqual({ resumeData: { skills: ['old'] } })
  })
})

describe('preferences', () => {
  it('an empty or unrecognised body names both preferences', async () => {
    t = setup(() => ({ data: null, error: null }))
    const res = await t.mod.updatePreferences(t.c({ body: {} }))
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/notifyScanResults/); expect(res.body.message).toMatch(/notifyOutcomeFollowup/)
  })
})

describe('migration 0075', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0075_profile_dashboard_round10.sql'), 'utf8')
  it('records its own version last and the Worker expects it', () => {
    expect(constants.EXPECTED_SCHEMA_VERSION).toBeGreaterThanOrEqual(75)
    const last = sql.trimEnd().split('\n').slice(-3).join('\n')
    expect(last).toMatch(/'version', 75/)
  })
  it('adds the previous-version column, snapshots in the replacing UPDATE, and scrubs it with the account', () => {
    expect(sql).toMatch(/add column if not exists saved_profile_prev jsonb/)
    expect(sql).toMatch(/function restore_previous_profile/)
    expect(sql).toMatch(/saved_profile_prev\s*=\s*null,\s*\n\s*token_version/)
  })
  it('makes profile names unique per account after de-duplicating existing ones', () => {
    expect(sql).toMatch(/create unique index if not exists uq_saved_profiles_user_label on saved_profiles \(user_id, lower\(label\)\)/)
    expect(sql.indexOf('row_number() over')).toBeLessThan(sql.indexOf('uq_saved_profiles_user_label'))
  })
})
