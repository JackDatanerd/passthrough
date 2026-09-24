import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import v from '../src/lib/verification.js'

// Round-2 audit, Section 7: a banned account's public verification pages must come down,
// and an un-ban must restore exactly those — nothing the owner/refund/admin had taken down.

const scan = (id, over = {}) => ({ id, user_id: 'u1', verification_code: 'AB3XY' + id.slice(-1), verification_status: 'ACTIVE',
  verification_revoked_at: null, verification_revoked_reason: null, ...over })

describe('revokeUserVerifications / restoreUserVerifications', () => {
  it('revokes every ACTIVE page of the user under reason BAN, and only those', async () => {
    const w = createWorld({ scans: [
      scan('s1'), scan('s2'),
      scan('s3', { verification_status: 'REVOKED', verification_revoked_reason: 'OWNER' }),
      scan('s4', { verification_status: 'REVOKED', verification_revoked_reason: 'REFUND' }),
      scan('s5', { user_id: 'someone-else' }),
      scan('s6', { verification_code: null }),                 // never had a page
    ] })
    const n = await v.revokeUserVerifications(w.db, 'u1')
    expect(n).toBe(2)
    const by = id => w.t.scans.find(s => s.id === id)
    expect(by('s1')).toMatchObject({ verification_status: 'REVOKED', verification_revoked_reason: 'BAN' })
    expect(by('s2').verification_revoked_reason).toBe('BAN')
    expect(by('s3').verification_revoked_reason).toBe('OWNER')  // the owner's own unpublish keeps its reason
    expect(by('s4').verification_revoked_reason).toBe('REFUND')
    expect(by('s5').verification_status).toBe('ACTIVE')         // another user untouched
    expect(by('s6').verification_status).toBe('ACTIVE')
  })

  it('un-ban restores ONLY the BAN takedowns — never an owner/refund/admin one', async () => {
    const w = createWorld({ scans: [
      scan('s1', { verification_status: 'REVOKED', verification_revoked_reason: 'BAN', verification_revoked_at: 'x' }),
      scan('s3', { verification_status: 'REVOKED', verification_revoked_reason: 'OWNER' }),
      scan('s4', { verification_status: 'REVOKED', verification_revoked_reason: 'REFUND' }),
      scan('s7', { verification_status: 'REVOKED', verification_revoked_reason: 'ADMIN' }),
    ] })
    expect(await v.restoreUserVerifications(w.db, 'u1')).toBe(1)
    const by = id => w.t.scans.find(s => s.id === id)
    expect(by('s1')).toMatchObject({ verification_status: 'ACTIVE', verification_revoked_reason: null, verification_revoked_at: null })
    expect(by('s3').verification_status).toBe('REVOKED')
    expect(by('s4').verification_status).toBe('REVOKED')
    expect(by('s7').verification_status).toBe('REVOKED')
  })

  it('ban → unban round-trips, and the owner cannot republish a BAN takedown themselves', async () => {
    const w = createWorld({ scans: [scan('s1')] })
    await v.revokeUserVerifications(w.db, 'u1')
    expect(await v.restoreVerification(w.db, 's1')).toBe(false)            // owner-scoped restore: reason is BAN
    expect(w.t.scans[0].verification_status).toBe('REVOKED')
    await v.restoreUserVerifications(w.db, 'u1')
    expect(w.t.scans[0].verification_status).toBe('ACTIVE')
  })

  it('is idempotent, tolerates a missing user id, and throws on a DB error so the admin can retry', async () => {
    const w = createWorld({ scans: [scan('s1')] })
    expect(await v.revokeUserVerifications(w.db, 'u1')).toBe(1)
    expect(await v.revokeUserVerifications(w.db, 'u1')).toBe(0)
    expect(await v.revokeUserVerifications(w.db, null)).toBe(0)
    w.failNext('scans', 'update', { message: 'db down' })
    await expect(v.revokeUserVerifications(w.db, 'u1')).rejects.toBeTruthy()
  })
})

describe('adminUpdateUser wires ban / unban to the verification pages', () => {
  function setup() {
    const db = createFakeSupabase(q => {
      if (q.table === 'users') return { data: { id: 'u1', status: 'X', role: 'USER' }, error: null }
      if (q.table === 'scans') return { data: [{ id: 's1' }, { id: 's2' }], error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = body => ({ env: {}, get: () => ({ id: 'admin-1' }), req: { query: () => undefined, param: () => 'u1', json: async () => body }, json: (b, s = 200) => ({ body: b, status: s }) })
    return { mod, restore, db, c }
  }
  let t
  afterEach(() => t?.restore())

  it('BANNED revokes the user\'s active pages (reason BAN) and reports how many', async () => {
    t = setup()
    const res = await t.mod.adminUpdateUser(t.c({ status: 'BANNED' }))
    expect(res.status).toBe(200)
    expect(res.body.data.verification).toEqual({ revoked: 2 })
    const upd = t.db.calls.find(q => q.table === 'scans' && q.op === 'update')
    expect(upd.patch).toMatchObject({ verification_status: 'REVOKED', verification_revoked_reason: 'BAN' })
    expect(upd.filters).toContainEqual(['eq', 'user_id', 'u1'])
    expect(upd.filters).toContainEqual(['eq', 'verification_status', 'ACTIVE'])
  })
  it('ACTIVE restores only BAN takedowns', async () => {
    t = setup()
    const res = await t.mod.adminUpdateUser(t.c({ status: 'ACTIVE' }))
    expect(res.body.data.verification).toEqual({ restored: 2 })
    const upd = t.db.calls.find(q => q.table === 'scans' && q.op === 'update')
    expect(upd.filters).toContainEqual(['eq', 'verification_revoked_reason', 'BAN'])
  })
  it('a role-only change touches no verification page', async () => {
    t = setup()
    const res = await t.mod.adminUpdateUser(t.c({ role: 'SEEKER' }))
    expect(res.body.data.verification).toBeUndefined()
    expect(t.db.calls.some(q => q.table === 'scans')).toBe(false)
  })
})
