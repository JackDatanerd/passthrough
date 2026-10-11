import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Profile & Dashboard (Section 6), round 9: purge closes open checkouts, a purge cannot stall behind held
// scans, rename leaves the resume alone, unique labels, copy / make-main, the follow-up preference.

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

function setup(resolver, stubs = {}) {
  const db = createFakeSupabase(resolver)
  const abandoned = []
  const abandonInfo = []
  const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/verification.js': { recordTombstones: async () => {} },
    'services/fulfillment.service.js': { abandonPendingForScans: async (_s, ids, olderThan) => {
      abandoned.push(...ids); abandonInfo.push({ olderThan, scansAlreadyDeleted: db.calls.some(x => x.table === 'scans' && x.op === 'delete') }); return ids.length } },
    ...stubs,
  })
  const c = (over = {}) => ({
    env: { RESUMES_BUCKET: { delete: async () => {} } },
    get: () => ({ id: 'u1' }),
    req: { json: async () => over.body ?? {}, query: k => over.query?.[k], param: k => over.params?.[k] },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, c, db, abandoned, abandonInfo }
}
let t
afterEach(() => t?.restore())

const R = (id) => ({ id, status: 'COMPLETE_PASS', updated_at: '2020-01-01', resume_path: null, resume_ats_path: null, resume_pdf_path: null, verification_code: null })

describe('deleteScanHistory — open checkouts and in-flight races', () => {
  it('closes the open checkouts of the batch BEFORE deleting it (payments.scan_id is set null by the delete), only the old ones', async () => {
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select' && q.selectOpts?.head) return { count: 0, error: null }
      if (q.table === 'scans' && q.op === 'select') return { data: [R('a'), R('b')], error: null }
      if (q.table === 'scans' && q.op === 'delete') return { data: [{ id: 'b' }], error: null }
    })
    await t.mod.deleteScanHistory(t.c())
    expect(t.abandoned).toEqual(['a', 'b'])
    expect(t.abandonInfo).toHaveLength(1)
    expect(t.abandonInfo[0].scansAlreadyDeleted).toBe(false)
    // limited to checkouts at least an hour old — the same window that lets a delete through at all
    const age = Date.now() - Date.parse(t.abandonInfo[0].olderThan)
    expect(age).toBeGreaterThanOrEqual(59 * 60 * 1000); expect(age).toBeLessThan(61 * 60 * 1000)
  })
  it('nothing deleted, nothing abandoned', async () => {
    t = setup(q => (q.table === 'scans' && q.op === 'select' && !q.selectOpts?.head) ? { data: [], error: null } : undefined)
    await t.mod.deleteScanHistory(t.c())
    expect(t.abandoned).toEqual([])
  })
  it('repeats the in-flight rule on the delete itself', async () => {
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select' && !q.selectOpts?.head) return { data: [R('a')], error: null }
      if (q.table === 'scans' && q.op === 'delete') return { data: [{ id: 'a' }], error: null }
    })
    await t.mod.deleteScanHistory(t.c())
    const del = t.db.calls.find(c => c.op === 'delete')
    expect(del.or).toHaveLength(1)
    expect(del.or[0]).toMatch(/^status\.not\.in\.\(PENDING,SCANNING,FIX_PURCHASED,FIX_GENERATING\),updated_at\.lte\./)
    expect(del.filters).toContainEqual(['eq', 'user_id', 'u1'])
  })
  it('a full batch that is entirely held by open payments moves on to the next-oldest scans instead of reporting nothing', async () => {
    const first = Array.from({ length: 25 }, (_, i) => R(`h${i}`))
    let listCalls = 0
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select' && q.selectOpts?.head) return { count: 3, error: null }
      if (q.table === 'scans' && q.op === 'select') { listCalls++; return { data: listCalls === 1 ? first : [R('free1')], error: null } }
      if (q.table === 'payments') return { data: listCalls === 1 ? first.map(r => ({ scan_id: r.id })) : [], error: null }
      if (q.table === 'scans' && q.op === 'delete') return { data: [{ id: 'free1' }], error: null }
    })
    const res = await t.mod.deleteScanHistory(t.c())
    expect(res.body.data.deleted).toBe(1)
    const lists = t.db.calls.filter(c => c.table === 'scans' && c.op === 'select' && !c.selectOpts?.head)
    expect(lists).toHaveLength(2)
    const notIn = lists[1].filters.find(f => f[0] === 'not' && f[1] === 'id')
    expect(notIn[3]).toContain('h0'); expect(notIn[3]).toContain('h24')
  })
  it('gives up after a few rounds rather than looping', async () => {
    const full = Array.from({ length: 25 }, (_, i) => R(`x${i}`))
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select' && q.selectOpts?.head) return { count: 9, error: null }
      if (q.table === 'scans' && q.op === 'select') return { data: full, error: null }
      if (q.table === 'payments') return { data: full.map(r => ({ scan_id: r.id })), error: null }
    })
    const res = await t.mod.deleteScanHistory(t.c())
    expect(res.body.data).toEqual({ deleted: 0, remaining: 9 })
    expect(t.db.calls.filter(c => c.table === 'scans' && c.op === 'select' && !c.selectOpts?.head).length).toBeLessThanOrEqual(4)
  })
})

