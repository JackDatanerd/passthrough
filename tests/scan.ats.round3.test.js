import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const require = createRequire(import.meta.url)
const sha256hex = s => createHash('sha256').update(s).digest('hex')
const ats = require('../src/services/ats.service.js')
const claude = require('../src/services/claude.service.js')

// Scan / ATS round 3 regressions.

const JD = `Senior Backend Engineer – Payments (Remote, Kenya or EMEA)

About Acme Pay
Acme Pay is a fast-growing fintech company building payment infrastructure across Africa. We are an equal opportunity employer.

What you'll do
- Design and build scalable REST APIs in Node.js and TypeScript
- Own our PostgreSQL schemas, migrations and query performance
- Work with Docker, Kubernetes and AWS (ECS, S3, SQS) in a CI/CD environment
- Mentor junior engineers and lead code reviews

Requirements
- 5+ years of backend experience with distributed systems
- Strong knowledge of payment systems, M-Pesa integrations, and idempotency
- Experience with microservices, event-driven architecture and monitoring (Datadog, Grafana)

Nice to have: Go, Rust, GraphQL`

const RESUME = `Jane Wanjiru
jane@example.com | +254 700 000 000 | Nairobi, Kenya | linkedin.com/in/jane

SUMMARY
Backend engineer with 6 years building payment services.

EXPERIENCE
Senior Software Engineer — PayCo — Nairobi, Kenya    2020 – Present
- Designed and built REST APIs in Node.js and TypeScript handling 2M transactions/month
- Led migration of PostgreSQL schemas, cutting query time by 40%
- Deployed services on Docker and AWS using CI/CD pipelines
- Mentored 4 junior engineers

Software Engineer — Startup Ltd — Nairobi    2017 – 2020
- Integrated M-Pesa Daraja API for mobile payments
- Implemented event-driven microservices

EDUCATION
BSc Computer Science — University of Nairobi    2013 – 2017

SKILLS
Node.js, TypeScript, PostgreSQL, Docker, AWS, Kubernetes, Datadog, Go

CERTIFICATIONS
- AWS Certified Developer
`

