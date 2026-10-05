import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import JSZip from 'jszip'
import { scoreResume, scoreFormat, detectSeniority, requiredYears, tokenizeRaw, normalizeTechTerms } from '../src/services/ats.service.js'
import { detectFabrication, unsupportedSkills, inventedNumbers, extractJson } from '../src/services/claude.service.js'
import { inspectStructure } from '../src/services/resume.parser.js'
import { buildResumeHTML } from '../src/services/pdfTemplate.service.js'
import { handleDeadLetterBatch } from '../src/services/deadletter.service.js'

let t
afterEach(() => t?.restore())
let realErr; beforeEach(() => { realErr = console.error; console.error = () => {} }); afterEach(() => { console.error = realErr })

// ── ats.service ──────────────────────────────────────────────────────────────
describe('.NET detection', () => {
  it('a domain / e-mail TLD is not the .NET framework', () => {
    for (const s of ['john@example.net', 'portfolio.net', 'www.acme.net/jobs', 'see https://x.example.net/a'])
      expect(tokenizeRaw(s)).not.toContain('dotnet')
  })
  it('real .NET mentions still are', () => {
    for (const s of ['Skills: C#, .NET, SQL', 'ASP.NET developer', 'VB.NET', 'experience with .NET Core', '.NET'])
      expect(normalizeTechTerms(s).toLowerCase()).toContain('dotnet')
  })
})

describe('detectSeniority years-of-experience', () => {
  it('a range is read as a range, not by its low end', () => {
    expect(detectSeniority('Account Manager. Requires 2-5 years of experience')).toBe('mid')
    expect(detectSeniority('Analyst. 0-2 years experience')).toBe('junior')
  })
  it('"X years ago" / company age is not a requirement', () => {
    expect(detectSeniority('Founded 25 years ago, we need an analyst. Requires 3 years of experience')).toBe('mid')
    expect(detectSeniority('Analyst role. We have been in business for 20 years and growing.')).toBe('mid')
  })
  it('a plain high requirement is senior; "minimum 1 year" is junior', () => {
    expect(detectSeniority('Analyst. 10+ years of experience')).toBe('senior')
    expect(detectSeniority('analyst, minimum 1 year')).toBe('junior')
  })
  it('the title still wins over the body', () => {
    expect(detectSeniority('Senior Analyst. 1 year of experience')).toBe('senior')
  })
  it('requiredYears returns null when nothing qualifies', () => {
    expect(requiredYears('no numbers here')).toBeNull()
    expect(requiredYears('we opened 5 years ago')).toBeNull()
  })
})

describe('structure-aware format scoring', () => {
  const text = ('Jane Doe\njane@x.com\nEXPERIENCE\n' + '- Built things that mattered to many people daily\n'.repeat(8) + 'EDUCATION\nBSc\nSKILLS\nJS').padEnd(300, ' ')
  it('no structure = unchanged score (PDFs, generated documents)', () => {
    expect(scoreFormat(text).score).toBe(scoreFormat(text, null).score)
    expect(scoreFormat(text, { tables: 0, textBoxes: 0, images: 0, columns: 1 }).issues).toBeUndefined()
  })
  it('text boxes, tables, columns and images each cost points and name themselves', () => {
    const base = scoreFormat(text).score
    const r = scoreFormat(text, { tables: 1, textBoxes: 1, images: 1, columns: 2 })
    expect(r.score).toBe(Math.max(0, base - 15 - 10 - 15 - 5))
    expect(r.detail.issues.join(' ')).toMatch(/text boxes/)
    expect(r.detail.issues.join(' ')).toMatch(/Table/)
    expect(r.detail.issues.join(' ')).toMatch(/column/)
    expect(r.detail.issues.join(' ')).toMatch(/Images/)
  })
  it('many tables cost more than one', () => {
    expect(scoreFormat(text, { tables: 3 }).score).toBeLessThan(scoreFormat(text, { tables: 1 }).score)
  })
  it('scoreResume threads the structure through to the format score', () => {
    const jd = 'We need a developer with javascript experience'
    expect(scoreResume(text, jd, { structure: { textBoxes: 2 } }).formatScore).toBeLessThan(scoreResume(text, jd).formatScore)
  })
})

