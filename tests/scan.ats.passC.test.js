import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const sha256hex = s => createHash('sha256').update(s).digest('hex')

// Scan / ATS pass: regressions for what the second independent audit found and closed.

// ─── upload middleware: the REAL one (the controller tests mock formFields, which is how the
//     rescan field going missing here was never caught) ───────────────────────────────────────
describe('upload middleware — rescan field', () => {
  it('passes sourceScanId through to the controller', async () => {
    const { Hono } = require('hono')
    const upload = require('../src/middleware/upload.js')
    const app = new Hono()
    app.post('/', upload, c => c.json({ fields: c.get('formFields') }))
    const fd = new FormData()
    fd.append('sourceScanId', '11111111-1111-4111-8111-111111111111')
    fd.append('jobDescriptionText', 'x'.repeat(60))
    const res = await app.request('/', { method: 'POST', body: fd })
    expect(res.status).toBe(200)
    expect((await res.json()).fields.sourceScanId).toBe('11111111-1111-4111-8111-111111111111')
  })
})

// ─── ats.service ────────────────────────────────────────────────────────────────────────────
describe('ats.service', () => {
  const ats = require('../src/services/ats.service.js')

  it('JD bigrams never span a list separator ("Python, Kubernetes, Docker" is not a phrase)', () => {
    const f = ats.extractKeywords('Requirements: Python, Kubernetes, Docker, CI/CD, AWS, machine learning, REST APIs.')
    const phrases = Object.keys(f).filter(k => k.includes(' '))
    expect(phrases).toContain('machine learning')
    expect(phrases).toContain('rest apis')
    expect(phrases).not.toContain('python kubernetes')
    expect(phrases).not.toContain('kubernetes docker')
    expect(phrases).not.toContain('docker cicd')
  })

  it('a posting with nothing scoreable does not hand out a perfect keyword score', () => {
    const resume = 'Jane Doe\njane@x.com\nExperience\nAcme — Engineer 2019-2024\n- Led a team of 5 and cut costs by 30%\nEducation\nBSc\nSkills\nPython, SQL\n' + 'word '.repeat(150)
    const r = ats.scoreResume(resume, 'Looking for a strong candidate to join our team and provide excellent work in this role.')
    expect(r.detail.keywords.noKeywords).toBe(true)
    expect(r.keywordScore).toBeLessThan(100)
    expect(r.keywordScore).toBe(Math.round((r.formatScore * 0.25 + r.sectionsScore * 0.20 + r.contentScore * 0.20) / 0.65))
  })

  it('recognises French / Spanish / German section headings (diacritics folded)', () => {
    const fr = 'Jean Dupont\njean@x.fr\nProfil\nIngénieur logiciel\nExpérience professionnelle\nAcme\nFormation\nUniversité de Lyon\nCompétences\nPython, SQL'
    const sec = ats.scoreResume(fr, 'Python engineer').detail.sections
    expect(sec.missing || []).toEqual([])
    const de = 'Max Muster\nmax@x.de\nBerufserfahrung\nAcme\nAusbildung\nTU Berlin\nKenntnisse\nPython'
    expect((ats.scoreResume(de, 'Python engineer').detail.sections.missing || [])).toEqual([])
  })

  it('role / seniority heuristics: "Staff Nurse", "Associate Attorney" and "Salesforce" are not misread', () => {
    expect(ats.detectSeniority('Staff Nurse')).not.toBe('lead')
    expect(ats.detectSeniority('Staff Software Engineer')).toBe('lead')
    expect(ats.detectSeniority('Associate Attorney')).not.toBe('junior')
    expect(ats.detectSeniority('Associate Product Manager')).toBe('junior')
    expect(ats.detectRoleCategory('Salesforce Administrator')).not.toBe('sales')
    expect(ats.detectRoleCategory('Sales Manager')).toBe('sales')
  })
})

