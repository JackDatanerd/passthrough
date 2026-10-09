import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { runRetention, purgeRejectedPartnerApplications, REJECTED_APPLICATION_RETENTION_DAYS, purgeExpiredAnonScans, purgeOldLogs, clearExpiredTokens, purgeArchivedLeads, purgeStaleUnconfirmedLeads, ARCHIVED_LEAD_RETENTION_DAYS, UNCONFIRMED_LEAD_RETENTION_DAYS } from '../src/services/retention.service.js'
import { handleDeadLetterBatch } from '../src/services/deadletter.service.js'

const NOW = Date.parse('2026-09-21T12:00:00Z')
const DAY = 86400000
let realErr; beforeEach(() => { realErr = console.error; console.error = () => {} }); afterEach(() => { console.error = realErr })

describe('purgeExpiredAnonScans', () => {
  const setup = (rows, { deleteError = null, r2Fail = new Set() } = {}) => {
    const deleted = []
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: rows, error: null }
      if (q.table === 'scans' && q.op === 'delete') { deleted.push(q.filters.find(f => f[0] === 'in')[2]); return { error: deleteError } }
    })
    const r2 = []
    const env = { RESUMES_BUCKET: { delete: async k => { if (r2Fail.has(k)) throw new Error('r2 down'); r2.push(k) } } }
    return { db, env, deleted, r2 }
  }
  it('compares against anon_expires_at ITSELF — not "now minus 24h" (which kept 24h scans for 48h)', async () => {
    const s = setup([])
    await purgeExpiredAnonScans(s.env, s.db, NOW)
    const q = s.db.calls[0]
    const lt = q.filters.find(f => f[0] === 'lt' && f[1] === 'anon_expires_at')
    expect(lt[2]).toBe(new Date(NOW).toISOString())
    expect(q.filters.find(f => f[0] === 'is' && f[1] === 'user_id')[2]).toBeNull()
  })
  it('deletes the R2 file and the row', async () => {
    const s = setup([{ id: 'a', resume_path: 'resumes/a.pdf' }, { id: 'b', resume_path: null }])
    expect(await purgeExpiredAnonScans(s.env, s.db, NOW)).toEqual({ deleted: 2 })
    expect(s.r2).toEqual(['resumes/a.pdf']); expect(s.deleted).toEqual([['a', 'b']])
  })
  it('KEEPS a row whose file could not be deleted, so the next run retries instead of orphaning the file', async () => {
    const s = setup([{ id: 'a', resume_path: 'bad' }, { id: 'b', resume_path: 'ok' }], { r2Fail: new Set(['bad']) })
    expect(await purgeExpiredAnonScans(s.env, s.db, NOW)).toEqual({ deleted: 1 })
    expect(s.deleted).toEqual([['b']])
  })
  it('reports errors instead of throwing', async () => {
    const s = setup([{ id: 'a', resume_path: null }], { deleteError: new Error('db') })
    expect((await purgeExpiredAnonScans(s.env, s.db, NOW)).error).toBe('db')
  })
})

describe('purgeOldLogs / clearExpiredTokens', () => {
  it('purges email_logs older than 90 days and alert_logs older than 180', async () => {
    const db = createFakeSupabase(q => ({ data: [{ id: 1 }, { id: 2 }], error: null }))
    const r = await purgeOldLogs(db, NOW)
    expect(r).toMatchObject({ emailLogs: 2, alertLogs: 2 })
    const cut = t => db.calls.find(c => c.table === t).filters.find(f => f[0] === 'lt')[2]
    expect(cut('email_logs')).toBe(new Date(NOW - 90 * DAY).toISOString())
    expect(cut('alert_logs')).toBe(new Date(NOW - 180 * DAY).toISOString())
  })
  it('one failing purge does not stop the other', async () => {
    const db = createFakeSupabase(q => q.table === 'email_logs' ? { data: null, error: new Error('x') } : { data: [{ id: 1 }], error: null })
    const r = await purgeOldLogs(db, NOW)
    expect(r.alertLogs).toBe(1); expect(r.errors).toHaveLength(1)
  })
  it('clears reset and verification tokens that are past expiry', async () => {
    const db = createFakeSupabase(() => ({ data: [{ id: 'u' }], error: null }))
    const r = await clearExpiredTokens(db, NOW)
    expect(r).toMatchObject({ resetTokens: 1, verifyTokens: 1 })
    const patches = db.calls.map(c => c.patch)
    expect(patches).toContainEqual({ reset_token: null, reset_token_expiry: null })
    expect(patches).toContainEqual({ email_verify_token: null, email_verify_expiry: null })
  })
  it('runRetention runs every step and never throws', async () => {
    const db = createFakeSupabase(() => ({ data: [], error: null }))
    const r = await runRetention({ RESUMES_BUCKET: { delete: async () => {} } }, db, NOW)
    expect(Object.keys(r).sort()).toEqual(['anon', 'applications', 'leads', 'logs', 'staleLeads', 'tokens'])
  })
})

