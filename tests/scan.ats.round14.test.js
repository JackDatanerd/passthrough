// Scan / ATS round 14: a provisional (AI-less) score the person can see and re-check, delivery that cannot land after a refund or
// on top of another run, downloads that stop with a reversed purchase, the cover letter keeping its document look, a per-account
// budget on job-link lookups, quantified-figure counting that ignores skills lists / standards / postal lines, and no 1970 start time.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { countQuantifiedFigures, scoreResume } from '../src/services/ats.service.js'
import { scanRowToCamel } from '../src/lib/mappers.js'

let t
afterEach(() => { t?.restore?.(); t = null })
const read = p => fs.readFileSync(p, 'utf8')
const CTRL = read('src/controllers/scan.controller.js')

function baseCtx(over = {}) {
  return {
    env: { RESUMES_BUCKET: { get: async () => null }, ...over.env },
    get: k => (k === 'user' ? (over.user ?? { id: 'u1', emailVerified: true }) : undefined),
    req: { param: () => over.param ?? 's1', query: k => (over.query ?? {})[k], json: async () => over.body ?? {} },
    json: (body, status = 200) => ({ body, status }), header: () => {}, body: b => ({ rawBody: b }),
  }
}
const reversedDb = (scan, paymentStatus) => createFakeSupabase(q => {
  if (q.table === 'scans') return { data: scan, error: null }
  if (q.table === 'payments') return { data: { status: paymentStatus }, error: null }
})

describe('B1 - an AI-less score is visible and re-checkable', () => {
  it('buildAtsDetail exposes the flag the scan already stored', () => {
    expect(CTRL).toMatch(/scoredWithoutAi: fullAtsReport\.aiScored === false/)
  })
  it('the route exists and is rate limited like the other resume edits', () => {
    expect(read('src/routes/scan.routes.js')).toMatch(/router\.post\('\/:id\/rescore-ai',\s+rl\.resumeEdit, validateUuidParam\(\), c\.rescoreAi\)/)
  })
  it('a provisional score is not mailed as the result; the real one is mailed after the re-check', () => {
    expect(CTRL).toMatch(/if \(aiBlended\) await notifyScanResult\(/)
    expect(CTRL).toMatch(/await notifyScanResult\(ctx\.env, supabase, scan, scan\.id, finalScore/)
  })
  const mk = (over = {}) => ({ id: 's1', user_id: 'u1', status: 'COMPLETE_FAIL', fix_purchased: false, input_mode: 'brain_dump',
    original_resume_data: { name: 'A B', email: 'a@x.com', skills: ['Go'] }, job_description_text: 'We need a Go developer. '.repeat(5),
    ats_score: 79, full_ats_report: { aiScored: false }, ...over })
  const load = (scan, extra = {}) => loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => createFakeSupabase(q => (q.table === 'scans' && q.op === 'select' ? { data: scan, error: null } : undefined)) }, ...extra })
  it('refuses a scan that was scored with the AI half (nothing to re-check) without touching it', async () => {
    t = load(mk({ full_ats_report: { aiScored: undefined } }))
    const res = await t.mod.rescoreAi(baseCtx())
    expect(res.status).toBe(200); expect(res.body.data.alreadyChecked).toBe(true)
  })
  it('refuses a purchased scan and someone else\'s scan', async () => {
    t = load(mk({ fix_purchased: true })); expect((await t.mod.rescoreAi(baseCtx())).status).toBe(400); t.restore()
    t = load(mk({ user_id: 'other' })); expect((await t.mod.rescoreAi(baseCtx())).status).toBe(403)
  })
})

describe('B2 - delivery cannot land after a refund or on top of another run', () => {
  it('both runs re-check the purchase right before delivery and guard the write by status', () => {
    expect((CTRL.match(/if \(await standDownIfReversed\(env, supabase, scanId, \{ priorDelivery, writtenKeys \}\)\)/g) || []).length).toBe(2)
    expect((CTRL.match(/\.eq\('id', scanId\)\.eq\('status', 'FIX_GENERATING'\)\.select\('id'\)/g) || []).length).toBe(2)
    expect((CTRL.match(/delivered\.length === 0/g) || []).length).toBe(2)
  })
  it('the lease is extended while a fix run is alive (and only the badge run, which is short, is not)', () => {
    expect((CTRL.match(/await renewFixJob\(supabase, scanId, leaseToken\)/g) || []).length).toBe(2)
    expect(CTRL).toMatch(/generateFixRun\(tracked, supabase, scanId, lease\)/)
    expect(CTRL).toMatch(/\.eq\('id', scanId\)\.eq\('fix_job_lock_token', token\)/)
  })
})

describe('B3 - a reversed purchase keeps no downloads', () => {
  it.each(['REFUNDED', 'DISPUTED'])('downloadFile 403s PURCHASE_REVERSED for a %s payment', async status => {
    t = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => reversedDb({ id: 's1', user_id: 'u1', fix_purchased: true, fix_payment_id: 'p1', resume_pdf_path: 'k' }, status) } })
    const res = await t.mod.downloadFile(baseCtx({ query: { type: 'pdf' } }))
    expect(res.status).toBe(403); expect(res.body.code).toBe('PURCHASE_REVERSED')
  })
  it('a live purchase still downloads (it reaches the missing-object 404, not the reversal 403)', async () => {
    t = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => reversedDb({ id: 's1', user_id: 'u1', fix_purchased: true, fix_payment_id: 'p1', resume_pdf_path: 'k' }, 'SUCCESS') } })
    expect((await t.mod.downloadFile(baseCtx({ query: { type: 'pdf' } }))).status).toBe(404)
  })
  it('the cover letter downloads stop for a reversed purchase too', async () => {
    const row = { id: 's1', user_id: 'u1', fix_payment_id: 'p1', cover_letter_text: 'Dear team', doc_template_version: 3 }
    t = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => reversedDb(row, 'REFUNDED') } })
    const res = await t.mod.downloadCoverLetter(baseCtx())
    expect(res.status).toBe(403); expect(res.body.code).toBe('PURCHASE_REVERSED')
  })
})

