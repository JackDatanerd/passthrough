// Resume-from-scratch round 2: thin hand-filled resumes, account-detail injection, failed-scan text retention,
// PDF contact links, the draft-PDF rate bucket.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const rl = require('../src/middleware/rateLimiter.js')
const { purgeFailedBackgrounds, FAILED_BACKGROUND_RETENTION_DAYS, runRetention } = require('../src/services/retention.service.js')

let t
afterEach(() => t?.restore())
let realErr; beforeEach(() => { realErr = console.error; console.error = () => {} }); afterEach(() => { console.error = realErr })

function kv() { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }

// One job with one bullet, a name and an email: valid for the form and the server, ~76 characters once rendered.
const THIN = { name: 'Jane Doe', email: 'jane@x.com', experience: [{ company: 'Acme', title: 'Analyst', dates: '2020-2023', bullets: ['Built dashboards'] }] }

function setupScan(opts = {}) {
  const state = { updates: [], structured: [], refunds: [], rpcs: [], scored: 0 }
  const scan = {
    id: 's1', input_mode: opts.inputMode ?? 'brain_dump', job_description_text: 'JD', user_id: opts.userId ?? null,
    created_at: new Date().toISOString(), raw_brain_dump_text: opts.raw ?? null,
    original_resume_data: opts.original ?? null, contact_name: opts.contactName ?? null, contact_email: opts.contactEmail ?? null,
    resume_path: opts.inputMode === 'file' ? 'k' : null,
  }
  const db = createFakeSupabase(q => {
    if (q.op === 'rpc') { state.rpcs.push(q.name); return { data: null, error: null } }
    if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
    if (q.table === 'users' && q.op === 'select') return { data: opts.userRow ?? null, error: null }
    if (q.table === 'scans' && q.op === 'update') { state.updates.push(q); return { data: [{ id: 's1' }], error: null } }
  })
  const m = loadWithStubs('controllers/scan.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'middleware/rateLimiter.js': { isBypassed: () => false, refundAnonScanSlot: async (_e, k) => { state.refunds.push(k) } },
    'services/resume.parser.js': {
      structureBrainDump: async () => opts.structureResult ?? { resumeData: { name: null, email: null, skills: ['Go'], experience: [{ company: 'A', title: 'B', bullets: ['x'.repeat(40)] }] } },
      // Short on purpose: the rendered text of a thin resume.
      serializeResumeData: d => `${d.name || ''}\nGo`,
      analyzeUpload: async () => ({ text: 'short', structure: null, failure: null }),
    },
    'services/ats.service.js': {
      scoreResume: () => { state.scored++; return { score: 20, keywordScore: 10, formatScore: 10, sectionsScore: 40, contentScore: 10, detail: {} } },
      detectRoleCategory: () => 'x', detectSeniority: () => 'mid',
    },
    'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: false }), extractJson: x => x },
    'services/email.service.js': { sendScanPass: async () => {}, sendScanFail: async () => {} },
  })
  const env = { RESUMES_BUCKET: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) } }
  return { ...m, state, db, env }
}
const patches = s => s.updates.map(u => u.patch)
const errorPatch = s => patches(s).find(p => p?.status === 'ERROR')
const savedResume = s => patches(s).find(p => p?.original_resume_data)?.original_resume_data

describe('runAtsScan — a short hand-filled resume is scored, not rejected (B1)', () => {
  it('one job with one bullet completes with a score instead of ending TOO_SHORT', async () => {
    t = setupScan({ original: THIN, userId: 'u1', userRow: { name: 'Account Name', email: 'acct@x.com' } })
    const out = await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(out.success).toBe(true)
    expect(errorPatch(t.state)).toBeUndefined()
    expect(t.state.scored).toBe(1)
    expect(patches(t.state).find(p => p?.ats_score === 20)).toMatchObject({ status: 'COMPLETE_FAIL' })
  })
  it('a form with nothing in it asks for more detail (NEEDS_MORE_DETAIL), not "no text in this file", and drops the pasted text', async () => {
    t = setupScan({ original: { name: 'Jane Doe' }, raw: 'typed background that is long enough' })
    const out = await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(out.success).toBe(false)
    const p = errorPatch(t.state)
    expect(p.full_ats_report.errorCode).toBe('NEEDS_MORE_DETAIL')
    expect(p.full_ats_report.error).not.toMatch(/file/i)
    expect(p.raw_brain_dump_text).toBeNull()
  })
  it('an uploaded file with almost no text still fails as TOO_SHORT (the floor is for empty files)', async () => {
    t = setupScan({ inputMode: 'file' })
    const out = await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(out.errorCode).toBe('TOO_SHORT')
    expect(errorPatch(t.state).full_ats_report.errorCode).toBe('TOO_SHORT')
  })
  it('a saved profile with content also scores when short', async () => {
    t = setupScan({ inputMode: 'saved_profile', original: THIN, userId: 'u1' })
    expect((await t.mod.runAtsScan(t.env, t.db, 's1')).success).toBe(true)
    expect(errorPatch(t.state)).toBeUndefined()
  })
})