describe('additional profiles — rename, labels, copy, make main', () => {
  const scanRow = { id: ID1, user_id: 'u1', status: 'COMPLETE_PASS', original_resume_data: { skills: ['SQL'] }, role_category: 'engineering' }

  it('a rename sends a NULL resume and never reads the stored one', async () => {
    t = setup(q => q.op === 'rpc' ? { data: 'ok', error: null } : q.table === 'saved_profiles' ? { data: [], error: null } : undefined)
    const res = await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { label: ' New  name ' } }))
    expect(res.status).toBe(200)
    const rpc = t.db.calls.find(c => c.op === 'rpc')
    expect(rpc.args.p_resume).toBeNull()
    expect(rpc.args.p_label).toBe('New name')
    expect(t.db.calls.some(c => c.table === 'saved_profiles' && c.cols === 'resume_data')).toBe(false)
  })
  it('a rename to a name another profile already has is refused (case-insensitive), the same profile may keep its own', async () => {
    t = setup(q => q.table === 'saved_profiles' ? { data: [{ id: ID1, label: 'Product' }, { id: ID2, label: 'Design' }], error: null } : { data: 'ok', error: null })
    const clash = await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { label: 'product' } }))
    expect(clash.status).toBe(409); expect(clash.body.code).toBe('LABEL_TAKEN')
    t.restore()
    t = setup(q => q.table === 'saved_profiles' ? { data: [{ id: ID1, label: 'Product' }, { id: ID2, label: 'Design' }], error: null } : { data: 'ok', error: null })
    expect((await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { label: 'DESIGN' } }))).status).toBe(200)
  })
  it('saving from a scan under a taken label appends a number', async () => {
    t = setup(q => q.table === 'scans' ? { data: scanRow, error: null }
      : q.table === 'saved_profiles' ? { data: [{ id: ID2, label: 'Product roles' }, { id: 'z', label: 'Product roles (2)' }], error: null }
      : q.op === 'rpc' ? { data: ID1, error: null } : undefined)
    const res = await t.mod.saveProfile(t.c({ body: { scanId: ID1, asExtra: true, label: 'product roles' } }))
    expect(res.body.data.label).toBe('product roles (3)')
  })
  it('duplicatePrimary copies the main profile into an additional one', async () => {
    const saved = { resumeData: { skills: ['SQL'] }, roleCategory: 'engineering', sourceScanId: ID1, savedAt: 's' }
    t = setup(q => q.table === 'users' ? { data: { saved_profile: saved }, error: null }
      : q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: ID2, error: null } : undefined)
    const res = await t.mod.duplicatePrimary(t.c({ body: {} }))
    expect(res.body).toMatchObject({ success: true, data: { id: ID2 } })
    const rpc = t.db.calls.find(c => c.op === 'rpc')
    expect(rpc).toMatchObject({ name: 'add_saved_profile' })
    expect(rpc.args).toMatchObject({ p_resume: saved.resumeData, p_role_category: 'engineering', p_source_scan_id: ID1, p_max: 4 })
  })
  it('duplicatePrimary: 404 without a main profile, 409 when full', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: null }, error: null } : undefined)
    expect((await t.mod.duplicatePrimary(t.c())).status).toBe(404)
    t.restore()
    t = setup(q => q.table === 'users' ? { data: { saved_profile: { resumeData: { skills: ['a'] } } }, error: null }
      : q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: null, error: null } : undefined)
    const full = await t.mod.duplicatePrimary(t.c())
    expect(full.status).toBe(409); expect(full.body.code).toBe('PROFILE_LIMIT')
  })
  it('promoteExtra maps the RPC outcome and validates the id', async () => {
    t = setup(q => q.op === 'rpc' ? { data: 'ok', error: null } : undefined)
    expect((await t.mod.promoteExtra(t.c({ params: { id: ID2 } }))).status).toBe(200)
    expect(t.db.calls.find(c => c.op === 'rpc').args).toEqual({ p_user_id: 'u1', p_id: ID2 })
    expect((await t.mod.promoteExtra(t.c({ params: { id: 'nope' } }))).status).toBe(400)
    t.restore()
    t = setup(q => q.op === 'rpc' ? { data: 'missing', error: null } : undefined)
    expect((await t.mod.promoteExtra(t.c({ params: { id: ID2 } }))).status).toBe(404)
  })
})

