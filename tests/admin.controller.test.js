import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// SECTION 12 AUDIT: admin.controller.js had only one of its twelve functions
// tested (adminRequeueFix, via admin.requeue.test.js). This file covers the
// rest — dashboard stats, user list/detail/update, scan list, verification
// revoke/restore, payments/email-logs/alerts lists. adminUpdateUser is the
// one with real teeth (bans, role changes) so it gets the closest look.

function setup(resolver) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/admin.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
  })
  const c = (over = {}) => ({
    env: over.env ?? {},
    get: () => over.actingUser ?? { id: 'admin-1' },
    req: {
      query: k => (over.query ?? {})[k],
      param: () => over.param ?? 'id-1',
      json: async () => over.body ?? {},
    },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, c, db }
}
let t
afterEach(() => t?.restore())

describe('adminDashboardStats', () => {
  // AUDIT FIX under test: "week" must reach back across a month boundary
  // rather than being sliced out of a query that only fetched from the
  // start of the month.
  it('queries revenue from whichever boundary (week-start or month-start) is earliest, not just month-start', async () => {
    t = setup(q => {
      if (q.table === 'payments' && q.op === 'select' && q.cols?.includes('amount_cents'))
        return { data: [], error: null }
      if (q.table === 'commission_ledger') return { data: [], error: null }
      if (q.table === 'alert_logs') return { data: [], error: null }
      return { data: [], error: null, count: 0 }
    })
    await t.mod.adminDashboardStats(t.c())
    const payCall = t.db.calls.find(c => c.table === 'payments' && c.cols?.includes('amount_cents'))
    const gte = payCall.filters.find(f => f[0] === 'gte' && f[1] === 'created_at')[2]
    // Whatever "now" resolves to, the query's lower bound must be <= the
    // literal 7-days-ago cutoff — i.e. never narrower than the week window.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    expect(gte <= sevenDaysAgo).toBe(true)
  })

  it('buckets revenue into today/week/month from the fetched payments', async () => {
    const now = new Date()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
    t = setup(q => {
      if (q.table === 'payments' && q.cols?.includes('amount_cents'))
        return { data: [{ amount_cents: 1000, created_at: today }, { amount_cents: 2000, created_at: today }], error: null }
      if (q.table === 'commission_ledger') return { data: [{ commission_amount_cents: 500 }], error: null }
      if (q.table === 'alert_logs') return { data: [], error: null }
      return { data: [], error: null, count: 3 }
    })
    const res = await t.mod.adminDashboardStats(t.c())
    expect(res.body.data.revenue.todayCents).toBe(3000)
    expect(res.body.data.revenue.weekCents).toBe(3000)
    expect(res.body.data.revenue.monthCents).toBe(3000)
    expect(res.body.data.totalPendingCommissionCents).toBe(500)
    expect(res.body.data.openItems.erroredScansThisWeek).toBe(3)
  })

  it('propagates an error from any one of its several queries', async () => {
    t = setup(q => {
      if (q.table === 'payments' && q.cols?.includes('amount_cents')) return { data: null, error: new Error('boom') }
    })
    await expect(t.mod.adminDashboardStats(t.c())).rejects.toThrow('boom')
  })
})

