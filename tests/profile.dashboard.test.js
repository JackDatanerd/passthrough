import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import resumeData from '../src/lib/resumeData.js'

// Profile & Dashboard (Section 6), audit round 5: quota summary, profile read/edit, notification
// preference, batched scan-history deletion, the fuller export, and the stricter saveProfile.

const { hasResumeContent, parseClientResumeData, dropBlankEntries, MAX_RESUME_DATA_JSON_CHARS } = resumeData
const SCAN_ID = '11111111-1111-1111-1111-111111111111'

function setup(resolver, { tombstones = [], bucket } = {}) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/verification.js': { recordTombstones: async (_db, rows) => { tombstones.push(...rows) } },
  })
  const c = (over = {}) => ({
    env: { RESUMES_BUCKET: bucket },
    get: () => ({ id: over.userId ?? 'u1' }),
    req: { json: async () => { if (over.badJson) throw new Error('bad'); return over.body ?? {} }, query: k => over.query?.[k] },
    json: (body, status = 200) => ({ body, status }),
    body: (raw, status = 200, headers = {}) => ({ raw, status, headers }),
  })
  return { mod, restore, c, db }
}
let t
afterEach(() => t?.restore())

describe('lib/resumeData — what a client may hand the server as a resume', () => {
  it('hasResumeContent: a name or contact line alone is not a background', () => {
    expect(hasResumeContent({ name: 'Jane', email: 'j@x.com', phone: '1' })).toBe(false)
    expect(hasResumeContent(null)).toBe(false)
    expect(hasResumeContent({ skills: ['  ', ''] })).toBe(false)
    expect(hasResumeContent({ experience: [{ title: '', company: ' ', bullets: ['', ' '] }] })).toBe(false)
  })
  it('hasResumeContent: any one real job, school, skill, project or summary counts', () => {
    expect(hasResumeContent({ experience: [{ title: 'Engineer' }] })).toBe(true)
    expect(hasResumeContent({ experience: [{ bullets: ['Shipped x'] }] })).toBe(true)
    expect(hasResumeContent({ education: [{ degree: 'BSc' }] })).toBe(true)
    expect(hasResumeContent({ skills: ['SQL'] })).toBe(true)
    expect(hasResumeContent({ projects: [{ name: 'p' }] })).toBe(true)
    expect(hasResumeContent({ summary: 'Ten years in ops.' })).toBe(true)
  })
  it('parseClientResumeData: caps size, checks shape, drops blank lines', () => {
    expect(parseClientResumeData('nope').ok).toBe(false)
    expect(parseClientResumeData({ experience: 'x' }).ok).toBe(false)
    expect(parseClientResumeData({ summary: 'x'.repeat(MAX_RESUME_DATA_JSON_CHARS) })).toEqual({ ok: false, message: 'Resume data is too large.' })
    const ok = parseClientResumeData({ skills: ['a', ' ', ''], experience: [{ title: 'T', bullets: ['b', ''] }], extra: 1 })
    expect(ok.ok).toBe(true)
    expect(ok.data.skills).toEqual(['a'])
    expect(ok.data.experience[0].bullets).toEqual(['b'])
    expect(ok.data.extra).toBe(1)   // passthrough: the schema catches malformed bodies, it does not police every field
  })
  it('dropBlankEntries leaves non-array fields alone', () => {
    expect(dropBlankEntries({ name: 'J' })).toMatchObject({ name: 'J', skills: undefined })
  })
})

describe('scanQuota — the free-scan allowance the dashboard shows', () => {
  const now = new Date('2026-10-05T10:30:00Z')
  it('counts today\'s scans against the limit and says when it resets (next UTC midnight)', () => {
    t = setup()
    expect(t.mod.scanQuota({ scans_today: 2, scans_day_reset: '2026-10-05T01:00:00Z' }, now))
      .toEqual({ limit: 3, used: 2, remaining: 1, resetsAt: '2026-10-06T00:00:00.000Z' })
  })
  it('a counter last touched before today\'s midnight is a stale day: zero used, like the increment RPC treats it', () => {
    t = setup()
    expect(t.mod.scanQuota({ scans_today: 3, scans_day_reset: '2026-10-04T23:59:59Z' }, now)).toMatchObject({ used: 0, remaining: 3 })
  })
  it('exactly midnight is today; never negative, never above the limit; garbage reads as unused', () => {
    t = setup()
    expect(t.mod.scanQuota({ scans_today: 1, scans_day_reset: '2026-10-05T00:00:00Z' }, now).used).toBe(1)
    expect(t.mod.scanQuota({ scans_today: 99, scans_day_reset: '2026-10-05T05:00:00Z' }, now)).toMatchObject({ used: 3, remaining: 0 })
    expect(t.mod.scanQuota({ scans_today: -4, scans_day_reset: '2026-10-05T05:00:00Z' }, now).remaining).toBe(3)
    expect(t.mod.scanQuota({ scans_today: 2, scans_day_reset: null }, now).used).toBe(0)
    expect(t.mod.scanQuota(null, now).remaining).toBe(3)
  })
})