describe('B4 - the cover letter keeps the document look of its scan', () => {
  it('loadCoverLetter selects doc_template_version (the column it passes on to the look)', () => {
    const sel = CTRL.match(/select\('(id, user_id, cover_letter_text[^']*)'\)/)
    expect(sel).toBeTruthy(); expect(sel[1]).toMatch(/doc_template_version/)
  })
  it('every getDesignTokens call in the controller carries the scan\'s look version', () => {
    const calls = CTRL.split('getDesignTokens(').slice(1).map(x => x.slice(0, 260))
    expect(calls.length).toBeGreaterThan(5)
    for (const c of calls) expect(c).toMatch(/version:/)
  })
})

describe('B5 - a signed-in account has its own budget for job-link lookups', () => {
  it('over budget: 429, and no outbound fetch is made', async () => {
    let fetched = 0
    t = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => createFakeSupabase() },
      'middleware/rateLimiter.js': { isBypassed: () => false, hitQuota: async () => false, anonScanSlotKey: () => 'k', refundAnonScanSlot: async () => {} },
      'services/jd.parser.js': { fetchJobDescriptionFromUrl: async () => { fetched++; return { success: true, text: 'x'.repeat(80) } } },
    })
    const ctx = { env: {}, get: k => ({ uploadedFile: null, formFields: { jobDescriptionUrl: 'https://example.com/job', brainDumpText: 'x'.repeat(200) }, user: { id: 'u1', email: 'o@x.com', scansToday: 0, emailVerified: true } }[k]),
      req: {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} } }
    const res = await t.mod.createScan(ctx)
    expect(res.status).toBe(429); expect(fetched).toBe(0)
  })
})

describe('B6 - the scan start time is never 1970', () => {
  it('the "no slot spent" marker falls back to the last update, a real stamp passes through, none uses created_at', () => {
    const base = { id: 's', status: 'PENDING', created_at: '2026-10-21T10:00:00Z', updated_at: '2026-10-21T10:05:00Z' }
    expect(scanRowToCamel({ ...base, scan_slot_spent_at: new Date(0).toISOString() }).scanStartedAt).toBe('2026-10-21T10:05:00Z')
    expect(scanRowToCamel({ ...base, scan_slot_spent_at: '2026-10-21T10:04:00Z' }).scanStartedAt).toBe('2026-10-21T10:04:00Z')
    expect(scanRowToCamel({ ...base, scan_slot_spent_at: null }).scanStartedAt).toBe('2026-10-21T10:00:00Z')
  })
})

describe('B7 - numbers that are not results are not counted as quantified', () => {
  it.each([
    ['Skills: Python 3, Java 17, Node 18'], ['Technical skills - Python 3.11, PostgreSQL 15'], ['ISO 9001 certified auditor'],
    ['SOC 2 and RFC 7231 compliant APIs'], ['Denver, CO 80202'], ['Austin, TX 78701'],
  ])('%s counts as nothing', text => { expect(countQuantifiedFigures(text)).toBe(0) })
  it('a skills section is skipped, the experience after it is not', () => {
    expect(countQuantifiedFigures('Skills\nPython 3, Java 17, Node 18\nExperience\nCut costs by 30%\nLed 12 engineers')).toBe(2)
  })
  it('real figures still count', () => {
    expect(countQuantifiedFigures('Cut p99 latency from 200ms to 50ms')).toBe(2)
    expect(countQuantifiedFigures('Grew ARR by $1.2M')).toBe(1)
    expect(countQuantifiedFigures('Managed 12 engineers')).toBe(1)
    expect(countQuantifiedFigures('Ranked 1st of 300 candidates')).toBe(2)
  })
  it('a skills list no longer lifts the quantified count the report shows', () => {
    const mk = s => `Jane Doe\njane@x.com\nSummary\nEngineer.\nExperience\nAcme - Engineer\n- Built internal dashboards\n- Maintained pipelines\nSkills\n${s}\n`
    const jd = 'Engineer with python and java.'
    expect(scoreResume(mk('Python 3, Java 17, Node 18'), jd).detail.content.quantifiedCount).toBe(0)
  })
})

describe('frontend - the provisional score is shown and re-checkable', () => {
  it('ScanResult shows the notice with a re-check that posts to the route; FixBanner stops claiming a rejection', () => {
    const sr = read('frontend/src/pages/ScanResult.jsx'), fb = read('frontend/src/components/scan/FixBanner.jsx')
    expect(sr).toMatch(/scan\.atsDetail\?\.scoredWithoutAi && !scan\.fixPurchased/)
    expect(sr).toMatch(/api\.post\(`\/scan\/\$\{id\}\/rescore-ai/)
    expect(sr).toMatch(/provisional=\{!!scan\.atsDetail\?\.scoredWithoutAi\}/)
    // One provisional notice now (ScanResult's amber card + ScoreSummary's "Your score so far" headline); FixBanner's job is to
    // stop claiming a rejection / a points gap while the score is provisional.
    expect(sr).toContain('This score is provisional')
    expect(read('frontend/src/components/scan/ScoreSummary.jsx')).toMatch(/provisional \? 'Your score so far'/)
    expect(fb).toMatch(/!eligible && !provisional && gap > 0/)
  })
})