describe('adminListUsers', () => {
  it('maps rows to camelCase with pagination meta', async () => {
    t = setup(q => (q.table === 'users'
      ? { data: [{ id: 'u1', email: 'a@b.com', name: 'A', role: 'SEEKER', status: 'ACTIVE', email_verified: true, scans_today: 1, scans_day_reset: 't', created_at: 't' }], error: null, count: 1 }
      : undefined))
    const res = await t.mod.adminListUsers(t.c({ query: { page: '2', pageSize: '10' } }))
    expect(res.body.data[0]).toMatchObject({ id: 'u1', emailVerified: true, scansToday: 1 })
    expect(res.body.meta).toEqual({ page: 2, pageSize: 10, total: 1 })
  })

  it('never selects sensitive columns (password_hash etc.)', async () => {
    t = setup(q => (q.table === 'users' ? { data: [], error: null, count: 0 } : undefined))
    await t.mod.adminListUsers(t.c())
    const call = t.db.calls.find(c => c.table === 'users')
    expect(call.cols).not.toMatch(/password_hash|paystack_auth_code|reset_token|email_verify_token/)
  })

  it('sanitizes the search term (strips commas/parens) before building .or()', async () => {
    t = setup(q => (q.table === 'users' ? { data: [], error: null, count: 0 } : undefined))
    await t.mod.adminListUsers(t.c({ query: { search: 'a,(b)' } }))
    const call = t.db.calls.find(c => c.table === 'users')
    const orExpr = (call.or || []).join(',')
    expect(orExpr).toContain('%ab%')     // stray , ( ) from the raw input stripped out of the term
    expect(orExpr).not.toContain('(b)')
    expect(orExpr).not.toContain('a,(')
  })

  it('applies status and role filters when given', async () => {
    t = setup(q => (q.table === 'users' ? { data: [], error: null, count: 0 } : undefined))
    await t.mod.adminListUsers(t.c({ query: { status: 'BANNED', role: 'ADMIN' } }))
    const call = t.db.calls.find(c => c.table === 'users')
    expect(call.filters.find(f => f[1] === 'status')[2]).toBe('BANNED')
    expect(call.filters.find(f => f[1] === 'role')[2]).toBe('ADMIN')
  })

  // AUDIT FIX (Section 9/10 re-audit, feature gap): terms_accepted_at/
  // terms_version (migration 0038) were captured at signup but surfaced
  // nowhere admin-facing — the only place in the app that could ever answer
  // "did this account accept the current Terms, and which version."
  it('surfaces termsAcceptedAt/termsVersion (Section 9/10 fix)', async () => {
    t = setup(q => (q.table === 'users'
      ? { data: [{ id: 'u1', email: 'a@b.com', name: 'A', role: 'SEEKER', status: 'ACTIVE', email_verified: true, scans_today: 1, scans_day_reset: 't', created_at: 't', terms_accepted_at: 't0', terms_version: '2026-09' }], error: null, count: 1 }
      : undefined))
    const res = await t.mod.adminListUsers(t.c())
    expect(res.body.data[0]).toMatchObject({ termsAcceptedAt: 't0', termsVersion: '2026-09' })
  })
})

describe('adminGetUserDetail', () => {
  it('404s for an unknown user before querying scans/payments', async () => {
    t = setup(q => (q.table === 'users' ? { data: null, error: null } : undefined))
    const res = await t.mod.adminGetUserDetail(t.c())
    expect(res.status).toBe(404)
    expect(t.db.calls.some(c => c.table === 'scans' || c.table === 'payments')).toBe(false)
  })

  it('returns the user plus their recent scans and payments, mapped to camelCase', async () => {
    t = setup(q => {
      if (q.table === 'users') return { data: { id: 'u1', email: 'a@b.com', name: 'A', role: 'SEEKER', status: 'ACTIVE', email_verified: true, scans_today: 0, scans_day_reset: 't', created_at: 't', terms_accepted_at: 't0', terms_version: '2026-09' }, error: null }
      if (q.table === 'scans') return { data: [{ id: 's1', status: 'DONE', ats_score: 80, fix_purchased: true, fix_tier: 'FIX', resume_original_name: 'r.pdf', created_at: 't' }], error: null }
      if (q.table === 'payments') return { data: [{ id: 'p1', amount_cents: 4900, currency: 'USD', status: 'SUCCESS', fix_tier: 'FIX', referral_code: null, created_at: 't' }], error: null }
    })
    const res = await t.mod.adminGetUserDetail(t.c())
    expect(res.body.data.scans[0]).toMatchObject({ id: 's1', atsScore: 80, fixPurchased: true })
    expect(res.body.data.payments[0]).toMatchObject({ id: 'p1', amountCents: 4900 })
    expect(res.body.data).toMatchObject({ termsAcceptedAt: 't0', termsVersion: '2026-09' })
  })
})