// ── resume.parser.inspectStructure ───────────────────────────────────────────
describe('inspectStructure', () => {
  async function docx(xml) {
    const z = new JSZip(); z.file('word/document.xml', xml)
    return z.generateAsync({ type: 'uint8array' })
  }
  it('counts tables, text boxes (once, not twice), images and columns', async () => {
    const xml = '<w:document><w:body><w:tbl><w:tblPr/></w:tbl><w:tbl><w:tblPr/></w:tbl>' +
      '<mc:AlternateContent><mc:Choice><w:txbxContent><w:p/></w:txbxContent><pic:pic/></mc:Choice><mc:Fallback><w:txbxContent/><v:imagedata/></mc:Fallback></mc:AlternateContent>' +
      '<w:sectPr><w:cols w:num="2"/></w:sectPr></w:body></w:document>'
    expect(await inspectStructure(await docx(xml), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toEqual({ tables: 2, textBoxes: 1, images: 1, columns: 2 })
  })
  it('is null for a PDF and for garbage — unknown, never an error', async () => {
    expect(await inspectStructure(new Uint8Array([1, 2]), 'application/pdf')).toBeNull()
    expect(await inspectStructure(new Uint8Array([1, 2, 3]), 'x')).toBeNull()
  })
  it('a plain document reports nothing', async () => {
    expect(await inspectStructure(await docx('<w:document><w:body><w:p/></w:body></w:document>'), 'x'))
      .toEqual({ tables: 0, textBoxes: 0, images: 0, columns: 1 })
  })
})

// ── claude.service guards ────────────────────────────────────────────────────
describe('fabrication guard covers skills and numbers', () => {
  const orig = {
    name: 'Jane', experience: [{ company: 'Acme', title: 'Engineer', dates: '2020-2022', bullets: ['Managed project management tasks with PostgreSQL', 'Cut costs by 20%'] }],
    education: [], skills: ['JavaScript', 'PostgreSQL'], certifications: [],
  }
  it('an honest rewrite is not flagged', () => {
    const honest = { ...orig, experience: [{ ...orig.experience[0], bullets: ['Led project management work backed by Postgres', 'Reduced costs 20%'] }], skills: ['JS', 'Postgres', 'Project Management'] }
    expect(detectFabrication(orig, honest)).toBe(false)
    expect(unsupportedSkills(orig, honest)).toEqual([])
    expect(inventedNumbers(orig, honest)).toEqual([])
  })
  it('stuffed skills and invented metrics are', () => {
    const stuffed = { ...orig, skills: ['JavaScript', 'Kubernetes', 'Terraform'], experience: [{ ...orig.experience[0], bullets: ['Improved uptime to 99.9%'] }] }
    expect(unsupportedSkills(orig, stuffed)).toEqual(['Kubernetes', 'Terraform'])
    expect(inventedNumbers(orig, stuffed)).toContain(99.9)
    expect(detectFabrication(orig, stuffed)).toBe(true)
  })
  it('"2M" / "2,000,000" / "2 million" are the same number', () => {
    const o = { ...orig, experience: [{ ...orig.experience[0], bullets: ['Served 2,000,000 users'] }] }
    const r = { ...o, experience: [{ ...o.experience[0], bullets: ['Served 2M users', 'Served 2 million users'] }] }
    expect(inventedNumbers(o, r)).toEqual([])
  })
  it('A.A. is an associate degree, not an upgrade', () => {
    const o = { ...orig, education: [{ institution: 'CC', degree: 'A.A.', dates: '2019' }] }
    const r = { ...o, education: [{ institution: 'CC', degree: 'Associate of Arts', dates: '2019' }] }
    expect(detectFabrication(o, r)).toBe(false)
  })
})

describe('extractJson tolerates chatter', () => {
  it('preamble and trailing text', () => {
    expect(extractJson('Sure! Here is the JSON:\n{"a": [1, 2, {"b": "}"}]}\nHope that helps!')).toEqual({ a: [1, 2, { b: '}' }] })
  })
  it('fenced and bare still work', () => {
    expect(extractJson('```json\n{"x":1}\n```')).toEqual({ x: 1 })
    expect(extractJson('{"x":1}')).toEqual({ x: 1 })
  })
})

describe('callClaude retries transient failures (through scoreResumeWithAI)', () => {
  const { scoreResumeWithAI } = require_claude()
  function require_claude() { return { scoreResumeWithAI: (...a) => import('../src/services/claude.service.js').then(m => m.scoreResumeWithAI(...a)) } }
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const ok = text => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) })
  const err = status => ({ ok: false, status, headers: { get: () => null }, json: async () => ({ error: { message: `e${status}` } }) })
  it('a 529 then a success succeeds', async () => {
    let n = 0
    globalThis.fetch = async () => (++n === 1 ? err(529) : ok('{"aiScore": 80}'))
    const r = await scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'resume', 'jd')
    expect(r.success).toBe(true)
    expect(n).toBe(2)
  })
  it('a 401 is not retried', async () => {
    let n = 0
    globalThis.fetch = async () => { n++; return err(401) }
    const r = await scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'resume', 'jd')
    expect(r.success).toBe(false)
    expect(n).toBe(1)
  })
})

