import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { parseClientResumeData, stripNul } from '../src/lib/resumeData'
import { applyScanSort, parseIdList, normalizeSort, applyScanFilters } from '../src/lib/scanSearch'

// Profile & Dashboard (Section 6), round 8: NUL-safe resume data, dashboard sort + hand-picked
// delete, saved-profile downloads, and additional named profiles.

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

function setup(resolver, stubs = {}) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/verification.js': { recordTombstones: async () => {} },
    'services/docx.service.js': { generateAtsDocx: async () => new Uint8Array([1, 2, 3]) },
    'services/pdf.service.js': { generateResumePDF: async () => new Uint8Array([4]) },
    ...stubs,
  })
  const c = (over = {}) => ({
    env: { RESUMES_BUCKET: { delete: async () => {} } },
    get: () => ({ id: 'u1' }),
    header: () => {},
    req: { json: async () => over.body ?? {}, query: k => over.query?.[k], param: k => over.params?.[k] },
    json: (body, status = 200) => ({ body, status }),
    body: (raw, status = 200) => ({ raw, status }),
  })
  return { mod, restore, c, db }
}
let t
afterEach(() => t?.restore())

describe('B1 — NUL characters in resume data', () => {
  it('are stripped from values and keys instead of reaching Postgres', () => {
    const r = parseClientResumeData({ skills: ['a\u0000b'], 'k\u0000': 'v' })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.data)).not.toContain('\\u0000')
    expect(r.data.skills).toEqual(['ab'])
  })
  it('stripNul leaves other values alone', () => {
    expect(stripNul({ a: [1, null, true, 'x'] })).toEqual({ a: [1, null, true, 'x'] })
  })
})

describe('sort', () => {
  const recorder = () => { const o = []; const q = { order: (c, opts) => { o.push([c, opts.ascending, opts.nullsFirst]); return q } }; return { q, o } }
  it('defaults and unknown values mean newest', () => {
    expect(normalizeSort('nope')).toBe('newest')
    const { q, o } = recorder(); applyScanSort(q, undefined)
    expect(o).toEqual([['created_at', false, undefined], ['id', false, undefined]])
  })
  it('score_desc puts unscored scans last and keeps a total order', () => {
    const { q, o } = recorder(); applyScanSort(q, 'score_desc')
    expect(o[0]).toEqual(['ats_score', false, false]); expect(o.at(-1)[0]).toBe('id')
  })
  it('oldest is ascending on both tie-breakers', () => {
    const { q, o } = recorder(); applyScanSort(q, 'oldest')
    expect(o).toEqual([['created_at', true, undefined], ['id', true, undefined]])
  })
})