describe('getProfile — quota and preferences ride along', () => {
  it('selects only what it returns, and reports the allowance and the email preference', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: null, scans_today: 1, scans_day_reset: new Date().toISOString(), notify_scan_results: false }, error: null } : undefined)
    const d = (await t.mod.getProfile(t.c())).body.data
    expect(d.quota).toMatchObject({ limit: 3, used: 1, remaining: 2 })
    expect(d.preferences).toEqual({ notifyScanResults: false })
    expect(t.db.calls[0].cols).not.toMatch(/password|token/)
  })
  it('a row from before migration 0052 (no column) reads as notifications on', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: null }, error: null } : undefined)
    expect((await t.mod.getProfile(t.c())).body.data.preferences).toEqual({ notifyScanResults: true })
  })
  it('reports when the profile was last edited', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: { resumeData: { name: 'J' }, savedAt: 'a', editedAt: 'b' } }, error: null } : undefined)
    expect((await t.mod.getProfile(t.c())).body.data.editedAt).toBe('b')
  })
})

describe('getProfileData — the saved resume, for the editor', () => {
  it('404s when there is none', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: null }, error: null } : undefined)
    expect((await t.mod.getProfileData(t.c())).status).toBe(404)
  })
  it('returns the owner\'s resume, scoped to the requesting user', async () => {
    t = setup(q => q.table === 'users' ? { data: { saved_profile: { resumeData: { name: 'Jane' }, savedAt: 's' } }, error: null } : undefined)
    const res = await t.mod.getProfileData(t.c({ userId: 'u9' }))
    expect(res.body.data).toEqual({ resumeData: { name: 'Jane' }, savedAt: 's', editedAt: null, version: 's|' })
    expect(t.db.calls[0].filters).toContainEqual(['eq', 'id', 'u9'])
  })
  it('propagates a database error', async () => {
    t = setup(() => ({ data: null, error: new Error('db down') }))
    await expect(t.mod.getProfileData(t.c())).rejects.toThrow('db down')
  })
})