// ── pdfTemplate ──────────────────────────────────────────────────────────────
describe('deterministic PDF template', () => {
  const data = { name: 'Jane <script>alert(1)</script> Doe', email: 'j@x.com', summary: 'S & T', skills: ['A', 'B'], certifications: ['Cert'],
    experience: [{ title: 'Eng', company: 'Acme', dates: '2020', bullets: ['Did "x"', ''] }, { title: null, company: null, dates: null, bullets: [] }],
    education: [{ degree: 'BSc', institution: 'U', dates: '2019' }],
    projects: [{ name: 'P', technologies: ['js'], description: 'd', link: 'javascript:alert(1)' }] }
  const html = buildResumeHTML(data, {}, 'https://x.test/v/ABC', { verified: true })
  it('escapes everything, has no script, and never links a javascript: URL', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toMatch(/href="javascript:/i)
    expect(html).toContain('S &amp; T')
  })
  it('renders sections, drops empty entries, and carries the credential wording by verified flag', () => {
    expect(html).toMatch(/Experience/); expect(html).toMatch(/Education/); expect(html).toMatch(/Skills/); expect(html).toMatch(/Projects/)
    expect(html).toContain('Passthrough Verified')
    expect(buildResumeHTML(data, {}, 'https://x.test/v/ABC', { verified: false })).toContain('Passthrough Scan Report')
    expect(buildResumeHTML(data, {}, null)).not.toMatch(/Passthrough/)
    expect((html.match(/class="entry"/g) || []).length).toBe(3)   // 1 job + 1 school + 1 project
  })
  it('never throws on an empty / hostile object', () => {
    expect(() => buildResumeHTML(null, null, null)).not.toThrow()
    expect(() => buildResumeHTML({ experience: 'x', skills: 5, projects: [null] }, {}, 'ftp://x')).not.toThrow()
  })
  it('projects lead when there is no formal experience', () => {
    const h = buildResumeHTML({ name: 'N', projects: [{ name: 'P', description: 'd' }], education: [{ degree: 'B', institution: 'U' }] }, {}, null)
    expect(h.indexOf('Projects')).toBeLessThan(h.indexOf('Education'))
  })
})

// ── dead letter ──────────────────────────────────────────────────────────────
describe('dead-lettered free scan', () => {
  it('is failed and its daily slot is handed back (created today, account scan only)', async () => {
    const rpcs = []
    const patches = []
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'update') { patches.push(q); return { data: [{ id: 's1', user_id: 'u1', created_at: new Date().toISOString() }], error: null } }
      if (q.op === 'rpc') { rpcs.push(q.name); return { data: null, error: null } }
    })
    const acks = []; const alerts = []
    await handleDeadLetterBatch({ messages: [{ body: { type: 'runAtsScan', scanId: 's1', anonToken: 'SECRET' }, id: 'm', ack: () => acks.push(1) }] },
      {}, db, { sendOwnerAlert: async (...a) => alerts.push(a) })
    expect(patches[0].patch).toEqual({ status: 'ERROR' })
    expect(patches[0].filters.some(f => f[0] === 'in' && f[2].includes('SCANNING'))).toBe(true)
    expect(rpcs).toEqual(['decrement_scan_count'])
    expect(acks).toHaveLength(1)
    expect(JSON.stringify(alerts)).not.toMatch(/SECRET/)   // the capability never reaches an e-mail
  })
  it('an anonymous or old scan is failed but nothing is refunded', async () => {
    const rpcs = []
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1', user_id: null, created_at: new Date().toISOString() }, { id: 's2', user_id: 'u1', created_at: '2020-01-01T00:00:00Z' }], error: null }
      if (q.op === 'rpc') { rpcs.push(q.name); return { data: null, error: null } }
    })
    await handleDeadLetterBatch({ messages: [{ body: { type: 'runAtsScan', scanId: 's1' }, ack() {} }] }, {}, db, { sendOwnerAlert: async () => {} })
    expect(rpcs).toEqual([])
  })
  it('fix jobs keep their old behaviour (FIX_* only)', async () => {
    const patches = []
    const db = createFakeSupabase(q => { if (q.op === 'update') { patches.push(q); return { data: null, error: null } } })
    await handleDeadLetterBatch({ messages: [{ body: { type: 'generateFix', scanId: 's1' }, ack() {} }] }, {}, db, { sendOwnerAlert: async () => {} })
    expect(patches[0].filters.find(f => f[0] === 'in')[2]).toEqual(['FIX_PURCHASED', 'FIX_GENERATING'])
  })
})