describe('B1 — keyword selection follows what the role asks for, not the posting\'s opening paragraph', () => {
  it('a well-matched resume is no longer failed on company-blurb words', () => {
    const r = ats.scoreResume(RESUME, JD)
    expect(r.keywordScore).toBeGreaterThanOrEqual(60)
    const missing = r.detail.keywords.missing.join(' ').toLowerCase()
    for (const junk of ['acme', 'fintech', 'employer', 'equal', 'africa', 'fast growing', 'emea', 'what']) expect(missing).not.toContain(junk)
    const matched = r.detail.keywords.matched.join(' ').toLowerCase()
    for (const skill of ['typescript', 'postgresql', 'docker', 'kubernetes', 'aws']) expect(matched).toContain(skill)
  })
  it('deleting the company intro barely moves the score (it used to swing it by ~30 points)', () => {
    const noBlurb = JD.replace(/About Acme Pay[\s\S]*?What you'll do/, "What you'll do")
    const a = ats.scoreResume(RESUME, JD).keywordScore
    const b = ats.scoreResume(RESUME, noBlurb).keywordScore
    expect(Math.abs(a - b)).toBeLessThanOrEqual(6)
  })
  it('the same posting flattened onto ONE line (a URL fetch) is scored the same way', () => {
    const flat = ats.scoreResume(RESUME, JD.replace(/\n+/g, ' ')).keywordScore
    expect(flat).toBeGreaterThanOrEqual(55)
  })
  it('a posting with no headings at all still ranks the named skills', () => {
    const plain = 'We need a backend engineer who knows Node.js, TypeScript, PostgreSQL, Docker and AWS and has built REST APIs. Kubernetes is a plus.'
    expect(ats.scoreResume(RESUME, plain).keywordScore).toBeGreaterThanOrEqual(80)
  })
  it('a lowercase "benefits" inside the requirements does not open a boilerplate zone', () => {
    const flat = 'Backend Engineer. you understand the benefits of CI/CD and the perks of idempotency. Docker Kubernetes AWS. Benefits We offer free lunch.'
    const zones = ats.splitJdZones(flat)
    expect(zones.some(z => z.type === 'boiler' && /free lunch/.test(z.text))).toBe(true)
    expect(zones.some(z => z.type === 'boiler' && /Docker/.test(z.text))).toBe(false)
  })
  it('zones: company blurb and EEO are boilerplate, the role sections are requirements', () => {
    const z = ats.splitJdZones(JD)
    expect(z.find(x => /Acme Pay is a fast-growing/.test(x.text)).type).toBe('boiler')
    expect(z.find(x => /equal opportunity/.test(x.text)).type).toBe('boiler')
    expect(z.find(x => /Design and build scalable/.test(x.text)).type).toBe('req')
    expect(z.find(x => /5\+ years/.test(x.text)).type).toBe('req')
  })
  it('a JD that is ALL boilerplate still yields keywords (nothing to score against would be worse)', () => {
    const r = ats.scoreResume(RESUME, 'About Acme Pay\nAcme Pay builds payment infrastructure for merchants across several countries in Africa and beyond.')
    expect(r.detail.keywords.noKeywords).toBe(false)
  })
})

describe('G5 — fitJobDescription trims the intro, not the requirements', () => {
  it('leaves a posting that already fits exactly as pasted', () => {
    expect(ats.fitJobDescription(JD, 5000)).toBe(JD)
  })
  it('an over-long posting keeps the requirements and drops the company padding', () => {
    const long = 'About Acme Pay\n' + 'We are a company with a great culture and a long story to tell. '.repeat(150) + '\nRequirements\n- Node.js, TypeScript, PostgreSQL, Docker, AWS\n- 5 years of backend work\n'
    const fit = ats.fitJobDescription(long, 2000)
    expect(fit.length).toBeLessThanOrEqual(2000)
    expect(fit).toContain('Requirements')
    expect(fit).toContain('PostgreSQL')
    expect(fit.match(/great culture/g).length).toBeLessThan(15)
  })
  it('never returns less than something when everything is boilerplate', () => {
    const long = 'About Acme Pay\n' + 'We build payments for everyone. '.repeat(400)
    const fit = ats.fitJobDescription(long, 1000)
    expect(fit.length).toBeGreaterThan(100)
    expect(fit.length).toBeLessThanOrEqual(1000)
  })
})

describe('G4 — the designed PDF must still say what the resume says', () => {
  const pdfTemplate = require('../src/services/pdfTemplate.service.js')
  const data = {
    name: 'Jane Doe', email: 'j@x.com', phone: '+254 700 000 000', summary: 'Backend engineer with 6 years.',
    experience: [{ company: 'Acme Pay', title: 'Senior Engineer', dates: '2020 - Present', location: 'Nairobi', bullets: ['Built billing APIs serving 2M transactions a month', 'Cut query time by 40% on PostgreSQL schemas', 'Mentored 4 junior engineers on the team'] }],
    education: [{ institution: 'University of Nairobi', degree: 'BSc Computer Science', dates: '2013 - 2017' }],
    skills: ['Node.js', 'PostgreSQL', 'Docker', 'Kubernetes'], certifications: [], projects: [], languages: [], awards: [], publications: [], volunteer: [],
  }
  const url = 'https://passthrough.dev/v/AB12CD'
  const page = pdfTemplate.buildResumeHTML(data, {}, url, { verified: true })
  it('the deterministic template passes its own data (no false positives)', () => {
    expect(claude.checkHtmlFidelity(data, page, { verificationUrl: url })).toEqual({ ok: true, reasons: [] })
  })
  it('a dropped bullet is caught', () => {
    const r = claude.checkHtmlFidelity(data, page.replace('Mentored 4 junior engineers on the team', ''), { verificationUrl: url })
    expect(r.ok).toBe(false); expect(r.reasons.join(' ')).toMatch(/bullet/)
  })
  it('a changed figure is caught', () => {
    const r = claude.checkHtmlFidelity(data, page.replace('40%', '65%'), { verificationUrl: url })
    expect(r.ok).toBe(false); expect(r.reasons.join(' ')).toMatch(/65/)
  })
  it('a missing employer and a blank page are caught', () => {
    expect(claude.checkHtmlFidelity(data, page.replace(/Acme Pay/g, 'Somewhere Else')).ok).toBe(false)
    expect(claude.checkHtmlFidelity(data, '<html><body></body></html>').ok).toBe(false)
  })
  it('text inside <style>/<script> never counts as visible content', () => {
    const cheat = '<html><style>' + 'Acme Pay Senior Engineer Jane Doe '.repeat(20) + '</style><body>hi</body></html>'
    expect(claude.checkHtmlFidelity(data, cheat).ok).toBe(false)
  })
  it('never throws on junk input', () => {
    expect(() => claude.checkHtmlFidelity(null, undefined)).not.toThrow()
    expect(() => claude.checkHtmlFidelity({}, '<<<>>>')).not.toThrow()
  })
})

describe('B2 — the owner\'s own edit is the fabrication baseline', () => {
  const original = { name: 'Jane', experience: [{ company: 'Acme', title: 'Engineer', dates: '2019 - 2022', bullets: ['Reduced dashboard page load times'] }], skills: ['Node.js'] }
  const userEdited = { name: 'Jane', experience: [{ company: 'Acme', title: 'Engineer', dates: '2019 - 2022', bullets: ['Reduced dashboard page load times by 40%'] }], skills: ['Node.js', 'Redis'] }
  it('the guard that used to reject the owner\'s own figure and skill accepts them against the edit', () => {
    expect(claude.detectFabrication(original, userEdited)).toBe(true)
    expect(claude.detectFabrication(userEdited, userEdited)).toBe(false)
  })

  function fixSetup(scan) {
    const state = { updates: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: { id: 'u1', name: 'Jane', email: 'j@x.com' }, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q.patch); return { data: [{ id: 's1' }], error: null } }
      if (q.op === 'rpc') return { data: true, error: null }
    })
    const rewriteCalls = []
    const env = { RESUMES_BUCKET: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }), put: async () => {}, delete: async () => {} } }
    const loaded = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { extractText: async () => 'x'.repeat(150) },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('docx') },
      'services/ats.service.js': { scoreResume: () => ({ score: 70, detail: { keywords: { matched: ['a'], missing: ['b'] } } }), describeWeakAreas: () => ['weak'] },
      'services/claude.service.js': {
        rewriteResumeContent: async (...a) => { rewriteCalls.push(a); return { success: true, data: { name: 'Rewritten' }, quantificationOpportunities: [] } },
        generateBeautifulResumeHTML: async () => ({ success: false }),
        scoreResumeWithAI: async () => ({ success: false }), extractJson: s => JSON.parse(s),
      },
      'services/badge.service.js': { generateShortCode: async () => 'C', buildVerificationUrl: () => 'https://x/v/C', hashBytes: async () => 'h' },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/pdf.service.js': { generateResumePDF: async () => Buffer.from('pdf') },
      'services/email.service.js': { sendFixDelivered: async () => {}, sendFixDeliveredPlain: async () => {}, sendFixFailed: async () => {}, sendOwnerAlert: async () => {} },
    })
    return { ...loaded, state, db, env, rewriteCalls }
  }
  const base = { id: 's1', user_id: 'u1', input_mode: 'brain_dump', job_description_text: 'JD', fix_tier: 'FIX', fix_retry_count: 1, fix_ats_score: 60, verification_code: 'C', verification_url: 'https://x/v/C' }
  let t
  afterEach(() => t?.restore())

  it('a retry after an owner edit checks the rewrite against THEIR edit, not the upload', async () => {
    t = fixSetup({ ...base, original_resume_data: original, rewritten_resume_data: userEdited, user_edited_resume_data: userEdited })
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.rewriteCalls[0][1]).toEqual(userEdited)
    expect(t.rewriteCalls[0][4]).toEqual(userEdited)
  })
  it('with no owner edit the baseline is still the original upload', async () => {
    t = fixSetup({ ...base, original_resume_data: original, rewritten_resume_data: { name: 'R1' } })
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.rewriteCalls[0][4]).toEqual(original)
  })
  it('G3: the delivered file\'s score breakdown is persisted with the delivery', async () => {
    t = fixSetup({ ...base, fix_retry_count: 0, original_resume_data: original })
    await t.mod.generateFix(t.env, t.db, 's1')
    const done = t.state.updates.find(u => u.status === 'FIX_DELIVERED')
    expect(done.fix_ats_report).toBeTruthy()
    expect(done.fix_ats_report.keywords).toEqual({ matched: ['a'], missing: ['b'] })
    expect(done.fix_ats_report).toHaveProperty('aiMissingKeywords')
  })
})