describe('purgeArchivedLeads', () => {
  it('deletes only ARCHIVED leads untouched for the retention window', async () => {
    const db = createFakeSupabase(() => ({ data: [{ id: 'l1' }, { id: 'l2' }], error: null }))
    const r = await purgeArchivedLeads(db, NOW)
    expect(r).toEqual({ deleted: 2 })
    const q = db.calls[0]
    expect(q.table).toBe('employer_leads')
    expect(q.op).toBe('delete')
    expect(eqValue(q, 'status')).toBe('ARCHIVED')
    expect(q.filters.find(f => f[0] === 'lt' && f[1] === 'updated_at')[2])
      .toBe(new Date(NOW - ARCHIVED_LEAD_RETENTION_DAYS * DAY).toISOString())
    expect(ARCHIVED_LEAD_RETENTION_DAYS).toBe(90)
  })
  it('reports a failure instead of throwing', async () => {
    const db = createFakeSupabase(() => ({ error: { message: 'db down' } }))
    expect(await purgeArchivedLeads(db, NOW)).toEqual({ deleted: 0, error: 'db down' })
  })
})

// Independent audit round 8 (Section 5): with ARCHIVED_LEAD_PURGE_SUPPRESSES on, a purged lead's
// address goes onto the do-not-contact list instead of being forgotten.
describe('purgeArchivedLeads — suppress option', () => {
  const resolver = (state) => (q) => {
    state.ops.push(`${q.table}:${q.op}`)
    if (q.table === 'employer_leads') return { data: [{ id: 'l1', email: 'a@x.com' }, { id: 'l2', email: 'a@x.com' }, { id: 'l3', email: 'b@x.com' }], error: null }
    if (q.table === 'employer_lead_suppressions') { state.hashes = q.values; return { data: null, error: state.supErr || null } }
    if (q.table === 'email_logs') { state.logFilters = q.filters; return { data: null, error: null } }
  }
  it('is off by default: nothing but the delete, and only ids are read back', async () => {
    const state = { ops: [] }
    const db = createFakeSupabase(resolver(state))
    expect(await purgeArchivedLeads(db, NOW)).toEqual({ deleted: 3 })
    expect(state.ops).toEqual(['employer_leads:delete'])
    expect(db.calls[0].cols).toBe('id')
  })
  it('on: records each distinct address once as a hash and clears its employer mail history', async () => {
    const state = { ops: [] }
    const db = createFakeSupabase(resolver(state))
    const r = await purgeArchivedLeads(db, NOW, { suppress: true })
    expect(r).toEqual({ deleted: 3, suppressed: 2 })
    expect(state.hashes).toHaveLength(2)
    expect(state.hashes.every(h => /^[0-9a-f]{64}$/.test(h.email_hash))).toBe(true)
    expect(JSON.stringify(state.hashes)).not.toContain('@')
    expect(state.logFilters.find(f => f[1] === 'to')[2].sort()).toEqual(['a@x.com', 'b@x.com'])
    expect(state.logFilters.find(f => f[1] === 'template')[2]).toEqual(['employer_lead_ack', 'employer_candidates_available'])
  })
  it('reports (does not throw) when the list write fails, and leaves the mail history alone', async () => {
    const state = { ops: [], supErr: { message: 'nope' } }
    const db = createFakeSupabase(resolver(state))
    const r = await purgeArchivedLeads(db, NOW, { suppress: true })
    expect(r.error).toMatch(/suppression: nope/)
    expect(state.ops).not.toContain('email_logs:delete')
  })
  it('runRetention turns it on only for ARCHIVED_LEAD_PURGE_SUPPRESSES=true', async () => {
    for (const [flag, expected] of [[undefined, false], ['false', false], ['true', true], ['TRUE', true]]) {
      const state = { ops: [] }
      const db = createFakeSupabase(resolver(state))
      await runRetention({ RESUMES_BUCKET: { delete: async () => {} }, ARCHIVED_LEAD_PURGE_SUPPRESSES: flag }, db, NOW)
      expect(state.ops.includes('employer_lead_suppressions:upsert')).toBe(expected)
    }
  })
})

