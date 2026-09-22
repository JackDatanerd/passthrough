import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { runRetention, purgeExpiredAnonScans, purgeOldLogs, clearExpiredTokens } from '../src/services/retention.service.js'
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
    expect(Object.keys(r).sort()).toEqual(['anon', 'logs', 'tokens'])
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