describe('adminUpdateUser', () => {
  it('rejects an empty body', async () => {
    t = setup(() => undefined)
    await expect(t.mod.adminUpdateUser(t.c({ body: {} }))).rejects.toThrow()
  })

  it("blocks an admin from banning their own account", async () => {
    t = setup(() => undefined)
    const res = await t.mod.adminUpdateUser(t.c({ param: 'admin-1', actingUser: { id: 'admin-1' }, body: { status: 'BANNED' } }))
    expect(res.status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
  })

  it('blocks an admin from demoting themselves to SEEKER', async () => {
    t = setup(() => undefined)
    const res = await t.mod.adminUpdateUser(t.c({ param: 'admin-1', actingUser: { id: 'admin-1' }, body: { role: 'SEEKER' } }))
    expect(res.status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
  })

  it('allows banning a DIFFERENT user', async () => {
    let patch = null
    t = setup(q => {
      if (q.table === 'users' && q.op === 'update') { patch = q.patch; return { data: { id: 'u2', email: 'x@y.com', name: 'X', role: 'SEEKER', status: 'BANNED', scans_today: 0, scans_day_reset: 't' }, error: null } }
    })
    const res = await t.mod.adminUpdateUser(t.c({ param: 'u2', actingUser: { id: 'admin-1' }, body: { status: 'BANNED' } }))
    expect(res.body.success).toBe(true)
    expect(patch).toEqual({ status: 'BANNED' })
  })

  it('resetScansToday zeroes scans_today and stamps scans_day_reset', async () => {
    let patch = null
    t = setup(q => {
      if (q.table === 'users' && q.op === 'update') { patch = q.patch; return { data: { id: 'u2' }, error: null } }
    })
    await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { resetScansToday: true } }))
    expect(patch.scans_today).toBe(0)
    expect(typeof patch.scans_day_reset).toBe('string')
  })

  it('404s when the target user does not exist', async () => {
    t = setup(q => (q.op === 'update' ? { data: null, error: null } : undefined))
    const res = await t.mod.adminUpdateUser(t.c({ param: 'nope', body: { status: 'BANNED' } }))
    expect(res.status).toBe(404)
  })
})

describe('adminListScans', () => {
  it('maps rows (including the joined user email) to camelCase, with an optional status filter', async () => {
    t = setup(q => (q.table === 'scans'
      ? { data: [{ id: 's1', status: 'ERROR', ats_score: null, fix_purchased: false, fix_tier: null, resume_original_name: 'r.pdf', user_id: 'u1', users: { email: 'a@b.com' }, verification_code: null, verification_status: null, verification_revoked_reason: null, created_at: 't', updated_at: 't' }], error: null, count: 1 }
      : undefined))
    const res = await t.mod.adminListScans(t.c({ query: { status: 'ERROR' } }))
    expect(res.body.data[0]).toMatchObject({ id: 's1', userEmail: 'a@b.com' })
    const call = t.db.calls.find(c => c.table === 'scans')
    expect(call.filters.find(f => f[1] === 'status')[2]).toBe('ERROR')
  })

  it('userEmail is null (not a crash) when the join has no user row', async () => {
    t = setup(q => (q.table === 'scans'
      ? { data: [{ id: 's1', status: 'ERROR', users: null, created_at: 't', updated_at: 't' }], error: null, count: 1 }
      : undefined))
    const res = await t.mod.adminListScans(t.c())
    expect(res.body.data[0].userEmail).toBe(null)
  })
})

