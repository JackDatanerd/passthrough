import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Profile & Dashboard (Section 6), round 12.
//  B2: a profile name is cut to 40 UTF-16 units; the cut used to land inside an emoji and leave half of it.
//  B3: PUT /profile/extras/:id silently treated a malformed `version` as "no version" and wrote unconditionally,
//      while PUT /profile answers 400 for the same input.

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

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

const scanRow = { id: ID1, user_id: 'u1', status: 'COMPLETE_PASS', original_resume_data: { skills: ['SQL'] }, role_category: 'software_engineering' }
const sentLabel = () => t.db.calls.find(c => c.op === 'rpc').args.p_label
const saveAsExtra = (label, taken = []) => {
  t = setup(q => q.table === 'scans' ? { data: scanRow, error: null }
    : q.table === 'saved_profiles' ? { data: taken, error: null } : q.op === 'rpc' ? { data: ID2, error: null } : undefined)
  return t.mod.saveProfile(t.c({ body: { scanId: ID1, asExtra: true, label } }))
}

describe('B2: profile names are cut on whole characters', () => {
  it('an emoji straddling the 40-unit limit is dropped whole, not halved', async () => {
    const res = await saveAsExtra('a'.repeat(39) + '😀')
    expect(res.status).toBe(200)
    expect(sentLabel()).toBe('a'.repeat(39))
    expect(LONE.test(sentLabel())).toBe(false)
  })
  it('an emoji that fits entirely is kept', async () => {
    await saveAsExtra('a'.repeat(38) + '😀')
    expect(sentLabel()).toBe('a'.repeat(38) + '😀')
    expect(sentLabel().length).toBe(40)
  })
  it('a stray half-emoji in the input is removed', async () => {
    await saveAsExtra('Ops \uD83D lead')
    expect(sentLabel()).toBe('Ops  lead'.replace(/\s+/g, ' '))
    expect(LONE.test(sentLabel())).toBe(false)
  })
  it('the " (2)" suffix added on a name clash never cuts an emoji in half either', async () => {
    const base = 'a'.repeat(35) + '😀' + 'bb'           // 39 units: the suffix leaves room for 36, which lands inside the emoji
    await saveAsExtra(base, [{ id: 'z', label: base }])
    const label = sentLabel()
    expect(label.endsWith(' (2)')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(40)
    expect(LONE.test(label)).toBe(false)
  })
  it('a rename is cut the same way', async () => {
    t = setup(q => q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: 'ok', error: null } : undefined)
    const res = await t.mod.updateExtra(t.c({ params: { id: ID2 }, body: { label: 'a'.repeat(39) + '😀' } }))
    expect(res.status).toBe(200)
    expect(LONE.test(t.db.calls.find(c => c.op === 'rpc').args.p_label)).toBe(false)
  })
})

describe('B3: a malformed version on an additional profile is refused, not ignored', () => {
  const put = (body) => {
    t = setup(q => q.table === 'saved_profiles' ? { data: [], error: null } : q.op === 'rpc' ? { data: 'ok', error: null } : undefined)
    return t.mod.updateExtra(t.c({ params: { id: ID2 }, body }))
  }
  const wrote = () => t.db.calls.some(c => c.op === 'rpc')
  it('a number is a 400 and nothing is written', async () => {
    const res = await put({ resumeData: { skills: ['x'] }, version: 12345 })
    expect(res.status).toBe(400); expect(res.body.message).toBe('Invalid version.'); expect(wrote()).toBe(false)
  })
  it('an object is a 400', async () => {
    expect((await put({ resumeData: { skills: ['x'] }, version: { a: 1 } })).status).toBe(400); expect(wrote()).toBe(false)
  })
  it('the expectedVersion alias is held to the same rule', async () => {
    expect((await put({ resumeData: { skills: ['x'] }, expectedVersion: true })).status).toBe(400); expect(wrote()).toBe(false)
  })
  it('an over-long version is a 400', async () => {
    expect((await put({ resumeData: { skills: ['x'] }, version: '2026-09-02T00:00:00Z' + ' '.repeat(100) })).status).toBe(400)
  })
  it('a proper version is passed through to the database check', async () => {
    const res = await put({ resumeData: { skills: ['x'] }, version: '2026-09-02T00:00:00Z' })
    expect(res.status).toBe(200)
    expect(t.db.calls.find(c => c.op === 'rpc').args.p_expected_version).toBe('2026-09-02T00:00:00Z')
  })
  it('no version at all still writes unconditionally, as older clients expect', async () => {
    const res = await put({ resumeData: { skills: ['x'] } })
    expect(res.status).toBe(200)
    expect(t.db.calls.find(c => c.op === 'rpc').args.p_expected_version).toBeNull()
  })
})