describe('G1 — retryScan re-runs a failed scan in place', () => {
  function setup(opts = {}) {
    const state = { updates: [], rpcs: [], queued: [] }
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', status: 'ERROR', fix_purchased: false, input_mode: 'file', resume_path: 'r/1.pdf' }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q); return { data: opts.lostRace ? [] : [{ id: 's1' }], error: null } }
      if (q.op === 'rpc') { state.rpcs.push(q.name); return { data: q.name === 'increment_scan_count_if_under_limit' ? (opts.allowed ?? true) : true, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const env = { FIX_QUEUE: { send: async m => { state.queued.push(m) } } }
    return { mod, restore, state, env }
  }
  function ctx(env, over = {}) {
    return {
      env,
      get: k => (k === 'user' ? ('user' in over ? over.user : { id: 'u1' }) : undefined),
      req: { param: () => 's1', query: k => (over.query ?? {})[k], header: () => undefined },
      header: () => undefined,
      executionCtx: { waitUntil: () => {} },
      json: (body, status = 200) => ({ body, status }),
    }
  }
  let t
  afterEach(() => t?.restore())

  it('owner: spends a slot, flips ERROR -> PENDING (only while still failed + unpurchased) and queues the same scan', async () => {
    t = setup()
    const res = await t.mod.retryScan(ctx(t.env))
    expect(res.status).toBe(200)
    expect(t.state.rpcs).toContain('increment_scan_count_if_under_limit')
    const flip = t.state.updates[0]
    expect(flip.patch).toEqual({ status: 'PENDING', full_ats_report: null })
    expect(flip.filters.some(f => f[1] === 'status' && f[2] === 'ERROR')).toBe(true)
    expect(flip.filters.some(f => f[1] === 'fix_purchased' && f[2] === false)).toBe(true)
    expect(t.state.queued).toHaveLength(1)
    expect(t.state.queued[0]).toMatchObject({ type: 'runAtsScan', scanId: 's1', anonToken: null })
  })
  it('refuses a scan that is not failed, was purchased, or is not yours — and spends nothing', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false, resume_path: 'k' } })
    expect((await t.mod.retryScan(ctx(t.env))).status).toBe(400)
    t.restore(); t = setup({ scan: { id: 's1', user_id: 'u1', status: 'ERROR', fix_purchased: true, resume_path: 'k' } })
    expect((await t.mod.retryScan(ctx(t.env))).status).toBe(400)
    t.restore(); t = setup()
    expect((await t.mod.retryScan(ctx(t.env, { user: { id: 'someone-else' } }))).status).toBe(403)
    expect(t.state.rpcs).toEqual([])
    expect(t.state.queued).toEqual([])
  })
  it('410 when nothing is left to run on', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'ERROR', fix_purchased: false, input_mode: 'brain_dump', resume_path: null, original_resume_data: null, raw_brain_dump_text: null } })
    expect((await t.mod.retryScan(ctx(t.env))).status).toBe(410)
  })
  it('429 when the daily quota is used up', async () => {
    t = setup({ allowed: false })
    expect((await t.mod.retryScan(ctx(t.env))).status).toBe(429)
    expect(t.state.queued).toEqual([])
  })
  it('losing the race hands the slot back and answers 409', async () => {
    t = setup({ lostRace: true })
    const res = await t.mod.retryScan(ctx(t.env))
    expect(res.status).toBe(409)
    expect(t.state.rpcs).toContain('decrement_scan_count')
    expect(t.state.queued).toEqual([])
  })
  it('anonymous: works with the scan\'s token, forwards it for the recovery email, and spends no account slot', async () => {
    const row = { id: 's1', user_id: null, status: 'ERROR', fix_purchased: false, input_mode: 'brain_dump', raw_brain_dump_text: 'my background', anon_token: sha256hex('tok'), anon_expires_at: new Date(Date.now() + 3600e3).toISOString(), contact_email: 'a@b.co' }
    t = setup({ scan: row })
    const res = await t.mod.retryScan(ctx(t.env, { user: undefined, query: { token: 'tok' } }))
    expect(res.status).toBe(200)
    expect(t.state.rpcs).toEqual([])
    expect(t.state.queued[0]).toMatchObject({ type: 'runAtsScan', anonToken: 'tok' })
    t.restore(); t = setup({ scan: row })
    expect((await t.mod.retryScan(ctx(t.env, { user: undefined, query: { token: 'wrong' } }))).status).toBe(403)
  })
})

