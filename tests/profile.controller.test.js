import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// SECTION 12 AUDIT: profile.controller.js had zero test coverage. Of
// particular interest is saveProfile's ownership check (a scanId in the
// body, not a route param — so it isn't covered by any route-level UUID or
// ownership middleware) since it's the one place in this file a bug would
// be a real cross-account data leak, not just a wrong response.

function setup(resolver) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
  })
  const c = (over = {}) => ({
    env: {},
    get: () => ({ id: over.userId ?? 'u1' }),
    req: { json: async () => over.body ?? {} },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, c, db }
}
let t
afterEach(() => t?.restore())

describe('getProfile', () => {
  it('reports no saved profile when saved_profile is null', async () => {
    t = setup(q => (q.table === 'users' ? { data: { saved_profile: null }, error: null } : undefined))
    const res = await t.mod.getProfile(t.c())
    expect(res.body.data).toEqual({ hasSavedProfile: false, savedAt: null, sourceScanId: null, summary: null })
  })

  it('summarizes an existing saved profile without exposing the full resumeData', async () => {
    t = setup(q => (q.table === 'users' ? {
      data: { saved_profile: { resumeData: { name: 'Jane Doe', email: 'jane@x.com' }, savedAt: 't1', sourceScanId: 's1', roleCategory: 'engineering' } },
      error: null,
    } : undefined))
    const res = await t.mod.getProfile(t.c())
    expect(res.body.data).toEqual({
      hasSavedProfile: true, savedAt: 't1', sourceScanId: 's1',
      summary: { name: 'Jane Doe', roleCategory: 'engineering' },
    })
    expect(res.body.data.summary.email).toBeUndefined()
  })

  it('scopes the lookup to the requesting user', async () => {
    t = setup(q => (q.table === 'users' ? { data: { saved_profile: null }, error: null } : undefined))
    await t.mod.getProfile(t.c({ userId: 'u42' }))
    const call = t.db.calls.find(c => c.table === 'users')
    expect(call.filters.find(f => f[0] === 'eq')).toEqual(['eq', 'id', 'u42'])
  })

  it('propagates a database error', async () => {
    t = setup(q => (q.table === 'users' ? { data: null, error: new Error('db down') } : undefined))
    await expect(t.mod.getProfile(t.c())).rejects.toThrow('db down')
  })
})

describe('saveProfile', () => {
  it('400s when scanId is missing, before any DB call', async () => {
    t = setup(() => undefined)
    const res = await t.mod.saveProfile(t.c({ body: {} }))
    expect(res.status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
  })

  it('400s on a malformed scanId, before any DB call', async () => {
    t = setup(() => undefined)
    const res = await t.mod.saveProfile(t.c({ body: { scanId: 'not-a-uuid' } }))
    expect(res.status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
  })

  it('403s (Access denied) when the scan does not exist', async () => {
    t = setup(q => (q.table === 'scans' ? { data: null, error: null } : undefined))
    const res = await t.mod.saveProfile(t.c({ body: { scanId: '11111111-1111-1111-1111-111111111111' } }))
    expect(res.status).toBe(403)
  })

  // The critical ownership boundary: a scan belonging to someone else must
  // never be copyable into the caller's own saved_profile.
  it('403s — and never writes users.saved_profile — when the scan belongs to a different user', async () => {
    t = setup(q => {
      if (q.table === 'scans') return { data: { id: 's1', user_id: 'someone-else', original_resume_data: { name: 'X' } }, error: null }
    })
    const res = await t.mod.saveProfile(t.c({ userId: 'u1', body: { scanId: '11111111-1111-1111-1111-111111111111' } }))
    expect(res.status).toBe(403)
    expect(t.db.calls.some(c => c.table === 'users' && c.op === 'update')).toBe(false)
  })

  it('400s when the owned scan has no structured resume data yet', async () => {
    t = setup(q => {
      if (q.table === 'scans') return { data: { id: 's1', user_id: 'u1', original_resume_data: null }, error: null }
    })
    const res = await t.mod.saveProfile(t.c({ userId: 'u1', body: { scanId: '11111111-1111-1111-1111-111111111111' } }))
    expect(res.status).toBe(400)
  })

  it('saves resumeData + sourceScanId + roleCategory for an owned, structured scan', async () => {
    let updatePatch = null
    t = setup(q => {
      if (q.table === 'scans') return { data: { id: 's1', user_id: 'u1', original_resume_data: { name: 'Jane' }, role_category: 'engineering' }, error: null }
      if (q.table === 'users' && q.op === 'update') { updatePatch = q.patch; return { data: null, error: null } }
    })
    const res = await t.mod.saveProfile(t.c({ userId: 'u1', body: { scanId: '11111111-1111-1111-1111-111111111111' } }))
    expect(res.body.success).toBe(true)
    expect(updatePatch.saved_profile).toMatchObject({ resumeData: { name: 'Jane' }, sourceScanId: 's1', roleCategory: 'engineering' })
    expect(typeof updatePatch.saved_profile.savedAt).toBe('string')
  })

  it('stores roleCategory as null rather than undefined when the scan has none', async () => {
    let updatePatch = null
    t = setup(q => {
      if (q.table === 'scans') return { data: { id: 's1', user_id: 'u1', original_resume_data: { name: 'Jane' }, role_category: null }, error: null }
      if (q.table === 'users' && q.op === 'update') { updatePatch = q.patch; return { data: null, error: null } }
    })
    await t.mod.saveProfile(t.c({ userId: 'u1', body: { scanId: '11111111-1111-1111-1111-111111111111' } }))
    expect(updatePatch.saved_profile.roleCategory).toBe(null)
  })

  it('propagates a database error on the update', async () => {
    t = setup(q => {
      if (q.table === 'scans') return { data: { id: 's1', user_id: 'u1', original_resume_data: { name: 'Jane' } }, error: null }
      if (q.table === 'users' && q.op === 'update') return { data: null, error: new Error('write failed') }
    })
    await expect(t.mod.saveProfile(t.c({ userId: 'u1', body: { scanId: '11111111-1111-1111-1111-111111111111' } }))).rejects.toThrow('write failed')
  })
})

describe('deleteProfile', () => {
  it('clears saved_profile for the requesting user only', async () => {
    t = setup(q => (q.table === 'users' && q.op === 'update' ? { data: null, error: null } : undefined))
    const res = await t.mod.deleteProfile(t.c({ userId: 'u7' }))
    expect(res.body.success).toBe(true)
    const call = t.db.calls.find(c => c.table === 'users')
    expect(call.patch).toEqual({ saved_profile: null })
    expect(call.filters.find(f => f[0] === 'eq')).toEqual(['eq', 'id', 'u7'])
  })

  it('propagates a database error', async () => {
    t = setup(q => (q.table === 'users' && q.op === 'update' ? { data: null, error: new Error('db down') } : undefined))
    await expect(t.mod.deleteProfile(t.c())).rejects.toThrow('db down')
  })
})