// ─── claude.service ─────────────────────────────────────────────────────────────────────────
describe('claude.service', () => {
  const claude = require('../src/services/claude.service.js')
  const orig = { name: 'A', experience: [{ company: 'Acme', title: 'Engineer', dates: '2019 - 2021', bullets: ['Built APIs'] }], education: [], skills: ['Python'], certifications: [], projects: [] }
  const withBullets = b => ({ ...orig, experience: [{ ...orig.experience[0], bullets: b }] })

  it('the word "one" is not an invented figure; "two" still is', () => {
    expect(claude.inventedNumbers(orig, withBullets(['Worked one-on-one with clients; no one was left behind'])).length).toBe(0)
    expect(claude.inventedNumbers(orig, withBullets(['Led two teams'])).length).toBeGreaterThan(0)
  })

  it('the sanitizer drops request-triggering vectors that carry no script', () => {
    const out = claude.sanitizeGeneratedHtml('<input type=image src="http://e.test/a.png"><svg><use href="http://e.test/d.svg#x"/></svg>' +
      '<div style="background:image-set(\'http://e.test/b.png\' 1x)">x</div><a ping="http://e.test/p" href="http://example.com">a</a>')
    expect(out).not.toMatch(/e\.test/)
    expect(out).toContain('href="http://example.com"')
  })

  function fetchReturning(...texts) {
    let i = 0
    return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: texts[Math.min(i++, texts.length - 1)] }], stop_reason: 'end_turn' }) }))
  }
  afterEach(() => vi.unstubAllGlobals())

  it('extraction output is coerced to the schema (string skills, null entries, string bullets) instead of crashing downstream', async () => {
    vi.stubGlobal('fetch', fetchReturning(JSON.stringify({ name: 'Jane', skills: 'Python, Go', experience: [null, { company: 'Acme', title: 'E', dates: '2020', bullets: 'Did a thing' }], education: null })))
    const r = await claude.parseResumeStructure({ ANTHROPIC_API_KEY: 'k' }, 'Jane resume text')
    expect(r.success).toBe(true)
    expect(r.data.skills).toEqual(['Python', 'Go'])
    expect(r.data.experience.every(e => e && Array.isArray(e.bullets))).toBe(true)
    expect(Array.isArray(r.data.education)).toBe(true)
  })
  it('a top-level answer that is not an object is a failed extraction', async () => {
    vi.stubGlobal('fetch', fetchReturning('["not","an","object"]'))
    const r = await claude.parseResumeStructure({ ANTHROPIC_API_KEY: 'k' }, 'Jane resume text')
    expect(r.success).toBe(false)
  })

  it('cover letter: returned when it only uses figures from the resume/posting', async () => {
    const letter = 'Dear Hiring Manager,\n\n' + 'I built APIs at Acme and would bring that experience to your platform team. '.repeat(3) + '\n\nSincerely,\nA'
    vi.stubGlobal('fetch', fetchReturning(letter))
    const r = await claude.generateCoverLetter({ ANTHROPIC_API_KEY: 'k' }, orig, 'x'.repeat(80))
    expect(r.success).toBe(true)
    expect(r.data).toContain('Dear Hiring Manager')
  })
  it('cover letter: a draft with an invented figure is retried once; a second one fails rather than shipping it', async () => {
    const bad = 'Dear Hiring Manager,\n\n' + 'I increased revenue by 450% at Acme and want to do the same for you. '.repeat(3) + '\n\nSincerely,\nA'
    const fetchMock = fetchReturning(bad, bad)
    vi.stubGlobal('fetch', fetchMock)
    const r = await claude.generateCoverLetter({ ANTHROPIC_API_KEY: 'k' }, orig, 'x'.repeat(80))
    expect(r.success).toBe(false)
    expect(r.error).toBe('FABRICATION_DETECTED')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ─── docx / pdf template ────────────────────────────────────────────────────────────────────
describe('docx.service', () => {
  const docx = require('../src/services/docx.service.js')
  const JSZip = require('jszip')
  const data = { name: 'Jane Doe', email: 'j@x.com', linkedin: 'linkedin.com/in/jane', skills: ['Python'], experience: [], education: [] }

  it('carries a title/creator (not "Un-named") and real hyperlinks for contact + verification link', async () => {
    const z = await JSZip.loadAsync(await docx.generateAtsDocx(data, 'https://passthrough.dev/v/abc'))
    const core = await z.file('docProps/core.xml').async('string')
    expect(core).toContain('<dc:title>Jane Doe — Resume</dc:title>')
    expect(core).not.toContain('Un-named')
    const doc = await z.file('word/document.xml').async('string')
    expect((doc.match(/<w:hyperlink/g) || []).length).toBe(3)
    const rels = await z.file('word/_rels/document.xml.rels').async('string')
    expect(rels).toContain('mailto:j@x.com')
    expect(rels).toContain('https://linkedin.com/in/jane')
    expect(rels).toContain('https://passthrough.dev/v/abc')
  })
  it('the text still extracts in reading order with links inline (ATS-safe)', async () => {
    const rp = require('../src/services/resume.parser.js')
    const text = await rp.extractText(await docx.generateAtsDocx(data, 'https://passthrough.dev/v/abc'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(text).toContain('j@x.com | linkedin.com/in/jane | Passthrough Verified: https://passthrough.dev/v/abc')
  })
  it('builds a cover letter document', async () => {
    const buf = await docx.generateCoverLetterDocx('Dear Hiring Manager,\n\nPara one.\n\nSincerely,\nJane', 'Jane Doe')
    const z = await JSZip.loadAsync(buf)
    expect(await z.file('word/document.xml').async('string')).toContain('Para one.')
  })
})

describe('PDF page margins', () => {
  it('the built-in template leaves vertical margins to the print engine (no container padding that only pads page 1/last)', () => {
    const tpl = require('../src/services/pdfTemplate.service.js')
    const html = tpl.buildResumeHTML({ name: 'J', skills: ['x'] }, {}, null, { verified: false })
    expect(html).toMatch(/@page\s*\{[^}]*margin:\s*14mm 0/)
    expect(html).not.toMatch(/\.page\s*\{[^}]*padding:\s*16mm 16mm 16mm/)
  })
  it('pdf.service passes the same 14mm top/bottom margins', () => {
    const src = require('node:fs').readFileSync(require.resolve('../src/services/pdf.service.js'), 'utf8')
    expect(src).toMatch(/top:\s*'14mm'/)
    expect(src).toMatch(/bottom:\s*'14mm'/)
  })
})

// ─── controller ─────────────────────────────────────────────────────────────────────────────
function baseCtx(over = {}) {
  return {
    env: { PAYSTACK_CURRENCY: 'USD', ...over.env },
    get: k => (k === 'user' ? ('user' in over ? over.user : { id: 'u1', emailVerified: true }) : undefined),
    req: { param: () => 's1', query: k => (over.query ?? {})[k], json: async () => { if (over.badBody) throw new Error('bad'); return over.body ?? {} } },
    json: (body, status = 200) => ({ body, status }),
    header: () => {}, body: b => ({ rawBody: b }),
  }
}
let t
afterEach(() => t?.restore())

describe('structureResume (file preview)', () => {
  function setup(opts = {}) {
    const state = { updates: [], parses: 0 }
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', input_mode: 'file', status: 'COMPLETE_FAIL', resume_path: 'r/1.pdf', resume_mime_type: 'application/pdf', fix_purchased: false, original_resume_data: null }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q.patch); return { data: opts.lostRace ? [] : [{ id: 's1' }], error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { parse: async () => { state.parses++; return opts.parseResult ?? { resumeData: { name: 'Jane Doe', skills: ['Python'] }, parseError: false } } },
    })
    const env = { RESUMES_BUCKET: { get: async () => ('r2' in opts ? opts.r2 : { arrayBuffer: async () => new Uint8Array([1]).buffer }) } }
    return { mod, restore, state, db, env }
  }
  it('parses the stored file once, stores the structure and the name, and returns it', async () => {
    t = setup()
    const res = await t.mod.structureResume(baseCtx({ env: t.env }))
    expect(res.status).toBe(200)
    expect(res.body.data.originalResumeData.name).toBe('Jane Doe')
    expect(t.state.updates[0]).toMatchObject({ original_resume_data: { name: 'Jane Doe' }, candidate_first_name: 'Jane' })
    const upd = t.db.calls.find(c => c.table === 'scans' && c.op === 'update')
    expect(upd.filters).toContainEqual(['eq', 'fix_purchased', false])
  })
  it('is idempotent: an existing structure is returned without another Claude call', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file', status: 'COMPLETE_PASS', fix_purchased: false, original_resume_data: { name: 'Kept' } } })
    const res = await t.mod.structureResume(baseCtx({ env: t.env }))
    expect(res.body.data.originalResumeData).toEqual({ name: 'Kept' })
    expect(t.state.parses).toBe(0)
  })
  it('refuses non-owners, non-file scans, unfinished scans and purchased scans', async () => {
    t = setup({ scan: { id: 's1', user_id: 'other', input_mode: 'file', status: 'COMPLETE_PASS' } })
    expect((await t.mod.structureResume(baseCtx({ env: t.env }))).status).toBe(403)
    t.restore(); t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', status: 'COMPLETE_PASS' } })
    expect((await t.mod.structureResume(baseCtx({ env: t.env }))).status).toBe(400)
    t.restore(); t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file', status: 'SCANNING' } })
    expect((await t.mod.structureResume(baseCtx({ env: t.env }))).status).toBe(400)
    t.restore(); t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file', status: 'COMPLETE_PASS', fix_purchased: true } })
    expect((await t.mod.structureResume(baseCtx({ env: t.env }))).status).toBe(400)
  })
  it('a parse failure is a 502 and stores nothing; a vanished file is a 410', async () => {
    t = setup({ parseResult: { parseError: true, parseErrorMessage: 'x' } })
    expect((await t.mod.structureResume(baseCtx({ env: t.env }))).status).toBe(502)
    expect(t.state.updates).toEqual([])
    t.restore(); t = setup({ r2: null })
    expect((await t.mod.structureResume(baseCtx({ env: t.env }))).status).toBe(410)
  })
})

describe('updateResumeData / draft — uploaded files once structured', () => {
  function setup(scan) {
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1' }], error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: false }) },
    })
    return { mod, restore }
  }
  it('a file scan with no structure yet is told to preview first (400); with one it is editable', async () => {
    t = setup({ id: 's1', user_id: 'u1', input_mode: 'file', status: 'COMPLETE_PASS', fix_purchased: false, original_resume_data: null, job_description_text: 'JD ' + 'x'.repeat(60) })
    const r1 = await t.mod.updateResumeData(baseCtx({ body: { resumeData: { name: 'J', skills: ['x'] } } }))
    expect(r1.status).toBe(400)
    expect(r1.body.message).toMatch(/preview/i)
    t.restore()
    t = setup({ id: 's1', user_id: 'u1', input_mode: 'file', status: 'COMPLETE_PASS', fix_purchased: false, original_resume_data: { name: 'J' }, job_description_text: 'JD ' + 'x'.repeat(60) })
    const r2 = await t.mod.updateResumeData(baseCtx({ body: { resumeData: { name: 'J', skills: ['Python'] } } }))
    expect(r2.status).toBe(200)
  })
  it('the free draft is available for a structured file scan, and refused (with a reason) before that', async () => {
    t = setup({ id: 's1', user_id: 'u1', input_mode: 'file', status: 'COMPLETE_PASS', original_resume_data: null })
    expect((await t.mod.downloadDraft(baseCtx())).status).toBe(400)
    t.restore()
    t = setup({ id: 's1', user_id: 'u1', input_mode: 'file', status: 'COMPLETE_PASS', original_resume_data: { name: 'Jane Doe', skills: ['Python'] } })
    const res = await t.mod.downloadDraft(baseCtx())
    expect(res.rawBody).toBeTruthy()
  })
})