describe('G2 — structureResume scores the formatted file before anything is bought', () => {
  function setup(opts = {}) {
    const state = { updates: [] }
    const scan = { id: 's1', user_id: 'u1', input_mode: 'file', status: 'COMPLETE_FAIL', resume_path: 'r/1.pdf', resume_mime_type: 'application/pdf', fix_purchased: false, original_resume_data: opts.structured ?? null, job_description_text: 'JD', full_ats_report: { keywords: { matched: [], missing: [] }, ...(opts.report || {}) } }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q.patch); return { data: [{ id: 's1' }], error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { parse: async () => ({ resumeData: { name: 'Jane Doe', skills: ['Python'] }, parseError: false }), extractText: async () => 'x'.repeat(200) },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('docx') },
      'services/ats.service.js': { scoreResume: () => ({ score: opts.rule ?? 72, detail: { keywords: { matched: ['a'], missing: [] } } }) },
      'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: false }), extractJson: s => JSON.parse(s) },
    })
    const env = { RESUMES_BUCKET: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }) } }
    return { mod, restore, state, env }
  }
  function ctx(env) {
    return { env, get: k => (k === 'user' ? { id: 'u1' } : undefined), req: { param: () => 's1', query: () => undefined }, json: (b, s = 200) => ({ body: b, status: s }) }
  }
  let t
  afterEach(() => t?.restore())

  it('returns and persists the formatted score alongside the structure', async () => {
    t = setup({ rule: 72 })
    const res = await t.mod.structureResume(ctx(t.env))
    expect(res.status).toBe(200)
    expect(res.body.data.formattedScore).toBe(72)
    expect(res.body.data.atsDetail.formattedScore).toBe(72)
    const patch = t.state.updates[0]
    expect(patch.original_resume_data.name).toBe('Jane Doe')
    expect(patch.full_ats_report.formattedScore).toBe(72)
  })
  it('an already-structured scan with no formatted score gets one computed (and stored) without re-parsing', async () => {
    t = setup({ structured: { name: 'Stored', skills: ['Go'] }, rule: 85 })
    const res = await t.mod.structureResume(ctx(t.env))
    expect(res.body.data.formattedScore).toBe(85)
    expect(t.state.updates[0]).not.toHaveProperty('original_resume_data')
    expect(t.state.updates[0].full_ats_report.formattedScore).toBe(85)
  })
  it('a stored formatted score is returned as-is: no recompute, no write', async () => {
    t = setup({ structured: { name: 'Stored' }, report: { formattedScore: 79 } })
    const res = await t.mod.structureResume(ctx(t.env))
    expect(res.body.data.formattedScore).toBe(79)
    expect(t.state.updates).toEqual([])
  })
})

