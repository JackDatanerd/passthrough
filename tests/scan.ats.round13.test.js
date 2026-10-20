// Scan / ATS round 13: the rescan-version field reaching createScan, numeric dates not counted as achievements,
// a delivered rescan of a typed background keeping its "from scratch" label, and a PDF read by the model not being refunded.
import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import uploadResume from '../src/middleware/upload.js'
import { countQuantifiedFigures, scoreResume } from '../src/services/ats.service.js'
import fs from 'node:fs'

let t
afterEach(() => { t?.restore?.(); t = null })

describe('B1 - rescanVersion survives the upload middleware', () => {
  it('reaches the controller in formFields (it used to be dropped, so "improved version" always scanned the original)', async () => {
    const fd = new FormData()
    fd.set('sourceScanId', '33333333-3333-3333-3333-333333333333'); fd.set('rescanVersion', 'delivered'); fd.set('jobDescriptionText', 'x'.repeat(60))
    const request = new Request('https://api.test/api/scan', { method: 'POST', body: fd })
    const store = {}
    const c = { req: { header: n => request.headers.get(n), raw: request }, set: (k, v) => { store[k] = v }, json: (b, s) => ({ b, s }) }
    await uploadResume(c, async () => {})
    expect(store.formFields.rescanVersion).toBe('delivered')
  })
  it('the form field the frontend sends is the one the controller reads', () => {
    expect(fs.readFileSync('frontend/src/components/scan/ScanForm.jsx', 'utf8')).toContain("'rescanVersion'")
    expect(fs.readFileSync('src/middleware/upload.js', 'utf8')).toMatch(/rescanVersion:\s+textField\('rescanVersion'/)
  })
})

describe('B2 - numeric dates, GPA and version numbers are not quantified achievements', () => {
  it.each([
    ['03/2019 - 05/2021'], ['12/31/2020 to 1/5/2021'], ['2019-03 - 2021-05'], ['2019-21'], ['GPA: 3.8'], ['GPA 3.8/4.0'], ['Version 2.0 of the app'], ['v2.1.3'],
  ])('%s counts as nothing', text => { expect(countQuantifiedFigures(text)).toBe(0) })
  it('real figures still count next to a numeric date', () => {
    expect(countQuantifiedFigures('Cut costs by 30% (03/2019 - 05/2021)')).toBe(1)
    expect(countQuantifiedFigures('Led 12 engineers, 2019-2021')).toBe(1)
    expect(countQuantifiedFigures('Led 12 engineers, 2019 - 2021')).toBe(1)   // a date range is not a phone number
    expect(countQuantifiedFigures('Served 2019 customers')).toBe(1)
    expect(countQuantifiedFigures('Grew revenue 3x and saved $40k')).toBe(2)
  })
  it('writing dates numerically no longer changes the score', () => {
    const mk = (a, b) => `Jane Doe\njane@x.com\nSummary\nEngineer.\nExperience\nAcme Corp - Developer\n${a} - ${b}\n- Built services for the platform\n- Maintained the pipeline\nSkills\nJavaScript, SQL\nEducation\nBS Computer Science`
    const jd = 'We need a developer with JavaScript and SQL experience building services.'
    const numeric = scoreResume(mk('03/2019', '05/2021'), jd)
    const words = scoreResume(mk('March 2019', 'May 2021'), jd)
    expect(numeric.detail.content.score ?? numeric.contentScore).toBe(words.detail.content.score ?? words.contentScore)
  })
})

describe('B3 - a delivered rescan of a typed background stays "built from scratch"', () => {
  const SRC = '44444444-4444-4444-4444-444444444444'
  const jd = 'A '.repeat(30) + 'valid job description with enough characters to pass the fifty character minimum.'
  const DATA = { name: 'O', email: 'o@x.com', skills: ['Go'] }
  it.each([['brain_dump', 'brain_dump'], ['file', 'saved_profile']])('source %s -> %s', async (srcMode, expected) => {
    const inserts = []
    const src = { id: SRC, user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'FIX', input_mode: srcMode, resume_path: 'k',
      resume_mime_type: 'application/pdf', original_resume_data: DATA, rewritten_resume_data: DATA, fix_payment_id: null }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'insert') { inserts.push(q.values); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'select') return { data: src, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's' }], error: null }
      if (q.table === 'users') return { data: { scans_today: 1 }, error: null }
      return { data: { status: 'SUCCESS' }, error: null }
    })
    t = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { isBypassed: () => false, anonScanSlotKey: () => 'k', refundAnonScanSlot: async () => {}, hitQuota: async () => true },
    })
    const ctx = {
      env: { RESUMES_BUCKET: { get: async () => null, put: async () => {}, delete: async () => {} }, FIX_QUEUE: { send: async () => {} } },
      get: k => ({ uploadedFile: null, formFields: { jobDescriptionText: jd, sourceScanId: SRC, rescanVersion: 'delivered' }, user: { id: 'u1', email: 'o@x.com', scansToday: 0, emailVerified: true } }[k]),
      req: {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: p => p.catch(() => {}) },
    }
    const real = console.error; console.error = () => {}
    try { await t.mod.createScan(ctx) } finally { console.error = real }
    expect(inserts[0].input_mode).toBe(expected)
  })
})

describe('B4 - a PDF the model was asked to read is not refunded when it still fails', () => {
  it('the parser marks the file, and the controller checks the mark before refunding', () => {
    expect(fs.readFileSync('src/services/resume.parser.js', 'utf8')).toMatch(/structure\.ocrAttempted = true/)
    expect(fs.readFileSync('src/controllers/scan.controller.js', 'utf8')).toMatch(/failedHere && !layoutStructure\?\.ocrAttempted/)
  })
})