describe('adminSetVerification', () => {
  it('404s for an unknown scan', async () => {
    t = setup(q => (q.table === 'scans' && q.op === 'select' ? { data: null, error: null } : undefined))
    const res = await t.mod.adminSetVerification(t.c({ body: { action: 'revoke' } }))
    expect(res.status).toBe(404)
  })

  it('400s when the scan has no verification page at all', async () => {
    t = setup(q => (q.table === 'scans' && q.op === 'select' ? { data: { id: 's1', verification_code: null }, error: null } : undefined))
    const res = await t.mod.adminSetVerification(t.c({ body: { action: 'revoke' } }))
    expect(res.status).toBe(400)
  })

  it('revoke: marks the row REVOKED regardless of current status (admin overrides an owner unpublish)', async () => {
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', verification_code: 'ABC123' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1' }], error: null }
    })
    const res = await t.mod.adminSetVerification(t.c({ body: { action: 'revoke' } }))
    expect(res.body.data).toEqual({ changed: true, verificationStatus: 'REVOKED' })
    const updateCall = t.db.calls.find(c => c.table === 'scans' && c.op === 'update')
    expect(updateCall.patch.verification_revoked_reason).toBe('ADMIN')
    // Unlike an owner-initiated revoke, this must NOT be scoped to
    // verification_status === ACTIVE — an admin takedown works regardless.
    expect(updateCall.filters.find(f => f[1] === 'verification_status')).toBeUndefined()
  })

  it('restore: lifts ANY revocation reason (asAdmin), not just the owner\'s own', async () => {
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', verification_code: 'ABC123' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1' }], error: null }
    })
    const res = await t.mod.adminSetVerification(t.c({ body: { action: 'restore' } }))
    expect(res.body.data).toEqual({ changed: true, verificationStatus: 'ACTIVE' })
    const updateCall = t.db.calls.find(c => c.table === 'scans' && c.op === 'update')
    expect(updateCall.filters.find(f => f[1] === 'verification_revoked_reason')).toBeUndefined()
  })

  it('rejects an invalid action', async () => {
    t = setup(() => undefined)
    await expect(t.mod.adminSetVerification(t.c({ body: { action: 'delete' } }))).rejects.toThrow()
  })
})

describe('adminListPayments', () => {
  it('maps rows with the joined user email and pagination', async () => {
    t = setup(q => (q.table === 'payments'
      ? { data: [{ id: 'p1', amount_cents: 4900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'r1', fix_tier: 'FIX', referral_code: null, scan_id: 's1', user_id: 'u1', users: { email: 'a@b.com' }, created_at: 't' }], error: null, count: 1 }
      : undefined))
    const res = await t.mod.adminListPayments(t.c({ query: { status: 'SUCCESS' } }))
    expect(res.body.data[0]).toMatchObject({ id: 'p1', amountCents: 4900, userEmail: 'a@b.com' })
  })
})

describe('adminListEmailLogs', () => {
  it('filters by status, template and a search term (against the "to" column)', async () => {
    t = setup(q => (q.table === 'email_logs' ? { data: [], error: null, count: 0 } : undefined))
    await t.mod.adminListEmailLogs(t.c({ query: { status: 'FAILED', template: 'welcome', search: 'jane' } }))
    const call = t.db.calls.find(c => c.table === 'email_logs')
    expect(call.filters.find(f => f[1] === 'status')[2]).toBe('FAILED')
    expect(call.filters.find(f => f[1] === 'template')[2]).toBe('welcome')
    expect(call.filters.find(f => f[0] === 'ilike' && f[1] === 'to')[2]).toBe('%jane%')
  })
})

describe('adminListAlerts', () => {
  it('returns paginated alert rows mapped to camelCase', async () => {
    t = setup(q => (q.table === 'alert_logs'
      ? { data: [{ id: 'a1', subject: 'S', message: 'M', emailed: true, created_at: 't' }], error: null, count: 1 }
      : undefined))
    const res = await t.mod.adminListAlerts(t.c())
    expect(res.body.data[0]).toEqual({ id: 'a1', subject: 'S', message: 'M', emailed: true, createdAt: 't' })
  })
})

// ── Round 3 ────────────────────────────────────────────────────────────────
describe('round 3 — dashboard counts webhook events that need a person', () => {
  it('adds FAILED+HELD and stuck-RECEIVED events to openItems.webhookEventsNeedingAttention', async () => {
    t = setup(q => {
      if (q.table === 'webhook_events') return { data: null, error: null, count: q.filters.some(f => f[0] === 'in') ? 3 : 2 }
      if (q.op === 'select' && q.selectOpts?.head) return { data: null, error: null, count: 0 }
    })
    const res = await t.mod.adminDashboardStats(t.c())
    expect(res.body.data.openItems.webhookEventsNeedingAttention).toBe(5)
  })
})