describe('runAtsScan — account details are not injected into what the person typed (B4)', () => {
  const NO_EMAIL = { name: '', email: '', experience: [{ company: 'Acme', title: 'Analyst', bullets: ['Built dashboards for the finance team'] }] }
  it('a hand-filled form left blank stays blank for a signed-in person', async () => {
    t = setupScan({ original: NO_EMAIL, userId: 'u1', userRow: { name: 'Account Name', email: 'acct@x.com' } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(savedResume(t.state)).toMatchObject({ name: '', email: '' })
  })
  it('data the model just structured from free text still falls back to the account name and email', async () => {
    t = setupScan({ raw: 'I did things. '.repeat(20), userId: 'u1', userRow: { name: 'Account Name', email: 'acct@x.com' } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(savedResume(t.state)).toMatchObject({ name: 'Account Name', email: 'acct@x.com' })
  })
})

describe('a pasted background is not kept for a retry that cannot happen (B3)', () => {
  it('"tell us more" drops it; a failure on our side keeps it for retry-scan', async () => {
    const fail = msg => ({ resumeData: null, parseError: true, parseErrorMessage: msg })
    t = setupScan({ raw: 'x'.repeat(150), structureResult: fail('Tell us a bit more about your background.') })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(errorPatch(t.state)).toMatchObject({ raw_brain_dump_text: null })
    t.restore()
    t = setupScan({ raw: 'x'.repeat(150), structureResult: fail('Could not structure your background (PARSE_FAIL).') })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(errorPatch(t.state).full_ats_report.errorCode).toBe('STRUCTURE_FAILED')
    expect('raw_brain_dump_text' in errorPatch(t.state)).toBe(false)
  })
  it('the hourly retention sweep clears the text of scans that stayed ERROR for a week', async () => {
    const NOW = Date.parse('2026-10-17T00:00:00Z')
    const db = createFakeSupabase(() => ({ data: [{ id: 'a' }, { id: 'b' }], error: null }))
    expect(await purgeFailedBackgrounds(db, NOW)).toEqual({ cleared: 2 })
    const q = db.calls[0]
    expect(q).toMatchObject({ table: 'scans', op: 'update', patch: { raw_brain_dump_text: null } })
    expect(eqValue(q, 'status')).toBe('ERROR')
    expect(q.filters).toContainEqual(['not', 'raw_brain_dump_text', 'is', null])
    expect(q.filters.find(f => f[0] === 'lt' && f[1] === 'updated_at')[2]).toBe(new Date(NOW - FAILED_BACKGROUND_RETENTION_DAYS * 86400000).toISOString())
    expect(FAILED_BACKGROUND_RETENTION_DAYS).toBe(7)
  })
  it('reports a database failure without throwing, and runRetention carries the step', async () => {
    expect(await purgeFailedBackgrounds(createFakeSupabase(() => ({ error: { message: 'db down' } })))).toEqual({ cleared: 0, error: 'db down' })
    const r = await runRetention({ RESUMES_BUCKET: { delete: async () => {} } }, createFakeSupabase(() => ({ data: [], error: null })), Date.now())
    expect(r.failedBackgrounds).toEqual({ cleared: 0 })
  })
})

describe('the free draft PDF has its own rate bucket (B4)', () => {
  it('route is wired to draftPdf, not the paid regenerate-pdf bucket', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../src/routes/scan.routes.js'), 'utf8')
    expect(routes).toMatch(/download-draft-pdf', rl\.draftPdf/)
    expect(routes).toMatch(/regenerate-pdf', auth, rl\.pdfRegen/)
  })
  it('eight draft PDFs do not use up the paid regenerate budget', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => { c.set('user', { id: 'alice' }); return next() })
    app.get('/draft', rl.draftPdf, c => c.json({ ok: true }))
    app.get('/regen', rl.pdfRegen, c => c.json({ ok: true }))
    const env = { RATE_LIMIT_KV: kv() }
    for (let i = 0; i < 8; i++) expect((await app.request('/draft', {}, env)).status).toBe(200)
    expect((await app.request('/draft', {}, env)).status).toBe(429)
    expect((await app.request('/regen', {}, env)).status).toBe(200)
  })
})