describe('updateProfile — correcting the saved profile', () => {
  const good = { experience: [{ title: 'Engineer', company: 'A', bullets: ['Built x', ''] }], skills: ['SQL', ' '] }
  it('replaces ONLY the resume content, through the atomic RPC, validated and cleaned', async () => {
    t = setup(q => q.op === 'rpc' ? { data: true, error: null } : undefined)
    const res = await t.mod.updateProfile(t.c({ userId: 'u3', body: { resumeData: good } }))
    expect(res.body.success).toBe(true)
    const rpc = t.db.calls.find(c => c.op === 'rpc')
    expect(rpc.name).toBe('set_saved_profile_resume')
    expect(rpc.args.p_user_id).toBe('u3')
    expect(rpc.args.p_resume.skills).toEqual(['SQL'])
    expect(rpc.args.p_resume.experience[0].bullets).toEqual(['Built x'])
    expect(Number.isFinite(Date.parse(rpc.args.p_edited_at))).toBe(true)
    // never a read-modify-write of the whole profile
    expect(t.db.calls.some(c => c.table === 'users')).toBe(false)
  })
  it('400s a malformed or oversized body before touching the database', async () => {
    for (const body of [{}, { resumeData: 'x' }, { resumeData: { experience: 'x' } }, { resumeData: { summary: 'x'.repeat(MAX_RESUME_DATA_JSON_CHARS) } }, null, []]) {
      t = setup()
      expect((await t.mod.updateProfile(t.c({ body }))).status, JSON.stringify(body)?.slice(0, 40)).toBe(400)
      expect(t.db.calls).toHaveLength(0)
      t.restore()
    }
    t = setup()
    expect((await t.mod.updateProfile(t.c({ badJson: true }))).status).toBe(400)
  })
  it('400s a profile with nothing in it', async () => {
    t = setup()
    const res = await t.mod.updateProfile(t.c({ body: { resumeData: { name: 'Jane', skills: ['', ' '] } } }))
    expect(res.status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
  })
  it('404s when there is no saved profile to edit (it will not create one out of client data)', async () => {
    t = setup(q => q.op === 'rpc' ? { data: false, error: null } : undefined)
    expect((await t.mod.updateProfile(t.c({ body: { resumeData: good } }))).status).toBe(404)
  })
  it('propagates a database error', async () => {
    t = setup(q => q.op === 'rpc' ? { data: null, error: new Error('rpc down') } : undefined)
    await expect(t.mod.updateProfile(t.c({ body: { resumeData: good } }))).rejects.toThrow('rpc down')
  })
})

describe('updatePreferences — the scan-result email toggle', () => {
  it('writes the boolean for the requesting user only', async () => {
    t = setup()
    const res = await t.mod.updatePreferences(t.c({ userId: 'u5', body: { notifyScanResults: false } }))
    expect(res.body.data).toEqual({ notifyScanResults: false })
    const call = t.db.calls[0]
    expect(call.patch).toEqual({ notify_scan_results: false })
    expect(call.filters).toContainEqual(['eq', 'id', 'u5'])
  })
  it('only a real boolean is accepted', async () => {
    for (const body of [{}, { notifyScanResults: 'false' }, { notifyScanResults: 0 }, null, []]) {
      t = setup()
      expect((await t.mod.updatePreferences(t.c({ body }))).status).toBe(400)
      expect(t.db.calls).toHaveLength(0)
      t.restore()
    }
  })
  it('propagates a database error', async () => {
    t = setup(() => ({ data: null, error: new Error('write failed') }))
    await expect(t.mod.updatePreferences(t.c({ body: { notifyScanResults: true } }))).rejects.toThrow('write failed')
  })
})

describe('saveProfile — only a finished scan with a real background can become the profile', () => {
  const scan = over => q => {
    if (q.table === 'scans') return { data: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', original_resume_data: { name: 'J', skills: ['a'] }, ...over }, error: null }
  }
  const save = () => t.mod.saveProfile(t.c({ body: { scanId: SCAN_ID } }))
  it('refuses a scan that ERRORED, with a message that says why — and writes nothing', async () => {
    t = setup(scan({ status: 'ERROR' }))
    const res = await save()
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/did not finish/)
    expect(t.db.calls.some(c => c.op === 'update')).toBe(false)
  })
  it('refuses a scan still in progress', async () => {
    for (const status of ['PENDING', 'SCANNING']) {
      t = setup(scan({ status }))
      const res = await save()
      expect(res.status, status).toBe(400)
      expect(res.body.message).toMatch(/still being processed/)
      t.restore()
    }
  })
  it('refuses structured data with no work history, education, skills or summary', async () => {
    t = setup(scan({ original_resume_data: { name: 'J', email: 'j@x.com' } }))
    const res = await save()
    expect(res.status).toBe(400)
    expect(t.db.calls.some(c => c.op === 'update')).toBe(false)
  })
  it('accepts every completed / paid status', async () => {
    for (const status of ['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED']) {
      t = setup(q => scan({ status })(q) || (q.op === 'rpc' ? { data: true, error: null } : undefined))
      expect((await save()).body.success, status).toBe(true)
      t.restore()
    }
  })
})

describe('exportMyData — what the account holds about its owner', () => {
  const rows = {
    users: { data: { name: 'Jane', email: 'jane@x.com', email_verified: true, free_fix_credits: 0, created_at: 'c', saved_profile: null,
      pending_email: 'new@x.com', pending_email_expiry: new Date(Date.now() + 3600_000).toISOString(), notify_scan_results: false, terms_accepted_at: 'ta', terms_version: '2026-01',
      last_login_at: 'l1', last_login_ip: '1.1.1.1', previous_login_at: 'l0', previous_login_ip: '2.2.2.2' }, error: null },
    scans: { data: [], count: 0, error: null },
    payments: { data: [], error: null },
    user_sessions: { data: [{ id: 'ses1', created_at: 'c', last_seen_at: 'l', absolute_expires_at: 'e', revoked_at: null, ip: '1.1.1.1', user_agent: 'UA' }], error: null },
    email_logs: { data: [{ subject: 'Welcome', template: 'welcome', status: 'sent', sent_at: 's' }], error: null },
  }
  it('part 1 carries sign-in history, terms acceptance, preferences, devices and the mail sent to the address', async () => {
    t = setup(q => rows[q.table])
    const out = JSON.parse((await t.mod.exportMyData(t.c())).raw)
    expect(out.account).toMatchObject({
      pendingEmail: 'new@x.com', notifyScanResults: false, termsAcceptedAt: 'ta', termsVersion: '2026-01',
      lastLoginAt: 'l1', lastLoginIp: '1.1.1.1', previousLoginAt: 'l0', previousLoginIp: '2.2.2.2',
    })
    expect(out.sessions).toEqual([{ id: 'ses1', createdAt: 'c', lastSeenAt: 'l', absoluteExpiresAt: 'e', revokedAt: null, ip: '1.1.1.1', userAgent: 'UA' }])
    expect(out.emailsSent).toEqual([{ subject: 'Welcome', template: 'welcome', status: 'sent', sentAt: 's' }])
    expect(out.emailsTruncated).toBe(false)
  })
  it('reads each extra table scoped to this account, with explicit columns', async () => {
    t = setup(q => rows[q.table])
    await t.mod.exportMyData(t.c({ userId: 'u8' }))
    const sess = t.db.calls.find(c => c.table === 'user_sessions')
    expect(sess.filters).toContainEqual(['eq', 'user_id', 'u8'])
    expect(sess.cols).not.toBe('*')
    const mail = t.db.calls.find(c => c.table === 'email_logs')
    expect(mail.filters).toContainEqual(['eq', 'to', 'jane@x.com'])
    expect(mail.cols).toBe('subject, template, status, sent_at')
  })
  it('lists the job title of each scan', async () => {
    t = setup(q => rows[q.table])
    await t.mod.exportMyData(t.c())
    expect(t.db.calls.find(c => c.table === 'scans').cols).toContain('job_title')
  })
  it('flags a truncated mail history', async () => {
    t = setup(q => q.table === 'email_logs' ? { data: Array.from({ length: 500 }, () => ({ subject: 's' })), error: null } : rows[q.table])
    expect(JSON.parse((await t.mod.exportMyData(t.c())).raw).emailsTruncated).toBe(true)
  })
  it('a failing extra read fails the export rather than handing over a file that silently lacks it', async () => {
    t = setup(q => q.table === 'user_sessions' ? { data: null, error: new Error('sessions down') } : rows[q.table])
    await expect(t.mod.exportMyData(t.c())).rejects.toThrow('sessions down')
  })
})

describe('deleteScanHistory — batched, safe deletion of the whole history', () => {
  const R = (id, over = {}) => ({ id, status: 'COMPLETE_PASS', updated_at: '2020-01-01', resume_path: `r/${id}.pdf`, resume_ats_path: null, resume_pdf_path: `r/${id}.out.pdf`, verification_code: null, ...over })
  function history({ list, held = [], removed, remaining = 0, delError, listError } = {}) {
    const state = { deleted: [], r2: [] }
    state.r2Calls = []
    // R2's delete() takes one key or a list; a bulk call that includes the failing key fails whole.
    const bucket = { delete: async k => { const keys = [].concat(k); state.r2Calls.push(keys); if (keys.includes(state.failKey)) throw new Error('r2 down'); state.r2.push(...keys) } }
    const tombstones = []
    const x = setup(q => {
      if (q.table === 'scans' && q.op === 'select' && q.selectOpts?.head) return { count: remaining, error: null }
      if (q.table === 'scans' && q.op === 'select') return { data: list, error: listError || null }
      if (q.table === 'payments') return { data: held.map(scan_id => ({ scan_id })), error: null }
      if (q.table === 'scans' && q.op === 'delete') { state.deleted = q.filters.find(f => f[0] === 'in')[2]; return { data: (removed ?? state.deleted).map(id => ({ id })), error: delError || null } }
    }, { tombstones, bucket })
    return { ...x, state, tombstones }
  }
  const run = () => t.mod.deleteScanHistory(t.c({ userId: 'u1' }))

  it('deletes the oldest batch for this user, their stored files, leaves tombstones, clears the profile pointer, and says how many are left', async () => {
    t = history({ list: [R('a', { verification_code: 'CODE1' }), R('b')], remaining: 7 })
    const res = await run()
    expect(res.body).toEqual({ success: true, data: { deleted: 2, remaining: 7 } })
    const list = t.db.calls.find(c => c.table === 'scans' && c.op === 'select' && !c.selectOpts?.head)
    expect(list.filters).toContainEqual(['eq', 'user_id', 'u1'])
    expect(list.orders.map(o => o[0])).toEqual(['created_at', 'id'])
    expect(list.orders[0][1]).toEqual({ ascending: true })
    expect(list.limit).toBe(25)
    const del = t.db.calls.find(c => c.op === 'delete')
    expect(del.filters).toContainEqual(['eq', 'user_id', 'u1'])           // never deletes by id alone
    expect(t.state.deleted).toEqual(['a', 'b'])
    expect([...t.state.r2].sort()).toEqual(['r/a.out.pdf', 'r/a.pdf', 'r/b.out.pdf', 'r/b.pdf'])
    expect(t.tombstones.map(r => r.id)).toEqual(['a', 'b'])
    const rpc = t.db.calls.find(c => c.op === 'rpc')
    expect(rpc).toMatchObject({ name: 'clear_saved_profile_source', args: { p_user_id: 'u1', p_scan_ids: ['a', 'b'] } })
  })
  it('never selects a scan a job is still working on: the query itself excludes fresh in-flight rows', async () => {
    t = history({ list: [] })
    await run()
    const list = t.db.calls.find(c => c.table === 'scans' && c.op === 'select' && !c.selectOpts?.head)
    expect(list.or).toHaveLength(1)
    expect(list.or[0]).toMatch(/^status\.not\.in\.\(PENDING,SCANNING,FIX_PURCHASED,FIX_GENERATING\),updated_at\.lte\./)
  })
  it('skips a scan with a payment still in flight and deletes the rest', async () => {
    t = history({ list: [R('a'), R('b')], held: ['a'], remaining: 1 })
    const res = await run()
    expect(t.state.deleted).toEqual(['b'])
    expect(res.body.data).toEqual({ deleted: 1, remaining: 1 })
    expect(t.state.r2).not.toContain('r/a.pdf')
  })
  it('does only cleanup for rows the database actually removed', async () => {
    t = history({ list: [R('a'), R('b')], removed: ['b'], remaining: 1 })
    const res = await run()
    expect(res.body.data.deleted).toBe(1)
    expect(t.tombstones.map(r => r.id)).toEqual(['b'])
    expect(t.state.r2.every(k => k.startsWith('r/b'))).toBe(true)
  })
  it('an empty history is a clean no-op (no delete, no payments lookup, no RPC)', async () => {
    t = history({ list: [] })
    const res = await run()
    expect(res.body.data).toEqual({ deleted: 0, remaining: 0 })
    expect(t.db.calls.some(c => c.op === 'delete' || c.table === 'payments' || c.op === 'rpc')).toBe(false)
  })
  it('removes the whole batch\'s files in ONE R2 call, not one subrequest per object', async () => {
    t = history({ list: [R('a'), R('b'), R('c')], remaining: 0 })
    await run()
    expect(t.state.r2Calls).toHaveLength(1)
    expect(t.state.r2Calls[0].sort()).toEqual(['r/a.out.pdf', 'r/a.pdf', 'r/b.out.pdf', 'r/b.pdf', 'r/c.out.pdf', 'r/c.pdf'])
  })
  it('a failing R2 delete never fails the request or skips the other objects (falls back key by key)', async () => {
    t = history({ list: [R('a')], remaining: 0 }); t.state.failKey = 'r/a.pdf'
    const res = await run()
    expect(res.body.data.deleted).toBe(1)
    expect(t.state.r2).toEqual(['r/a.out.pdf'])
  })
  it('a batch with no stored files makes no R2 call', async () => {
    t = history({ list: [R('a', { resume_path: null, resume_pdf_path: null })], remaining: 0 })
    await run()
    expect(t.state.r2Calls).toHaveLength(0)
  })
  it('a failing pointer RPC never fails a deletion that already happened', async () => {
    t = history({ list: [R('a')] })
    const orig = t.db.rpc
    t.db.rpc = (n, a) => { orig(n, a); return Promise.resolve({ data: null, error: { message: 'rpc down' } }) }
    expect((await run()).body.data.deleted).toBe(1)
  })
  it('database errors propagate and no file is removed', async () => {
    t = history({ list: [R('a')], delError: new Error('db down') })
    await expect(run()).rejects.toThrow('db down')
    expect(t.state.r2).toEqual([])
    t.restore()
    t = history({ list: null, listError: new Error('list down') })
    await expect(run()).rejects.toThrow('list down')
  })
})
