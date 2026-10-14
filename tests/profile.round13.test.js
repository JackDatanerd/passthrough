import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Profile & Dashboard (Section 6), round 13.
//  B1: "Copy as another profile" copied the resume but not the hand-edit marker (see profile.round13.pglite.test.js for
//      what the database does with it).
//  B6: an additional profile's version is compared as a timestamp in the database; a string Date.parse accepts but the
//      cast does not came back as a 500.
//  B8: the dashboard only needs the free-scan counter, which GET /profile/quota serves without reading any resume.

const ID2 = '22222222-2222-4222-8222-222222222222'
const EDITED = '2026-10-13T10:00:00.123456+00:00'

function setup(resolver) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/verification.js': { recordTombstones: async () => {} },
    'services/fulfillment.service.js': { abandonPendingForScans: async () => 0 },
  })
  const c = (over = {}) => ({
    env: {}, get: () => ({ id: 'u1' }),
    req: { json: async () => over.body ?? {}, query: k => over.query?.[k], param: k => over.params?.[k] },
    json: (body, status = 200) => ({ body, status }),
    body: (text, status = 200, headers = {}) => ({ text, status, headers }),
  })
  return { mod, restore, c, db }
}
let t
afterEach(() => t?.restore())

describe('B1: copying the main profile carries its edit marker', () => {
  const copy = (saved) => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: saved }, error: null }
      : q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: ID2, error: null } : undefined)
    return t.mod.duplicatePrimary(t.c({ body: {} }))
  }
  const sent = () => t.db.calls.find(c => c.op === 'rpc' && c.name === 'add_saved_profile').args
  it('a hand-edited main profile is copied with the same editedAt', async () => {
    const res = await copy({ resumeData: { skills: ['SQL'] }, roleCategory: 'software_engineering', editedAt: EDITED })
    expect(res.status).toBe(200)
    expect(sent().p_edited_at).toBe(EDITED)
  })
  it('an unedited main profile is copied with no marker', async () => {
    await copy({ resumeData: { skills: ['SQL'] }, roleCategory: 'software_engineering' })
    expect(sent().p_edited_at).toBeNull()
  })
})

describe('B6: the version of an additional profile has to be a timestamp the database can read', () => {
  const put = (version) => {
    t = setup(q => q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: 'ok', error: null } : undefined)
    return t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { resumeData: { skills: ['x'] }, version } }))
  }
  const wrote = () => t.db.calls.some(c => c.op === 'rpc')
  it.each([
    'Oct 13 2026 10:00 GMT+0200',
    '2026-10-13',
    '2026-10-13 10:00:00',
    'tomorrow',
    '2026-13-45T99:99:99Z',
    '2026-10-13T10:00:00',
  ])('%s is a 400 and nothing is written', async (v) => {
    const res = await put(v)
    expect(res.status).toBe(400); expect(res.body.message).toBe('Invalid version.'); expect(wrote()).toBe(false)
  })
  it.each([
    '2026-10-13T10:00:00Z',
    '2026-10-13T10:00:00.123Z',
    EDITED,
    '2026-10-13T18:20:25.55+00:00',
    '2026-10-13T13:00:00+03:00',
    '2026-10-13T13:00:00+0300',
  ])('%s (a form the API itself hands out or an ISO string) goes through to the database check', async (v) => {
    const res = await put(v)
    expect(res.status).toBe(200)
    expect(t.db.calls.find(c => c.op === 'rpc').args.p_expected_version).toBe(v)
  })
})

describe('B8: GET /profile/quota', () => {
  const midnight = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d }
  it('answers with the allowance and reads only the two counter columns', async () => {
    t = setup(q => q.table === 'users' ? { data: { scans_today: 2, scans_day_reset: new Date().toISOString() }, error: null } : undefined)
    const res = await t.mod.getQuota(t.c())
    expect(res.status).toBe(200)
    expect(res.body.data.quota).toMatchObject({ used: 2, remaining: res.body.data.quota.limit - 2 })
    expect(Object.keys(res.body.data)).toEqual(['quota'])
    const reads = t.db.calls.filter(c => c.op === 'select')
    expect(reads).toHaveLength(1)                                  // one query, and not against saved_profiles
    expect(reads[0].table).toBe('users')
    expect(reads[0].cols.replace(/\s/g, '')).toBe('scans_today,scans_day_reset')
  })
  it('yesterday\'s counter is a fresh allowance, the same rule GET /profile applies', async () => {
    t = setup(q => q.table === 'users' ? { data: { scans_today: 3, scans_day_reset: new Date(midnight().getTime() - 3600_000).toISOString() }, error: null } : undefined)
    const res = await t.mod.getQuota(t.c())
    expect(res.body.data.quota.used).toBe(0)
  })
  it('is routed behind auth', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../src/routes/profile.routes.js', import.meta.url), 'utf8')
    expect(src).toMatch(/router\.get\(\s*'\/quota',\s*auth,\s*c\.getQuota\)/)
  })
})