describe('updateDeliveredResume', () => {
  function setup(opts = {}) {
    const state = { updates: [], puts: [], deletes: [], purged: [] }
    const scan = 'scan' in opts ? opts.scan : {
      id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'FIX', fix_retry_count: 1,
      job_description_text: 'JD ' + 'x'.repeat(60), original_resume_data: { name: 'Jane' }, rewritten_resume_data: { name: 'Jane', skills: ['Old'] },
      resume_ats_path: 'old.docx', resume_pdf_path: 'old.pdf', resume_hash: 'oldhash', resume_pdf_hash: 'oldpdf',
      verification_code: 'CODE1', verification_url: 'https://passthrough.dev/v/CODE1', verified_at: '2026-01-01',
      quantification_prompts: [{ bullet: 'Built APIs', suggestion: 'add a number' }, { bullet: 'Removed bullet', suggestion: 'add a number' }],
      cover_letter_text: 'old letter',
    }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q); return { data: opts.lostRace ? [] : [{ id: 's1' }], error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { extractText: async () => 'x'.repeat(200) },
      'services/docx.service.js': { generateAtsDocx: async (d, url, o) => { (state.docx ||= []).push(o?.verified === false ? 'unverified' : 'verified'); return Buffer.from('docx') } },
      'services/ats.service.js': { scoreResume: () => ({ score: opts.score ?? 90, detail: {} }), describeWeakAreas: () => [] },
      'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: false }), generateBeautifulResumeHTML: async () => ({ success: false }) },
      'services/badge.service.js': { hashBytes: async () => 'newhash' },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/pdf.service.js': { generateResumePDF: async () => Buffer.from('pdf') },
      'lib/badgeCache.js': { purgeBadgeCache: async c => { state.purged.push(c) } },
    })
    const env = { RESUMES_BUCKET: { put: async k => { state.puts.push(k) }, delete: async k => { state.deletes.push(k) } } }
    return { mod, restore, state, db, env }
  }
  const edit = { name: 'Jane', skills: ['New'], experience: [{ company: 'Acme', title: 'Eng', dates: '2020', bullets: ['Built APIs'] }] }

  it('rebuilds both files from the edit, scores them, moves the old hashes to history, keeps the link, purges the badge cache', async () => {
    t = setup()
    const res = await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))
    expect(res.status).toBe(200)
    const patch = t.state.updates[0].patch
    expect(patch).toMatchObject({ rewritten_resume_data: expect.objectContaining({ skills: ['New'] }), fix_ats_score: 90, resume_hash: 'newhash', resume_pdf_hash: 'newhash', rewrite_failed: false, cover_letter_text: null })
    expect(patch.resume_hash_history).toEqual([{ docx: 'oldhash', pdf: 'oldpdf', at: '2026-01-01' }])
    expect(patch).not.toHaveProperty('verification_code')
    expect(patch.quantification_prompts).toEqual([{ bullet: 'Built APIs', suggestion: 'add a number' }])
    expect(t.state.deletes.sort()).toEqual(['old.docx', 'old.pdf'])
    expect(t.state.purged).toEqual(['CODE1'])
    const filters = t.state.updates[0].filters
    expect(filters).toContainEqual(['eq', 'status', 'FIX_DELIVERED'])
    expect(filters).toContainEqual(['eq', 'fix_retry_count', 1])
  })
  it('a score under the threshold rebuilds with the honest unverified wording', async () => {
    t = setup({ score: 70 })
    const res = await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))
    expect(res.body.data.credentialVerified).toBe(false)
    expect(t.state.docx).toEqual(['verified', 'unverified'])
  })
  it('G7: a credential-only (BADGE) edit is stored as the owner\'s edit and NEVER overwrites the scored upload (original_resume_data)', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'BADGE', fix_retry_count: 0, job_description_text: 'JD ' + 'x'.repeat(60), original_resume_data: { name: 'Jane' }, rewritten_resume_data: null, resume_ats_path: 'old.docx', verification_code: 'C', verification_url: 'https://x/v/C' } })
    const res = await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))
    expect(res.status).toBe(200)
    const patch = t.state.updates[0].patch
    expect(patch).not.toHaveProperty('original_resume_data')
    expect(patch.rewritten_resume_data).toEqual(patch.user_edited_resume_data)
    expect(patch.user_edited_resume_data.skills).toEqual(['New'])
  })
  it('B3: the edit is pinned to the delivery it was built on (resume_ats_path), so two concurrent saves cannot both win', async () => {
    t = setup()
    await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))
    const q = t.state.updates[0]
    expect(q.filters.some(f => f[0] === 'eq' && f[1] === 'resume_ats_path' && f[2] === 'old.docx')).toBe(true)
  })
  it('B5: the credential-less tier stores no resume_hash, matching generateFix', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'FIX_PLAIN', fix_retry_count: 0, job_description_text: 'JD ' + 'x'.repeat(60), original_resume_data: { name: 'Jane' }, rewritten_resume_data: { name: 'Jane' }, resume_ats_path: 'old.docx' } })
    await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))
    expect(t.state.updates[0].patch.resume_hash).toBeNull()
  })
  it('G3: the breakdown of the file that was just delivered is persisted and returned', async () => {
    t = setup()
    const res = await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))
    expect(t.state.updates[0].patch).toHaveProperty('fix_ats_report')
    expect(res.body.data).toHaveProperty('fixAtsDetail')
    expect(res.body.data.userEditedResumeData.skills).toEqual(['New'])
  })
  it('losing a race to a retry is a 409 and cleans up the files it wrote', async () => {
    t = setup({ lostRace: true })
    const res = await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))
    expect(res.status).toBe(409)
    expect(t.state.deletes.length).toBeGreaterThanOrEqual(1)
    expect(t.state.deletes).not.toContain('old.docx')
  })
  it('refuses: not the owner, not delivered, empty resume, bad body', async () => {
    t = setup({ scan: { id: 's1', user_id: 'other', status: 'FIX_DELIVERED', fix_purchased: true } })
    expect((await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))).status).toBe(403)
    t.restore(); t = setup({ scan: { id: 's1', user_id: 'u1', status: 'FIX_GENERATING', fix_purchased: true } })
    expect((await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: edit } }))).status).toBe(400)
    t.restore(); t = setup()
    expect((await t.mod.updateDeliveredResume(baseCtx({ env: t.env, body: { resumeData: { name: 'J' } } }))).status).toBe(400)
    expect((await t.mod.updateDeliveredResume(baseCtx({ env: t.env, badBody: true }))).status).toBe(400)
  })
})