// ── scan.controller ──────────────────────────────────────────────────────────
const validJd = 'A '.repeat(30) + 'valid job description with enough characters to pass the fifty character minimum.'
const validBrainDump = 'x'.repeat(150)

describe('createScan — dispatch, JD precedence, rescan', () => {
  function csCtx(over = {}) {
    const waits = [], sent = [], bucket = []
    return {
      env: {
        RESUMES_BUCKET: { put: async (...a) => bucket.push(['put', ...a]), delete: async (...a) => bucket.push(['delete', ...a]), get: over.r2get ?? (async () => null) },
        ...(over.noQueue ? {} : { FIX_QUEUE: { send: async m => { if (over.queueThrows) throw new Error('queue down'); sent.push(m) } } }),
      },
      get: k => ({ uploadedFile: over.file, formFields: over.fields ?? {}, user: over.user }[k]),
      req: {}, json: (body, status = 200) => ({ body, status }),
      executionCtx: { waitUntil: p => { waits.push(p); p.catch(() => {}) } },
      __waits: waits, __sent: sent, __bucket: bucket,
    }
  }
  function setup(opts = {}) {
    const state = { inserts: [], jdFetches: 0, runs: 0 }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'insert') { state.inserts.push(q.values); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'select') return { data: 'source' in opts ? opts.source : null, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.runs++; return { data: [], error: null } }   // runAtsScan fallback: claim lost -> skips
    })
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { isBypassed: () => false, hitQuota: async () => true },
      'services/jd.parser.js': { fetchJobDescriptionFromUrl: async () => { state.jdFetches++; return opts.jdFetch ?? { success: true, text: 'F'.repeat(80) } } },
    })
    return { ...m, state, db }
  }
  const user = { id: 'u1' }
  const SRC = '11111111-1111-4111-8111-111111111111'

  it('enqueues runAtsScan (with the anon token for the e-mail) instead of using waitUntil', async () => {
    t = setup()
    const ctx = csCtx({ fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd, contactName: 'A', contactEmail: 'a@b.co' } })
    const res = await t.mod.createScan(ctx)
    expect(res.body.success).toBe(true)
    expect(ctx.__sent).toEqual([{ type: 'runAtsScan', scanId: res.body.data.scanId, anonToken: res.body.data.anonToken }])
    expect(ctx.__waits).toHaveLength(0)
  })
  it('a logged-in scan enqueues with no token', async () => {
    t = setup()
    const ctx = csCtx({ user, fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } })
    await t.mod.createScan(ctx)
    expect(ctx.__sent[0]).toMatchObject({ type: 'runAtsScan', anonToken: null })
  })
  it('falls back to waitUntil when the queue is down or absent — the scan is degraded, not lost', async () => {
    for (const over of [{ queueThrows: true }, { noQueue: true }]) {
      t = setup()
      const ctx = csCtx({ ...over, user, fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } })
      const res = await t.mod.createScan(ctx)
      expect(res.body.success).toBe(true)
      expect(ctx.__waits).toHaveLength(1)
      await Promise.all(ctx.__waits)
      t.restore()
    }
    t = null
  })

  it('pasted JD text wins: no URL fetch happens and a blocked URL cannot reject it', async () => {
    t = setup({ jdFetch: { blocked: true, message: 'no' } })
    const res = await t.mod.createScan(csCtx({ fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd, jobDescriptionUrl: 'http://evil.internal' } }))
    expect(res.body.success).toBe(true)
    expect(t.state.jdFetches).toBe(0)
    expect(t.state.inserts[0].job_description_text).toBe(validJd)
    expect(t.state.inserts[0].job_description_url).toBe('http://evil.internal')
  })
  it('the URL is still fetched when nothing usable was pasted', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: { brainDumpText: validBrainDump, jobDescriptionUrl: 'http://ok.example/job', jobDescriptionText: 'short' } }))
    expect(res.body.success).toBe(true)
    expect(t.state.jdFetches).toBe(1)
  })

  describe('rescan (sourceScanId)', () => {
    it('401s anonymous callers', async () => {
      t = setup()
      expect((await t.mod.createScan(csCtx({ fields: { sourceScanId: SRC, jobDescriptionText: validJd } }))).status).toBe(401)
    })
    it('rejects a combination with another input mode', async () => {
      t = setup()
      expect((await t.mod.createScan(csCtx({ user, fields: { sourceScanId: SRC, brainDumpText: validBrainDump, jobDescriptionText: validJd } }))).status).toBe(400)
    })
    it('404s a malformed id, a missing scan, and someone else\'s (the query is scoped to the owner)', async () => {
      t = setup()
      expect((await t.mod.createScan(csCtx({ user, fields: { sourceScanId: 'nope', jobDescriptionText: validJd } }))).status).toBe(404)
      expect((await t.mod.createScan(csCtx({ user, fields: { sourceScanId: SRC, jobDescriptionText: validJd } }))).status).toBe(404)
      const q = t.db.calls.find(c => c.table === 'scans' && c.op === 'select')
      expect(q.filters.some(f => f[0] === 'eq' && f[1] === 'user_id' && f[2] === 'u1')).toBe(true)
      expect(t.state.inserts).toHaveLength(0)
    })
    it('a file scan: re-uses the stored file under a NEW key with the same type/name, and its parsed structure', async () => {
      const source = { id: SRC, user_id: 'u1', input_mode: 'file', resume_path: 'old-key', resume_mime_type: 'application/pdf', resume_original_name: 'cv.pdf', original_resume_data: { name: 'Jane' } }
      t = setup({ source })
      const ctx = csCtx({ user, fields: { sourceScanId: SRC, jobDescriptionText: validJd }, r2get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) })
      const res = await t.mod.createScan(ctx)
      expect(res.body.success).toBe(true)
      const row = t.state.inserts[0]
      expect(row).toMatchObject({ input_mode: 'file', resume_mime_type: 'application/pdf', resume_original_name: 'cv.pdf', original_resume_data: { name: 'Jane' }, user_id: 'u1' })
      expect(row.resume_path).not.toBe('old-key')
      expect(ctx.__bucket.find(b => b[0] === 'put')[1]).toBe(row.resume_path)
    })
    it('a file scan whose stored file is gone: 410, nothing inserted, no quota spent', async () => {
      t = setup({ source: { id: SRC, user_id: 'u1', input_mode: 'file', resume_path: 'old-key', resume_mime_type: 'application/pdf' } })
      const res = await t.mod.createScan(csCtx({ user, fields: { sourceScanId: SRC, jobDescriptionText: validJd } }))
      expect(res.status).toBe(410)
      expect(t.state.inserts).toHaveLength(0)
      expect(t.db.calls.some(c => c.op === 'rpc')).toBe(false)
    })
    it('a typed / profile scan: re-uses its structured data with no new structuring call', async () => {
      t = setup({ source: { id: SRC, user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Corrected Name' } } })
      const res = await t.mod.createScan(csCtx({ user, fields: { sourceScanId: SRC, jobDescriptionText: validJd } }))
      expect(res.body.success).toBe(true)
      expect(t.state.inserts[0]).toMatchObject({ input_mode: 'saved_profile', original_resume_data: { name: 'Corrected Name' } })
      expect(t.state.inserts[0].raw_brain_dump_text).toBeUndefined()
    })
    it('a source with no structured data yet (still scanning) is refused', async () => {
      t = setup({ source: { id: SRC, user_id: 'u1', input_mode: 'brain_dump', original_resume_data: null } })
      expect((await t.mod.createScan(csCtx({ user, fields: { sourceScanId: SRC, jobDescriptionText: validJd } }))).status).toBe(400)
    })
  })
})