describe('round 3 — adminBackfillPdfHashes (pages issued before PDF fingerprinting)', () => {
  const PDF = new TextEncoder().encode('pdf bytes')
  const bucket = files => ({ get: async k => files[k] ? { arrayBuffer: async () => files[k].buffer.slice(files[k].byteOffset, files[k].byteOffset + files[k].byteLength) } : null })

  it('fingerprints the stored PDF for a page that has none, and skips a missing object', async () => {
    const updates = []
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: [{ id: 's1', resume_pdf_path: 'a.pdf' }, { id: 's2', resume_pdf_path: 'gone.pdf' }], error: null }
      if (q.table === 'scans' && q.op === 'update') { updates.push(q); return { data: [{ id: 's1' }], error: null } }
    })
    const res = await t.mod.adminBackfillPdfHashes(t.c({ env: { RESUMES_BUCKET: bucket({ 'a.pdf': PDF }) } }))
    expect(res.body.data).toMatchObject({ checked: 2, filled: 1, missing: 1, remaining: false })
    expect(updates).toHaveLength(1)
    expect(updates[0].patch.resume_pdf_hash).toMatch(/^[a-f0-9]{64}$/)
    // only ever fills a HOLE — never overwrites an existing fingerprint
    expect(updates[0].filters.some(f => f[0] === 'is' && f[1] === 'resume_pdf_hash')).toBe(true)
  })
})

// SECTION 12 AUDIT (feature gap): adminUpdateUser is this file's one
// moderation action (ban / role / quota reset) and left no trace of which
// admin did it. It now logs to admin_audit_log — but only when something
// actually changed, and never with anything beyond status/role values.
describe('adminUpdateUser — audit trail', () => {
  function auditSetup({ before, after, auditError } = {}) {
    const audits = []
    const s = setup(q => {
      if (q.table === 'users' && q.op === 'select') return { data: before ?? null, error: null }
      if (q.table === 'users' && q.op === 'update') return { data: after ?? { id: 'u2' }, error: null }
      if (q.table === 'admin_audit_log' && q.op === 'insert') { audits.push(q.values); return { data: null, error: auditError ?? null } }
      return undefined
    })
    return { ...s, audits }
  }

  it('logs a ban with the from/to status and the acting admin', async () => {
    t = auditSetup({ before: { status: 'ACTIVE', role: 'SEEKER' }, after: { id: 'u2', status: 'BANNED', role: 'SEEKER' } })
    await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { status: 'BANNED' } }))
    expect(t.audits).toEqual([{
      actor_id: 'admin-1', action: 'user.update', target_type: 'user', target_id: 'u2',
      detail: { statusFrom: 'ACTIVE', statusTo: 'BANNED' },
    }])
  })
  it('logs a role change, and a combined status+role+reset change in ONE entry', async () => {
    t = auditSetup({ before: { status: 'BANNED', role: 'SEEKER' }, after: { id: 'u2', status: 'ACTIVE', role: 'ADMIN' } })
    await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { status: 'ACTIVE', role: 'ADMIN', resetScansToday: true } }))
    expect(t.audits).toHaveLength(1)
    expect(t.audits[0].detail).toEqual({ statusFrom: 'BANNED', statusTo: 'ACTIVE', roleFrom: 'SEEKER', roleTo: 'ADMIN', scansReset: true })
  })
  it('a quota reset alone logs scansReset only', async () => {
    t = auditSetup({ before: { status: 'ACTIVE', role: 'SEEKER' }, after: { id: 'u2', status: 'ACTIVE', role: 'SEEKER' } })
    await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { resetScansToday: true } }))
    expect(t.audits[0].detail).toEqual({ scansReset: true })
  })
  it('a no-op PATCH (same status/role resubmitted) logs nothing', async () => {
    t = auditSetup({ before: { status: 'BANNED', role: 'SEEKER' }, after: { id: 'u2', status: 'BANNED', role: 'SEEKER' } })
    await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { status: 'BANNED', role: 'SEEKER' } }))
    expect(t.audits).toHaveLength(0)
  })
  it('does not crash when the before-read finds no row (before = null) — logs from: null', async () => {
    t = auditSetup({ before: null, after: { id: 'u2', status: 'BANNED', role: 'SEEKER' } })
    const res = await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { status: 'BANNED' } }))
    expect(res.body.success).toBe(true)
    expect(t.audits[0].detail).toEqual({ statusFrom: null, statusTo: 'BANNED' })
  })
  it('a 404 (user does not exist) and a refused self-ban log nothing', async () => {
    t = auditSetup({ before: null })
    t.db.calls.length = 0
    await t.mod.adminUpdateUser(t.c({ param: 'admin-1', actingUser: { id: 'admin-1' }, body: { status: 'BANNED' } }))
    expect(t.audits).toHaveLength(0)
    t.restore()
    t = setup(q => (q.op === 'update' ? { data: null, error: null } : undefined))
    const res = await t.mod.adminUpdateUser(t.c({ param: 'nope', body: { status: 'BANNED' } }))
    expect(res.status).toBe(404)
    expect(t.db.calls.some(c => c.table === 'admin_audit_log')).toBe(false)
  })
  it('a failed audit write never fails the moderation action itself', async () => {
    const realErr = console.error; console.error = () => {}
    try {
      t = auditSetup({ before: { status: 'ACTIVE', role: 'SEEKER' }, after: { id: 'u2', status: 'BANNED', role: 'SEEKER' }, auditError: { message: 'audit down' } })
      const res = await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { status: 'BANNED' } }))
      expect(res.body.success).toBe(true)
    } finally { console.error = realErr }
  })
})

