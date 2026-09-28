import { describe, it, expect, vi, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { logAdminAction } from '../src/lib/adminAudit.js'

// FEATURE GAP CLOSED (Section 12 audit): logAdminAction backs every admin
// action's audit trail (employer-leads.controller.js, and — after this same
// audit round — admin.controller.js, partners.controller.js and
// payments.controller.js too), but the only place it was ever exercised
// stubbed it out as a no-op (see employer-leads.controller.test.js). None of
// its real behaviour — the actor_id lookup, the target_id stringification,
// or the best-effort swallow-on-failure it's explicitly documented to do —
// was ever actually tested.

function fakeCtx(user) {
  return { get: key => (key === 'user' ? user : undefined) }
}

afterEach(() => vi.restoreAllMocks())

describe('logAdminAction', () => {
  it('inserts a row shaped exactly as documented, from a real actor', async () => {
    const db = createFakeSupabase()
    await logAdminAction(fakeCtx({ id: 'admin-1' }), db, 'lead.delete', 'employer_lead', 'lead-42', { note: 'dup' })

    expect(db.calls).toHaveLength(1)
    const call = db.calls[0]
    expect(call.table).toBe('admin_audit_log')
    expect(call.op).toBe('insert')
    expect(call.values).toEqual({
      actor_id: 'admin-1', action: 'lead.delete', target_type: 'employer_lead',
      target_id: 'lead-42', detail: { note: 'dup' },
    })
  })

  it('defaults detail to {} and actor_id to null when there is no acting user', async () => {
    const db = createFakeSupabase()
    await logAdminAction(fakeCtx(undefined), db, 'lead.bulk_delete', 'employer_lead', null)

    expect(db.calls[0].values).toEqual({
      actor_id: null, action: 'lead.bulk_delete', target_type: 'employer_lead',
      target_id: null, detail: {},
    })
  })

  it('coerces a non-string target_id to a string, but leaves null/undefined as null', async () => {
    const db = createFakeSupabase()
    await logAdminAction(fakeCtx({ id: 'admin-1' }), db, 'partner.payout_recorded', 'payout', 12345)
    expect(db.calls[0].values.target_id).toBe('12345')

    await logAdminAction(fakeCtx({ id: 'admin-1' }), db, 'partner.update', 'partner', undefined)
    expect(db.calls[1].values.target_id).toBeNull()
  })

  it('tolerates a ctx with no .get() at all (c.get && c.get(...) guard)', async () => {
    const db = createFakeSupabase()
    await expect(logAdminAction({}, db, 'lead.export', 'employer_leads', null)).resolves.toBeUndefined()
    expect(db.calls[0].values.actor_id).toBeNull()
  })

  // Best-effort by design (see the module's own top-of-file comment): a
  // failed audit write must never turn a completed admin action into an
  // error response, since the action already happened.
  it('swallows a DB-level error (insert resolves with {error}) and logs it, without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createFakeSupabase(() => ({ data: null, error: { message: 'insert failed' } }))
    await expect(
      logAdminAction(fakeCtx({ id: 'admin-1' }), db, 'lead.delete', 'employer_lead', 'lead-1')
    ).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0][0]).toContain('lead.delete')
  })

  it('swallows a thrown exception (network blip) and logs it, without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = { from: () => ({ insert: () => { throw new Error('connection reset') } }) }
    await expect(
      logAdminAction(fakeCtx({ id: 'admin-1' }), db, 'lead.export', 'employer_leads', null)
    ).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0][0]).toContain('lead.export')
  })
})