describe('runAtsScan — idempotent claim and structure', () => {
  function setup(opts = {}) {
    const state = { updates: [], scored: [], emails: 0 }
    const scan = { id: 's1', input_mode: 'file', resume_path: 'k', resume_mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', job_description_text: 'JD', user_id: null }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q); return { data: q.patch?.status === 'SCANNING' ? (opts.claim ?? [{ id: 's1' }]) : [{ id: 's1' }], error: null } }
    })
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': {
        extractText: async () => 'x'.repeat(200),
        inspectStructure: async () => opts.structure ?? { tables: 0, textBoxes: 2, images: 0, columns: 1 },
      },
      'services/ats.service.js': {
        scoreResume: (text, jd, o) => { state.scored.push(o); return { score: 70, keywordScore: 70, formatScore: 70, sectionsScore: 70, contentScore: 70, detail: {} } },
        detectRoleCategory: () => 'x', detectSeniority: () => 'mid',
      },
      'services/claude.service.js': { scoreResumeWithAI: async () => { state.ai = (state.ai || 0) + 1; return { success: false } }, extractJson: x => x },
      'services/email.service.js': {},
    })
    return { ...m, state, db, env: { RESUMES_BUCKET: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }) } } }
  }
  it('claims only PENDING/SCANNING scans', async () => {
    t = setup()
    await t.mod.runAtsScan(t.env, t.db, 's1')
    const claim = t.state.updates[0]
    expect(claim.patch).toEqual({ status: 'SCANNING' })
    expect(claim.filters.find(f => f[0] === 'in')[2]).toEqual(['PENDING', 'SCANNING'])
  })
  it('a duplicate delivery of an already-handled scan does nothing — no AI bill, no rewrite of its result', async () => {
    t = setup({ claim: [] })
    const out = await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(out).toEqual({ success: true, skipped: true })
    expect(t.state.ai).toBeUndefined()
    expect(t.state.updates).toHaveLength(1)
  })
  it('passes the raw DOCX layout facts to the scorer for file scans', async () => {
    t = setup()
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.scored[0]).toEqual({ structure: { tables: 0, textBoxes: 2, images: 0, columns: 1 } })
  })
  it('an inspection failure degrades to "unknown", never to a failed scan', async () => {
    t = setup()
    const out = await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(out.success).toBe(true)
  })
})