describe('purgeStaleUnconfirmedLeads', () => {
  it('deletes only NEW, never-confirmed, note-less leads not resubmitted within the window', async () => {
    const db = createFakeSupabase(() => ({ data: [{ id: 'l1' }], error: null }))
    const r = await purgeStaleUnconfirmedLeads(db, NOW)
    expect(r).toEqual({ deleted: 1 })
    const q = db.calls[0]
    expect(q.table).toBe('employer_leads')
    expect(q.op).toBe('delete')
    expect(eqValue(q, 'status')).toBe('NEW')
    expect(q.filters).toContainEqual(['is', 'confirmed_at', null])
    expect(q.filters).toContainEqual(['is', 'notes', null])
    expect(q.filters.find(f => f[0] === 'lt' && f[1] === 'last_submitted_at')[2])
      .toBe(new Date(NOW - UNCONFIRMED_LEAD_RETENTION_DAYS * DAY).toISOString())
    expect(UNCONFIRMED_LEAD_RETENTION_DAYS).toBe(90)
  })
  it('reports a failure instead of throwing', async () => {
    const db = createFakeSupabase(() => ({ error: { message: 'db down' } }))
    expect(await purgeStaleUnconfirmedLeads(db, NOW)).toEqual({ deleted: 0, error: 'db down' })
  })
  it('never removes a lead that was not asked to confirm: needs an acknowledgement, exhausted sweep retries, or great age', async () => {
    const db = createFakeSupabase(() => ({ data: [], error: null }))
    await purgeStaleUnconfirmedLeads(db, NOW)
    const expr = db.calls[0].or[0]
    expect(expr).toContain('last_ack_at.not.is.null')
    expect(expr).toContain('ack_attempts.gte.5')
    expect(expr).toContain(`created_at.lt.${new Date(NOW - 2 * UNCONFIRMED_LEAD_RETENTION_DAYS * DAY).toISOString()}`)
  })
})

describe('handleDeadLetterBatch', () => {
  const msg = (body, extra = {}) => { const m = { id: 'm1', attempts: 4, body, acked: false, ack() { this.acked = true }, ...extra }; return m }
  it('marks a still-generating scan ERROR, alerts the owner, and acks', async () => {
    const db = createFakeSupabase(() => ({ error: null }))
    const alerts = []; const m = msg({ type: 'generateFix', scanId: 's1' })
    await handleDeadLetterBatch({ messages: [m] }, {}, db, { sendOwnerAlert: async (e, s, b) => { alerts.push({ s, b }) } })
    const upd = db.calls.find(c => c.op === 'update')
    expect(upd.patch).toEqual({ status: 'ERROR' })
    expect(eqValue(upd, 'id')).toBe('s1')
    expect(upd.filters.find(f => f[0] === 'in' && f[1] === 'status')[2]).toEqual(['FIX_PURCHASED', 'FIX_GENERATING'])   // never clobbers a delivered scan
    expect(alerts[0].s).toContain('generateFix'); expect(alerts[0].b).toContain('s1'); expect(alerts[0].b).toContain('requeue-fix')
    expect(m.acked).toBe(true)
  })
  it('acks even when the DB write and the alert both fail — a poison message must never wedge the DLQ', async () => {
    const db = createFakeSupabase(() => ({ error: new Error('db down') }))
    const m = msg({ type: 'generateBadge', scanId: 's2' })
    await handleDeadLetterBatch({ messages: [m] }, {}, db, { sendOwnerAlert: async () => { throw new Error('mail down') } })
    expect(m.acked).toBe(true)
  })
  it('handles a malformed body and processes every message in the batch', async () => {
    const db = createFakeSupabase(() => ({ error: null }))
    const ms = [msg(undefined), msg({ type: 'x' }), msg({ scanId: 's3' })]
    await handleDeadLetterBatch({ messages: ms }, {}, db, { sendOwnerAlert: async () => {} })
    expect(ms.every(m => m.acked)).toBe(true)
  })
})

describe('purgeRejectedPartnerApplications (Section 4 round 7)', () => {
  it('deletes only REJECTED applications reviewed before the retention window, and counts them', async () => {
    const db = createFakeSupabase(() => ({ data: [{ id: 'a1' }, { id: 'a2' }], error: null }))
    const r = await purgeRejectedPartnerApplications(db, NOW)
    expect(r).toEqual({ deleted: 2 })
    const q = db.calls[0]
    expect(q.table).toBe('partner_applications')
    expect(q.op).toBe('delete')
    expect(q.filters).toContainEqual(['eq', 'status', 'REJECTED'])
    const lt = q.filters.find(f => f[0] === 'lt' && f[1] === 'reviewed_at')
    expect(new Date(lt[2]).getTime()).toBe(NOW - REJECTED_APPLICATION_RETENTION_DAYS * 24 * 3600 * 1000)
  })
  it('keeps rows longer than the 30-day re-apply cooldown, so the cooldown can still be enforced', () => {
    expect(REJECTED_APPLICATION_RETENTION_DAYS).toBeGreaterThan(30)
  })
  it('reports a failure instead of throwing', async () => {
    const db = createFakeSupabase(() => ({ data: null, error: { message: 'boom' } }))
    expect(await purgeRejectedPartnerApplications(db, NOW)).toEqual({ deleted: 0, error: 'boom' })
  })
})
