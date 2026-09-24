import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// The dashboard's list endpoint: what it returns to tell scans apart and to
// decide when a stuck scan may be deleted, and what its search box matches.

let t
afterEach(() => t?.restore())

function setup(rows, count = rows.length) {
  const db = createFakeSupabase(q => (q.table === 'scans' ? { data: rows, error: null, count } : undefined))
  const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  return { mod, restore, db }
}
const ctx = (query = {}) => ({
  env: {},
  get: k => (k === 'user' ? { id: 'u1' } : undefined),
  req: { query: k => query[k], param: () => undefined },
  json: (body, status = 200) => ({ body, status }),
})
const row = (over = {}) => ({
  id: 's1', status: 'COMPLETE_PASS', ats_score: 80, passed: true, resume_original_name: null, input_mode: 'saved_profile',
  created_at: '2026-09-01T00:00:00Z', fix_purchased: false, fix_tier: null, verification_code: null, verification_status: null,
  fix_ats_score: null, keyword_score: 1, format_score: 1, sections_score: 1, content_score: 1,
  job_title: 'Senior Backend Engineer', role_category: 'software_engineering', seniority_level: 'senior', updated_at: '2026-09-01T00:05:00Z', ...over,
})

describe('getScanHistory — what tells scans apart', () => {
  it('returns the job title, role, seniority and last-touched time for each scan', async () => {
    t = setup([row()])
    const { scans } = (await t.mod.getScanHistory(ctx())).body.data
    expect(scans[0]).toMatchObject({
      jobTitle: 'Senior Backend Engineer', roleCategory: 'software_engineering', seniorityLevel: 'senior', updatedAt: '2026-09-01T00:05:00Z',
    })
  })
  it('a scan with no derived title (older row, JD without a title line) comes back as null, never undefined', async () => {
    t = setup([row({ job_title: undefined, role_category: undefined, seniority_level: undefined })])
    const s = (await t.mod.getScanHistory(ctx())).body.data.scans[0]
    expect(s.jobTitle).toBeNull()
    expect(s.roleCategory).toBeNull()
    expect(s.seniorityLevel).toBeNull()
  })
  it('selects only explicit columns, including the new ones (never select *)', async () => {
    t = setup([])
    await t.mod.getScanHistory(ctx())
    const cols = t.db.calls.find(c => c.table === 'scans').cols
    expect(cols).not.toBe('*')
    for (const col of ['job_title', 'role_category', 'seniority_level', 'updated_at']) expect(cols).toContain(col)
    expect(cols).not.toMatch(/job_description_text|full_ats_report|original_resume_data/)   // still a light list query
  })
})

describe('getScanHistory — search', () => {
  it('matches the file name, the candidate first name and the job title', async () => {
    t = setup([])
    await t.mod.getScanHistory(ctx({ search: 'analyst' }))
    const or = [].concat(t.db.calls.find(c => c.table === 'scans').or).join(' ')
    expect(or).toContain('resume_original_name.ilike.%analyst%')
    expect(or).toContain('candidate_first_name.ilike.%analyst%')
    expect(or).toContain('job_title.ilike.%analyst%')
  })
  it('strips everything with meaning inside a PostgREST or() string / ilike pattern', async () => {
    t = setup([])
    await t.mod.getScanHistory(ctx({ search: 'a,b(c)"d%e\\f*g' }))
    const or = [].concat(t.db.calls.find(c => c.table === 'scans').or).join(' ')
    expect(or).toContain('job_title.ilike.%abcdefg%')
  })
  it('the past-the-end count query applies the same search', async () => {
    const db = createFakeSupabase(q => {
      if (q.table !== 'scans') return undefined
      if (q.selectOpts?.head) return { count: 4, error: null }
      return { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    t = { restore }
    const res = await mod.getScanHistory(ctx({ search: 'analyst', page: '9' }))
    expect(res.body.data).toMatchObject({ scans: [], total: 4 })
    const head = db.calls.find(c => c.selectOpts?.head)
    expect([].concat(head.or).join(' ')).toContain('job_title.ilike.%analyst%')
  })
})