describe('B6 — a failed run must not clobber a finished scan', () => {
  function setup(opts = {}) {
    const state = { updates: [], refunds: 0 }
    const scan = { id: 's1', input_mode: 'file', resume_path: 'k', resume_mime_type: 'application/pdf', job_description_text: 'JD', user_id: 'u1', created_at: new Date().toISOString() }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') {
        state.updates.push(q)
        if (q.patch?.status === 'ERROR') return { data: opts.alreadyFinished ? [] : [{ id: 's1' }], error: null }
        return { data: [{ id: 's1' }], error: null }
      }
      if (q.op === 'rpc' && q.name === 'decrement_scan_count') { state.refunds++; return { data: true, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { extractText: async () => { throw new Error('boom') } },
    })
    return { mod, restore, state, db, env: { RESUMES_BUCKET: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }) } } }
  }
  let t
  afterEach(() => t?.restore())

  it('a throw while the scan is still running fails it (guarded to PENDING/SCANNING) and hands the slot back', async () => {
    t = setup()
    const out = await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(out.success).toBe(false)
    const err = t.state.updates.find(u => u.patch?.status === 'ERROR')
    expect(err.filters.find(f => f[0] === 'in' && f[1] === 'status')[2]).toEqual(['PENDING', 'SCANNING'])
    expect(t.state.refunds).toBe(1)
  })
  it('a throw AFTER the scan already finished changes nothing and refunds nothing', async () => {
    t = setup({ alreadyFinished: true })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.refunds).toBe(0)
  })
})