describe('generateCoverLetter / downloadCoverLetter', () => {
  function setup(opts = {}) {
    const state = { updates: [] }
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_retry_count: 0, job_description_text: 'JD ' + 'x'.repeat(60), rewritten_resume_data: { name: 'Jane' } }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q); return { data: opts.lostRace ? [] : [{ id: 's1' }], error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/claude.service.js': { generateCoverLetter: async () => opts.letter ?? { success: true, data: 'Dear Hiring Manager,\n\nHi.' } },
    })
    return { mod, restore, state }
  }
  it('writes the letter from the delivered resume and stores it', async () => {
    t = setup()
    const res = await t.mod.generateCoverLetter(baseCtx())
    expect(res.body.data.coverLetterText).toMatch(/Dear Hiring Manager/)
    expect(t.state.updates[0].patch).toEqual({ cover_letter_text: 'Dear Hiring Manager,\n\nHi.' })
  })
  it('refuses before delivery / for non-owners, and reports a failed generation as 502', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false } })
    expect((await t.mod.generateCoverLetter(baseCtx())).status).toBe(400)
    t.restore(); t = setup({ scan: { id: 's1', user_id: 'x', status: 'FIX_DELIVERED', fix_purchased: true } })
    expect((await t.mod.generateCoverLetter(baseCtx())).status).toBe(403)
    t.restore(); t = setup({ letter: { success: false, error: 'FABRICATION_DETECTED' } })
    expect((await t.mod.generateCoverLetter(baseCtx())).status).toBe(502)
  })
  it('downloads the stored letter as a docx, 404 when there is none', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', cover_letter_text: 'Dear Hiring Manager,\n\nHi.', rewritten_resume_data: { name: 'Jane Doe' } } })
    expect((await t.mod.downloadCoverLetter(baseCtx())).rawBody).toBeTruthy()
    t.restore(); t = setup({ scan: { id: 's1', user_id: 'u1', cover_letter_text: null } })
    expect((await t.mod.downloadCoverLetter(baseCtx())).status).toBe(404)
  })
})