describe('updatePreferences — two independent email switches', () => {
  it('writes only the keys sent', async () => {
    t = setup()
    const res = await t.mod.updatePreferences(t.c({ body: { notifyOutcomeFollowup: false } }))
    expect(res.body.data).toEqual({ notifyOutcomeFollowup: false })
    expect(t.db.calls[0].patch).toEqual({ notify_outcome_followup: false })
  })
  it('writes both when both are sent', async () => {
    t = setup()
    await t.mod.updatePreferences(t.c({ body: { notifyScanResults: true, notifyOutcomeFollowup: false } }))
    expect(t.db.calls[0].patch).toEqual({ notify_scan_results: true, notify_outcome_followup: false })
  })
  it('refuses a non-boolean, an empty body and an array', async () => {
    t = setup()
    expect((await t.mod.updatePreferences(t.c({ body: { notifyOutcomeFollowup: 'no' } }))).status).toBe(400)
    expect((await t.mod.updatePreferences(t.c({ body: {} }))).status).toBe(400)
    expect((await t.mod.updatePreferences(t.c({ body: [] }))).status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
  })
})

describe('migration 0074', () => {
  const sql = fs.readFileSync(new URL('../supabase/migrations/0074_profile_dashboard_round9.sql', import.meta.url), 'utf8')
  it('rename-only keeps the resume and its edit stamp', () => {
    expect(sql).toMatch(/resume_data = coalesce\(p_resume, resume_data\)/)
    expect(sql).toMatch(/edited_at\s+= case when p_resume is null then edited_at else p_edited_at end/)
  })
  it('outcomes survive their scan: set null + a trigger that scrubs the story first', () => {
    expect(sql).toMatch(/on delete set null/)
    expect(sql).toMatch(/before delete\s+on scans/)
    expect(sql).toMatch(/story_text\s+= null/)
  })
  it('is locked to the service role and records its version last', () => {
    expect(sql).toMatch(/revoke execute on function promote_saved_profile/)
    expect(sql.trim().split('\n').slice(-3).join('\n')).toContain("'version', 74")
  })
})