describe('hand-picked delete — ids', () => {
  it('parseIdList accepts UUIDs, de-duplicates, rejects junk and oversize lists', () => {
    expect(parseIdList(`${ID1},${ID1},${ID2}`)).toEqual({ ids: [ID1, ID2] })
    expect(parseIdList('')).toEqual({ ids: [] })
    expect(parseIdList('abc').error).toBeTruthy()
    expect(parseIdList(Array.from({ length: 51 }, (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`).join(',')).error).toBeTruthy()
  })
  it('applyScanFilters narrows by id', () => {
    const f = []; const q = { in: (c, v) => { f.push([c, v]); return q } }
    applyScanFilters(q, { ids: [ID1] })
    expect(f).toEqual([['id', [ID1]]])
  })
  it('deleteScanHistory with ids ignores search/status and deletes only those', async () => {
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select' && !q.selectOpts?.head) return { data: [{ id: ID1, status: 'COMPLETE_PASS', updated_at: '2020-01-01T00:00:00Z' }], error: null }
      if (q.table === 'scans' && q.op === 'delete') return { data: [{ id: ID1 }], error: null }
      if (q.op === 'select' && q.selectOpts?.head) return { data: null, count: 0, error: null }
      return undefined
    })
    const res = await t.mod.deleteScanHistory(t.c({ query: { ids: ID1, search: 'zzz', status: 'ERROR' } }))
    expect(res.body.data).toEqual({ deleted: 1, remaining: 0 })
    const sel = t.db.calls.find(c => c.table === 'scans' && c.op === 'select')
    expect(sel.filters).toContainEqual(['in', 'id', [ID1]])
    expect(sel.or.some(e => e.includes('ilike'))).toBe(false)
    expect(sel.filters.some(f => f[1] === 'status')).toBe(false)
  })
  it('malformed ids are a 400', async () => {
    t = setup(() => undefined)
    expect((await t.mod.deleteScanHistory(t.c({ query: { ids: 'x' } }))).status).toBe(400)
  })
})

describe('downloads', () => {
  it('404 when nothing is saved', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: null }, error: null } : undefined)
    expect((await t.mod.downloadProfileDocx(t.c())).status).toBe(404)
  })
  it('renders the primary profile as docx', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: { resumeData: { name: 'Jo Doe', skills: ['SQL'] } } }, error: null } : undefined)
    const res = await t.mod.downloadProfileDocx(t.c())
    expect(res.status).toBe(200)
  })
  it('profileId reads the additional profile, scoped to the caller', async () => {
    t = setup(q => q.table === 'saved_profiles' ? { data: { resume_data: { skills: ['SQL'] } }, error: null } : undefined)
    const res = await t.mod.downloadProfilePdf(t.c({ query: { profileId: ID1 } }))
    expect(res.status).toBe(200)
    const call = t.db.calls.find(c => c.table === 'saved_profiles')
    expect(call.filters).toContainEqual(['eq', 'user_id', 'u1'])
    expect(call.filters).toContainEqual(['eq', 'id', ID1])
  })
  it('a malformed profileId is a 400', async () => {
    t = setup(() => undefined)
    expect((await t.mod.downloadProfileDocx(t.c({ query: { profileId: 'nope' } }))).status).toBe(400)
  })
})

describe('additional profiles', () => {
  const scanRow = { id: ID1, user_id: 'u1', status: 'COMPLETE_PASS', original_resume_data: { skills: ['SQL'] }, role_category: 'engineering' }
  const saveBody = { scanId: ID1, asExtra: true, label: '  Product   roles ' }

  it('saves under a normalized label without touching the primary profile', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow, error: null } : q.op === 'rpc' ? { data: ID2, error: null } : undefined)
    const res = await t.mod.saveProfile(t.c({ body: saveBody }))
    expect(res.body.success).toBe(true)
    const rpc = t.db.calls.find(c => c.op === 'rpc')
    expect(rpc.name).toBe('add_saved_profile')
    expect(rpc.args.p_label).toBe('Product roles')
    expect(rpc.args.p_max).toBe(4)
    expect(t.db.calls.some(c => c.name === 'save_profile_from_scan')).toBe(false)
  })
  it('409 PROFILE_LIMIT when the account is full', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow, error: null } : q.op === 'rpc' ? { data: null, error: null } : undefined)
    const res = await t.mod.saveProfile(t.c({ body: saveBody }))
    expect(res.status).toBe(409); expect(res.body.code).toBe('PROFILE_LIMIT')
  })
  it('getProfile lists them with a version', async () => {
    t = setup(q => q.table === 'saved_profiles'
      ? { data: [{ id: ID2, label: 'PM', resume_data: { name: 'Jo', skills: ['a'] }, role_category: null, source_scan_id: null, saved_at: 'S', edited_at: null }], error: null }
      : q.table === 'users' ? { data: { saved_profile: null, scans_today: 0 }, error: null } : undefined)
    const res = await t.mod.getProfile(t.c())
    expect(res.body.data.extraProfiles[0]).toMatchObject({ id: ID2, label: 'PM', version: 'S' })
    expect(res.body.data.hasSavedProfile).toBe(false)
    expect(res.body.data.maxExtraProfiles).toBe(4)
  })
  it('updateExtra maps the RPC outcome to 200 / 404 / 409', async () => {
    for (const [outcome, status] of [['ok', 200], ['missing', 404], ['conflict', 409]]) {
      t = setup(q => q.op === 'rpc' ? { data: outcome, error: null } : undefined)
      const res = await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { resumeData: { skills: ['SQL'] }, version: '2026-01-01T00:00:00Z' } }))
      expect(res.status).toBe(status)
      expect(t.db.calls.find(c => c.op === 'rpc').args.p_expected_version).toBe('2026-01-01T00:00:00Z')
      t.restore()
    }
    t = undefined
  })
  it('updateExtra rejects an empty label, empty body and a bad version', async () => {
    t = setup(() => undefined)
    expect((await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { label: '   ' } }))).status).toBe(400)
    expect((await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: {} }))).status).toBe(400)
    expect((await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { label: 'x', version: 'nope' } }))).status).toBe(400)
  })
  it('deleteExtra is scoped to the caller', async () => {
    t = setup(() => undefined)
    const res = await t.mod.deleteExtra(t.c({ params: { id: ID2 } }))
    expect(res.body.success).toBe(true)
    const del = t.db.calls.find(c => c.op === 'delete')
    expect(del.filters).toContainEqual(['eq', 'user_id', 'u1'])
  })
})