describe('deleteScan — anonymous results', () => {
  function setup(row) {
    const state = { deletes: [], r2: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: row, error: null }
      if (q.table === 'payments') return { count: 0, error: null }
      if (q.table === 'scans' && q.op === 'delete') { state.deletes.push(q); return { data: { id: 's1' }, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const env = { RESUMES_BUCKET: { delete: async k => { state.r2.push(k) } } }
    return { mod, restore, state, env }
  }
  const anonRow = { id: 's1', user_id: null, status: 'COMPLETE_PASS', updated_at: '2020-01-01', resume_path: 'r/1.pdf', anon_token: sha256hex('tok'), anon_expires_at: new Date(Date.now() + 3600e3).toISOString() }
  it('the holder of the token can delete it (scoped to anonymous rows) and its file goes too', async () => {
    t = setup(anonRow)
    const res = await t.mod.deleteScan(baseCtx({ env: t.env, user: undefined, query: { token: 'tok' } }))
    expect(res.status).toBe(200)
    expect(t.state.deletes[0].filters).toContainEqual(['is', 'user_id', null])
    expect(t.state.r2).toEqual(['r/1.pdf'])
  })
  it('no token, a wrong token or an expired one is a 404 and touches nothing', async () => {
    for (const [row, token] of [[anonRow, undefined], [anonRow, 'wrong'], [{ ...anonRow, anon_expires_at: new Date(Date.now() - 1000).toISOString() }, 'tok']]) {
      t = setup(row)
      expect((await t.mod.deleteScan(baseCtx({ env: t.env, user: undefined, query: { token } }))).status).toBe(404)
      expect(t.state.deletes).toEqual([])
      t.restore()
    }
  })
})

describe('fix jobs: lease and once-only compensation', () => {
  it('a duplicate generateFix / generateBadge whose scan is already leased stands down without touching the scan', async () => {
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc' && q.name === 'claim_fix_job') return { data: false, error: null }
    })
    t = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    expect(await t.mod.generateFix({}, db, 's1')).toEqual({ success: true, skipped: true })
    expect(await t.mod.generateBadge({}, db, 's1')).toEqual({ success: true, skipped: true })
    expect(db.calls.filter(c => c.table === 'scans')).toEqual([])
    expect(db.calls.filter(c => c.name === 'release_fix_job')).toEqual([])
  })
  it('the lease is released after the run, even when the run throws', async () => {
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc' && q.name === 'claim_fix_job') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'select') return { data: null, error: null }
    })
    t = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async () => {}, sendFixFailed: async () => {} },
    })
    await t.mod.generateFix({}, db, 's1')
    expect(db.calls.filter(c => c.name === 'release_fix_job').length).toBe(1)
  })
  it('a Badge delivered under the threshold grants one compensating credit (round 0) with the honest wording', async () => {
    const state = { credits: [], docx: [] }
    const scan = { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, ats_score: 70, job_description_text: 'JD' }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: { id: 'u1', name: 'Jane', email: 'j@x.com' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1' }], error: null }
      if (q.op === 'rpc' && q.name === 'grant_fix_credit_once') { state.credits.push(q.args); return { data: true, error: null } }
    })
    t = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { extractText: async () => 'short' },
      'services/docx.service.js': { generateAtsDocx: async (d, u, o) => { state.docx.push(o?.verified === false ? 'unverified' : 'verified'); return Buffer.from('d') } },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/claude.service.js': { generateBeautifulResumeHTML: async () => ({ success: false }) },
      'services/badge.service.js': { generateShortCode: async () => 'NEW', buildVerificationUrl: (e, c) => `https://x/v/${c}`, hashBytes: async () => 'h' },
      'services/pdf.service.js': { generateResumePDF: async () => Buffer.from('p') },
      'services/email.service.js': { sendFixDelivered: async () => {}, sendFixFailed: async () => {}, sendOwnerAlert: async () => {} },
    })
    const env = { RESUMES_BUCKET: { put: async () => {}, delete: async () => {} } }
    await t.mod.generateBadge(env, db, 's1')
    expect(state.credits).toEqual([{ p_scan_id: 's1', p_user_id: 'u1', p_round: 0 }])
    expect(state.docx).toEqual(['verified', 'unverified'])
  })
  it('a Badge that earns the credential grants no credit', async () => {
    const state = { credits: [] }
    const scan = { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, ats_score: 85, job_description_text: 'JD' }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: { id: 'u1', name: 'Jane', email: 'j@x.com' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1' }], error: null }
      if (q.op === 'rpc' && q.name === 'grant_fix_credit_once') { state.credits.push(q.args); return { data: true, error: null } }
    })
    t = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { extractText: async () => 'short' },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('d') },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/claude.service.js': { generateBeautifulResumeHTML: async () => ({ success: false }) },
      'services/badge.service.js': { generateShortCode: async () => 'NEW', buildVerificationUrl: (e, c) => `https://x/v/${c}`, hashBytes: async () => 'h' },
      'services/pdf.service.js': { generateResumePDF: async () => Buffer.from('p') },
      'services/email.service.js': { sendFixDelivered: async () => {}, sendFixFailed: async () => {}, sendOwnerAlert: async () => {} },
    })
    await t.mod.generateBadge({ RESUMES_BUCKET: { put: async () => {}, delete: async () => {} } }, db, 's1')
    expect(state.credits).toEqual([])
  })
})

describe('createScan — IP ceiling slot is returned when the scan is never created', () => {
  it('refunds the per-IP slot when the insert fails', async () => {
    const refunds = []
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc' && q.name === 'increment_scan_count_if_under_limit') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'insert') return { data: null, error: new Error('insert failed') }
    })
    t = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': {
        isBypassed: () => false, hitQuota: async () => true,
        refundQuota: async (...a) => { refunds.push(a) }, anonScanSlotKey: () => 'rl:anonscan:x', refundAnonScanSlot: async () => {},
      },
    })
    const ctx = baseCtx({})
    ctx.get = k => (k === 'user' ? { id: 'u1' } : k === 'formFields' ? { brainDumpText: 'x'.repeat(150), jobDescriptionText: 'j'.repeat(80) } : undefined)
    ctx.header = () => {}
    ctx.req.header = () => '1.2.3.4'
    await expect(t.mod.createScan(ctx)).rejects.toThrow('insert failed')
    expect(refunds.length).toBe(1)
    expect(refunds[0][1]).toMatch(/^rl:scanip:/)
  })
})