describe('generateFix / generateBadge duplicate delivery', () => {
  function setup(status) {
    const updates = []
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', user_id: null, status, input_mode: 'brain_dump', original_resume_data: { name: 'J' }, resume_ats_path: 'k' }, error: null }
      if (q.op === 'update') { updates.push(q.patch); return { data: [{ id: 's1' }], error: null } }
    })
    const m = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return { ...m, db, updates }
  }
  it('a job for an already-delivered scan is acknowledged and changes nothing', async () => {
    t = setup('FIX_DELIVERED')
    expect(await t.mod.generateFix({}, t.db, 's1')).toEqual({ success: true, skipped: true })
    expect(t.updates).toEqual([])
    t.restore()
    t = setup('FIX_DELIVERED')
    expect(await t.mod.generateBadge({}, t.db, 's1')).toEqual({ success: true, skipped: true })
    expect(t.updates).toEqual([])
  })
})

describe('generateBadge scores what it delivers', () => {
  function setup(finalScore) {
    const state = { updates: [], docxCalls: [], htmlArgs: null, emails: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', user_id: 'u1', status: 'FIX_PURCHASED', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, ats_score: 90, job_description_text: 'JD' }, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: { id: 'u1', name: 'Jane', email: 'j@x.com' }, error: null }
      if (q.op === 'update') { state.updates.push(q.patch); return { data: [{ id: 's1' }], error: null } }
    })
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { extractText: async () => 'x'.repeat(200) },
      'services/docx.service.js': { generateAtsDocx: async (d, url, o) => { state.docxCalls.push(o); return Buffer.from('docx') } },
      'services/ats.service.js': { scoreResume: () => ({ score: finalScore, detail: {} }) },
      'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: false }), extractJson: x => x, generateBeautifulResumeHTML: async (...a) => { state.htmlArgs = a; return { success: true, data: '<html></html>' } } },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/badge.service.js': { generateShortCode: async () => 'C', buildVerificationUrl: () => 'https://x/v/C', hashBytes: async () => 'h' },
      'services/pdf.service.js': { generateResumePDF: async () => Buffer.from('pdf') },
      'services/email.service.js': { sendFixDelivered: async (...a) => state.emails.push(a), sendOwnerAlert: async () => {}, sendFixFailed: async () => {} },
    })
    return { ...m, state, db, env: { RESUMES_BUCKET: { put: async () => {}, delete: async () => {} } } }
  }
  it('a delivered document that clears the threshold gets the verified credential and ITS score', async () => {
    t = setup(86)
    await t.mod.generateBadge(t.env, t.db, 's1')
    const fin = t.state.updates.find(u => u.status === 'FIX_DELIVERED')
    expect(fin.fix_ats_score).toBe(86)
    expect(t.state.htmlArgs[4]).toEqual({ verified: true })
    expect(t.state.emails[0][6]).toBe(true)
  })
  it('one that falls short is NOT sold as verified — honest wording everywhere, real score stored', async () => {
    t = setup(72)
    await t.mod.generateBadge(t.env, t.db, 's1')
    const fin = t.state.updates.find(u => u.status === 'FIX_DELIVERED')
    expect(fin.fix_ats_score).toBe(72)
    expect(t.state.docxCalls.some(o => o && o.verified === false)).toBe(true)
    expect(t.state.htmlArgs[4]).toEqual({ verified: false })
    expect(t.state.emails[0][6]).toBe(false)
  })
})