describe('adminListAuditLog', () => {
  const row = (over = {}) => ({ id: 'a1', action: 'user.update', target_type: 'user', target_id: 'u2', detail: { statusTo: 'BANNED' }, created_at: 't1', users: { email: 'boss@x.co' }, ...over })

  it('maps rows to camelCase, newest-first, with the joined actor email and pagination meta', async () => {
    t = setup(q => (q.table === 'admin_audit_log' ? { data: [row()], error: null, count: 41 } : undefined))
    const res = await t.mod.adminListAuditLog(t.c({ query: { page: '2', pageSize: '20' } }))
    expect(res.body.data[0]).toEqual({ id: 'a1', action: 'user.update', targetType: 'user', targetId: 'u2', detail: { statusTo: 'BANNED' }, actorEmail: 'boss@x.co', createdAt: 't1' })
    expect(res.body.meta).toEqual({ page: 2, pageSize: 20, total: 41 })
    const call = t.db.calls.find(c => c.table === 'admin_audit_log')
    expect(call.range).toEqual([20, 39])
    expect(call.orders[0]).toEqual(['created_at', { ascending: false }])
  })
  it('applies the targetType and action filters only when given', async () => {
    t = setup(q => (q.table === 'admin_audit_log' ? { data: [], error: null, count: 0 } : undefined))
    await t.mod.adminListAuditLog(t.c({ query: {} }))
    expect(t.db.calls.find(c => c.table === 'admin_audit_log').filters).toHaveLength(0)
    t.restore()
    t = setup(q => (q.table === 'admin_audit_log' ? { data: [], error: null, count: 0 } : undefined))
    await t.mod.adminListAuditLog(t.c({ query: { targetType: 'payment', action: 'payment.reversed' } }))
    const f = t.db.calls.find(c => c.table === 'admin_audit_log').filters
    expect(f.find(x => x[1] === 'target_type')[2]).toBe('payment')
    expect(f.find(x => x[1] === 'action')[2]).toBe('payment.reversed')
  })
  it('actorEmail is null (not a crash) when the actor row is gone; detail defaults to {}', async () => {
    t = setup(q => (q.table === 'admin_audit_log' ? { data: [row({ users: null, detail: null })], error: null, count: 1 } : undefined))
    const res = await t.mod.adminListAuditLog(t.c())
    expect(res.body.data[0]).toMatchObject({ actorEmail: null, detail: {} })
  })
  it('propagates a database error', async () => {
    t = setup(q => (q.table === 'admin_audit_log' ? { data: null, error: new Error('db down') } : undefined))
    await expect(t.mod.adminListAuditLog(t.c())).rejects.toThrow('db down')
  })
})