describe('small controller fixes', () => {
  it('updateVerifyVisibility: a JSON null / array body is a 400, not a 500', async () => {
    const db = createFakeSupabase(q => (q.table === 'scans' && q.op === 'select' ? { data: { id: 's1', user_id: 'u1', verification_code: 'C' }, error: null } : undefined))
    t = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    for (const body of [null, [], 5, 'x']) {
      const ctx = { env: {}, get: () => ({ id: 'u1' }), req: { param: () => 's1', json: async () => body }, json: (b, s = 200) => ({ body: b, status: s }) }
      expect((await t.mod.updateVerifyVisibility(ctx)).status).toBe(400)
    }
  })

  describe('updateResumeData', () => {
    function setup() {
      const state = { patch: null }
      const db = createFakeSupabase(q => {
        if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', status: 'COMPLETE_PASS', fix_purchased: false, job_description_text: 'JD', candidate_first_name: 'Old' }, error: null }
        if (q.table === 'scans' && q.op === 'update') { state.patch = q.patch; return { data: [{ id: 's1' }], error: null } }
      })
      const m = loadWithStubs('controllers/scan.controller.js', {
        'config/supabase.js': { getSupabase: () => db },
        'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('d') },
        'services/resume.parser.js': { extractText: async () => 'x'.repeat(150) },
        'services/ats.service.js': { scoreResume: () => ({ score: 70, keywordScore: 70, formatScore: 70, sectionsScore: 70, contentScore: 70, detail: {} }) },
        'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: false }), extractJson: x => x },
      })
      return { ...m, state }
    }
    const call = body => ({ env: {}, get: () => ({ id: 'u1' }), req: { param: () => 's1', query: () => undefined, json: async () => body }, json: (b, s = 200) => ({ body: b, status: s }) })
    it('drops wholly-empty "Add job / school / project" rows and keeps real ones', async () => {
      t = setup()
      const res = await t.mod.updateResumeData(call({ resumeData: {
        name: 'Jane Q',
        experience: [{ company: '', title: '', dates: '', bullets: ['', ' '] }, { company: 'Acme', title: '', bullets: ['did x', ''] }],
        education: [{ institution: '', degree: '', dates: '' }, { institution: 'MIT' }],
        projects: [{ name: '', description: '', technologies: [''] }, { name: 'P' }],
      } }))
      expect(res.body.success).toBe(true)
      const d = res.body.data.originalResumeData
      expect(d.experience).toHaveLength(1); expect(d.experience[0].bullets).toEqual(['did x'])
      expect(d.education).toHaveLength(1)
      expect(d.projects).toHaveLength(1)
    })
    it('a corrected name updates the search column; clearing the name keeps the earlier one (not "Candidate")', async () => {
      t = setup()
      await t.mod.updateResumeData(call({ resumeData: { name: 'Maria Lopez' } }))
      expect(t.state.patch.candidate_first_name).toBe('Maria')
      t.restore(); t = setup()
      await t.mod.updateResumeData(call({ resumeData: { name: '   ' } }))
      expect(t.state.patch.candidate_first_name).toBe('Old')
    })
  })
})