// ── Webhooks round 5 ──────────────────────────────────────────────────────
describe('round 5 — partial refunds are visible and netted out of revenue', () => {
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  it('subtracts what payment_refunds holds from the bucket of the payment it belongs to', async () => {
    t = setup(q => {
      if (q.table === 'payments' && q.cols?.includes('amount_cents'))
        return { data: [{ id: 'p1', amount_cents: 4900, created_at: today }, { id: 'p2', amount_cents: 2900, created_at: today }], error: null }
      if (q.table === 'payment_refunds') return { data: [{ payment_id: 'p1', amount_cents: 1500 }, { payment_id: 'p1', amount_cents: 500 }], error: null }
      if (q.table === 'commission_ledger' || q.table === 'alert_logs') return { data: [], error: null }
      return { data: [], error: null, count: 0 }
    })
    const res = await t.mod.adminDashboardStats(t.c())
    expect(res.body.data.revenue).toMatchObject({ todayCents: 4900 - 2000 + 2900, weekCents: 4900 - 2000 + 2900, monthCents: 4900 - 2000 + 2900, monthPartialRefundsCents: 2000 })
    const call = t.db.calls.find(c => c.table === 'payment_refunds')
    expect(call.cols).toMatch(/payments!inner/)
    expect(call.filters.find(f => f[0] === 'eq' && f[1] === 'payments.status')[2]).toBe('SUCCESS')
  })
  it('never lets a payment go negative, and falls back to gross revenue when the table cannot be read', async () => {
    t = setup(q => {
      if (q.table === 'payments' && q.cols?.includes('amount_cents')) return { data: [{ id: 'p1', amount_cents: 1000, created_at: today }], error: null }
      if (q.table === 'payment_refunds') return { data: [{ payment_id: 'p1', amount_cents: 5000 }], error: null }
      return { data: [], error: null, count: 0 }
    })
    expect((await t.mod.adminDashboardStats(t.c())).body.data.revenue.todayCents).toBe(0)
    t.restore()
    t = setup(q => {
      if (q.table === 'payments' && q.cols?.includes('amount_cents')) return { data: [{ id: 'p1', amount_cents: 1000, created_at: today }], error: null }
      if (q.table === 'payment_refunds') return { data: null, error: { code: '42P01', message: 'relation does not exist' } }
      return { data: [], error: null, count: 0 }
    })
    expect((await t.mod.adminDashboardStats(t.c())).body.data.revenue.todayCents).toBe(1000)
  })
  it('the dashboard carries the webhook health block', async () => {
    t = setup(() => ({ data: [], error: null, count: 0 }))
    const res = await t.mod.adminDashboardStats(t.c())
    expect(res.body.data.webhookHealth).toMatchObject({ available: true, paidWithoutEvent: 0 })
  })
  it('the payments list shows what has been refunded so far and filters by reference', async () => {
    t = setup(q => {
      if (q.table === 'payments') return { data: [{ id: 'p1', amount_cents: 4900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'r1', users: { email: 'a@b.com' }, created_at: 't' }, { id: 'p2', amount_cents: 100, currency: 'USD', status: 'SUCCESS', paystack_ref: 'r2', users: null, created_at: 't' }], error: null, count: 2 }
      if (q.table === 'payment_refunds') return { data: [{ payment_id: 'p1', amount_cents: 1200 }], error: null }
    })
    const res = await t.mod.adminListPayments(t.c({ query: { reference: 'r1,(x)' } }))
    expect(res.body.data.map(p => p.refundedCents)).toEqual([1200, 0])
    const call = t.db.calls.find(c => c.table === 'payments')
    expect(call.filters.find(f => f[0] === 'ilike' && f[1] === 'paystack_ref')[2]).toBe('%r1x%')
  })
})
