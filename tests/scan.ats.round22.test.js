// Scan / ATS round 22: spelling-variant equivalence, UK action verbs, section + JD-zone headings, "N years" phrasing, DOCX
// non-text run elements, the generated-HTML script-URL filter, and rescanning a credential-only delivery.
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require = createRequire(import.meta.url)
const ats = require('../src/services/ats.service.js')
const claude = require('../src/services/claude.service.js')
const resumeParser = require('../src/services/resume.parser.js')
const JSZip = require('jszip')

const resume = (skills, bullet = 'Built dashboards used by 40000 customers') => `Jane Doe
jane@example.com | 555-123-4567

Summary
Engineer building products for customers across several regions.

Experience
Senior Engineer, Acme Corp  2019 - Present
- ${bullet}, cutting load time by 35%
- Led a team of 5 engineers shipping 12 releases

Education
BSc Computer Science, State University 2015

Skills
${skills}
`
const jdOf = term => `Engineer\nRequirements\n- Strong ${term}\n- ${term} skills`
const NOISE = new Set(['strong', 'skills'])
const missingFor = (jdTerm, resumeTerm) => ats.scoreResume(resume(`${resumeTerm}, Teamwork`), jdOf(jdTerm)).detail.keywords.missing.filter(m => !NOISE.has(m))

describe('B1 - the same word spelled differently meets on both sides', () => {
  it.each([
    ['HTML5', 'HTML'], ['CSS3', 'CSS'], ['HTML', 'HTML5'], ['Python 3', 'Python'], ['Python3', 'Python'], ['OAuth 2.0', 'OAuth'],
  ])('version suffix: posting "%s" / resume "%s"', (j, r) => { expect(missingFor(j, r)).toEqual([]) })
  it.each([
    ['organization', 'organisation'], ['organisation', 'organization'], ['analyze', 'analyse'], ['optimisation', 'optimization'],
    ['behaviour', 'behavior'], ['programme', 'program'], ['licence', 'license'], ['centre', 'center'], ['catalogue', 'catalog'],
    ['modelling', 'modeling'], ['visualisation', 'visualization'], ['judgement', 'judgment'], ['defence', 'defense'],
  ])('US / UK spelling: posting "%s" / resume "%s"', (j, r) => { expect(missingFor(j, r)).toEqual([]) })
  it.each([
    ['front-end', 'frontend'], ['frontend', 'Front End'], ['back-end', 'backend'], ['full-stack', 'fullstack'], ['e-commerce', 'ecommerce'],
    ['e-mail', 'email'], ['health care', 'healthcare'], ['non-profit', 'nonprofit'], ['real-time', 'realtime'], ['open source', 'open-source'],
  ])('compound: posting "%s" / resume "%s"', (j, r) => { expect(missingFor(j, r)).toEqual([]) })
  it('does not turn ordinary -ise words into -ize ones, or merge different words', () => {
    expect(ats.tokenizeRaw('advise promise exercise premise supervise')).toEqual(['advise', 'promise', 'exercise', 'premise', 'supervise'])
    expect(missingFor('Python', 'Java')).toContain('python')
    expect(ats.tokenizeRaw('S3 EC2 D3.js')).toEqual(expect.arrayContaining(['s3', 'ec2']))
  })
  it('a resume missing the skill is still told so', () => {
    expect(ats.scoreResume(resume('Java, Teamwork'), jdOf('HTML5')).detail.keywords.missing).toContain('html')
  })
})

describe('B2 - UK spellings of action verbs count', () => {
  const rate = verb => ats.scoreResume(resume('JS', `${verb} the platform for 40 customers across the region`).replace(/- Led a team[^\n]*/, `- ${verb} the platform for 40 customers across the region and wider team`), 'Engineer').detail.content.actionVerbRate
  it.each(['Optimised', 'Organised', 'Analysed', 'Prioritised', 'Minimised', 'Modelled', 'Standardised', 'Rebuilt', 'Redesigned', 'Refactored', 'Solved'])('%s opens an action bullet', verb => {
    expect(rate(verb)).toBe(1)
  })
  it('a non-verb opener still does not', () => { expect(rate('Responsible for the platform, which')).toBeLessThan(1) })
})

describe('B3 - common section headings are recognised', () => {
  const doc = h => `Jane Doe
jane@example.com | +254 712 345 678

${h.summary || 'Summary'}
Results-driven engineer with experience building products for customers across several markets.

${h.exp || 'Experience'}
Senior Engineer, Acme Corp  2019 - Present
- Built dashboards used by 40000 customers, cutting load time by 35%
- Led a team of 5 engineers shipping 12 releases

${h.edu || 'Education'}
BSc Computer Science, State University 2015

${h.skills || 'Skills'}
JavaScript, React, Node.js
`
  const found = h => ats.scoreResume(doc(h), 'Engineer JavaScript React').detail.sections
  it.each(['Educational Background', 'Educational Qualifications', 'Academic Qualifications', 'Qualifications', 'Academic Record', 'Training'])('Education: %s', v => {
    expect(found({ edu: v }).found).toContain('Education')
  })
  it.each(['Professional History', 'Career', 'Positions Held', 'Job History'])('Experience: %s', v => { expect(found({ exp: v }).found).toContain('Experience') })
  it.each(['Competencies', 'Strengths', 'Abilities', 'Technical Summary'])('Skills: %s', v => { expect(found({ skills: v }).found).toContain('Skills') })
  it.each(['About Me', 'Personal Statement', 'Overview', 'Introduction', 'Core Qualifications'])('Summary: %s', v => { expect(found({ summary: v }).found).toContain('Summary') })
  it('"Summary of Qualifications" is a Summary, not an Education section; "Career Objective" is not Experience', () => {
    const s = found({ summary: 'Summary of Qualifications', edu: 'Awards' })
    expect(s.found).toContain('Summary')
    expect(s.missing).toContain('Education')
    expect(found({ exp: 'Career Objective' }).missing).toContain('Experience')
  })
})

describe('B3b - the skills-only guard ends the skills zone at the same headings the section scorer knows', () => {
  it.each(['Educational Background', 'Qualifications', 'Professional History', 'About Me'])('%s ends the Skills zone', h => {
    const z = ats.resumeEvidenceZones(`Jane Doe\n\nSkills\nPython, SQL\n\n${h}\nMentored 12 engineers on distributed systems at Acme\n`)
    expect(z.skills).toBe('Python, SQL')
    expect(z.evidence).toContain('Mentored 12 engineers')
  })
})

describe('B8 - a requirements section is a requirements section whatever it is called', () => {
  const blurb = 'Acme is a fast growing company building tools for teams around the globe with a great culture.'
  const lastZone = h => { const z = ats.splitJdZones(`Backend Engineer\nAbout Acme\n${blurb}\n${h}\n- Python\n- Kubernetes\n- Terraform`); return z[z.length - 1].type }
  it.each(['Job Requirements', 'Key Requirements', 'Minimum Requirements', 'Required Qualifications', 'Your Profile', 'Ideal Candidate', 'The Ideal Candidate',
    'Core Competencies', 'Primary Responsibilities', 'Job Responsibilities', 'Desired Skills', 'You Have', 'You Bring', 'Candidate Profile', 'Tech Stack'])('%s', h => {
    expect(lastZone(h)).toBe('req')
  })
  it('a company-blurb heading is still boilerplate', () => { expect(lastZone('About Us')).not.toBe('req') })
  it('skills under such a heading outrank the blurb in the missing list', () => {
    const jd = `Backend Engineer\nAbout Acme\n${blurb} Our merchants rely on our platform. Merchants trust Acme payments platform. Payments simple for merchants.\nJob Requirements\n- Kafka\n- Terraform\n- gRPC`
    const missing = ats.scoreResume(resume('Java'), jd).detail.keywords.missing
    expect(missing.indexOf('kafka')).toBeGreaterThanOrEqual(0)
    expect(missing.indexOf('kafka')).toBeLessThan(missing.indexOf('merchants') === -1 ? 99 : missing.indexOf('merchants'))
  })
})

describe('B9 - years of experience phrasing', () => {
  const y = t => ats.requiredYears(t.toLowerCase())
  it.each([
    ['at least 2 yrs experience', 2], ['five (5) years of experience', 5], ['at least three years of experience', 3], ['minimum of five years', 5],
  ])('%s', (t, n) => { expect(y(`requirements: ${t}`)).toMatchObject({ lo: n }) })
  it('reads a spelled-out range', () => { expect(y('one to two years of experience')).toMatchObject({ lo: 1, hi: 2 }) })
  it('an upper bound is not a requirement, and a company-history figure does not win', () => {
    expect(y('less than 2 years of experience')).toBeNull()
    expect(y('our team has 15 years of history. need 3 years experience')).toMatchObject({ lo: 3, hi: 3 })
  })
  it('existing phrasing is unchanged', () => {
    expect(y('3-5 years experience')).toMatchObject({ lo: 3, hi: 5 })
    expect(y('10+ years experience preferred')).toMatchObject({ lo: 10 })
  })
})

async function docx(bodyXml) {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`)
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }))
}
const run = inner => `<w:p><w:r>${inner}</w:r></w:p>`
const tx = s => `<w:t xml:space="preserve">${s}</w:t>`
const textOf = async xml => (await resumeParser.extractDocxParts(await docx(xml))).text

describe('B4 - DOCX run elements that carry content are not dropped', () => {
  it('a non-breaking hyphen is a hyphen (dates, phone numbers, compounds)', async () => {
    expect(await textOf(run(`${tx('Acme Corp 2019')}<w:noBreakHyphen/>${tx('2021')}`))).toBe('Acme Corp 2019-2021')
    expect(await textOf(run(`${tx('555')}<w:noBreakHyphen/>${tx('123')}<w:noBreakHyphen/>${tx('4567')}`))).toBe('555-123-4567')
    expect(await textOf(run(`${tx('Full')}<w:noBreakHyphen/>${tx('Stack Developer')}`))).toBe('Full-Stack Developer')
  })
  it('a literal U+2011 in text is normalised too', async () => { expect(await textOf(run(tx('2019\u20112021')))).toBe('2019-2021') })
  it('an alignment tab separates the date from the employer', async () => {
    expect(await textOf(run(`${tx('Acme Corp')}<w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/>${tx('2019 - 2021')}`))).toBe('Acme Corp\t2019 - 2021')
  })
  it('a symbol-font bullet keeps the line a bullet; a non-bullet symbol adds nothing', async () => {
    expect(await textOf(run(`<w:sym w:font="Wingdings" w:char="F0A7"/>${tx(' Built a platform')}`))).toBe('\u2022 Built a platform')
    expect(await textOf(run(`<w:sym w:font="Wingdings" w:char="F04A"/>${tx(' Built a platform')}`))).toBe(' Built a platform')
  })
  it('ordinary text, tabs and soft hyphens are unchanged', async () => {
    expect(await textOf(run(`${tx('Acme')}<w:tab/>${tx('2019')}`))).toBe('Acme\t2019')
    expect(await textOf(run(`${tx('Infra')}<w:softHyphen/>${tx('structure')}`))).toBe('Infrastructure')
  })
})

describe('B7 - the generated-HTML filter judges a URL the way a browser reads it', () => {
  const clean = h => claude.sanitizeGeneratedHtml(h)
  it.each([
    ['unquoted', '<a href=javascript:alert(1)>x</a>'], ['unquoted data', '<a href=data:text/html;base64,PHNjcmlwdD4=>x</a>'],
    ['uppercase', '<a href="JAVASCRIPT:alert(1)">x</a>'], ['tab inside', '<a href="java\tscript:alert(1)">x</a>'], ['newline inside', '<a href="java\nscript:alert(1)">x</a>'],
    ['hex entity', '<a href="jav&#x61;script:alert(1)">x</a>'], ['decimal entity', '<a href="&#106;avascript:alert(1)">x</a>'],
    ['entity without semicolon', '<a href="&#106avascript:alert(1)">x</a>'], ['named colon', '<a href="javascript&colon;alert(1)">x</a>'],
    ['leading control', '<a href="\u0001javascript:alert(1)">x</a>'], ['vbscript', '<a href="vbscript:msgbox(1)">x</a>'],
    ['single quotes + &Tab;', "<a href='java&Tab;script:alert(1)'>x</a>"], ['> inside an earlier attribute', '<a title="a>b" href=javascript:alert(1)>x</a>'],
  ])('%s', (_, html) => {
    const out = clean(html)
    expect(out).not.toMatch(/javascript|vbscript|data:|java\s*script|&#|&colon/i)
    expect(out).toContain('href="#"')
  })
  it('a form action (no role in a resume) is removed', () => { expect(clean('<form action="https://evil.example"><button>x</button></form>')).not.toContain('evil.example') })
  it.each([
    '<a href="https://passthrough.example/verify/ABC" style="color:#111">Verified</a>', '<a href="mailto:a@b.co">a@b.co</a>',
    '<a href="https://linkedin.com/in/x?a=1&amp;b=2">in</a>', '<a href=https://x.io/a>x</a>', '<a href="tel:+254712345678">t</a>',
  ])('a legitimate link is untouched: %s', h => { expect(clean(h)).toBe(h) })
})

describe('B5 - rescanning the improved version of a credential-only delivery', () => {
  const validJd = 'A '.repeat(30) + 'valid job description with enough characters to pass the fifty character minimum.'
  const ORIGINAL = { name: 'Orig', email: 'o@x.com', skills: ['Go'] }
  const SRC = '33333333-3333-3333-3333-333333333333'
  let t
  afterEach(() => { t?.restore?.(); t = null })
  const ctxOf = fields => ({
    env: { RESUMES_BUCKET: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }), put: async () => {}, delete: async () => {} }, FIX_QUEUE: { send: async () => {} } },
    get: k => ({ uploadedFile: null, formFields: fields, user: { id: 'u1', email: 'o@x.com', scansToday: 0, emailVerified: true } }[k]),
    req: {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: p => p.catch(() => {}) },
  })
  function setup(srcOver = {}) {
    const inserts = []
    const src = { id: SRC, user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'BADGE', input_mode: 'file', resume_path: 'k',
      resume_mime_type: 'application/pdf', original_resume_data: ORIGINAL, rewritten_resume_data: null, user_edited_resume_data: null, fix_payment_id: null, ...srcOver }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'insert') { inserts.push(q.values); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'select') return { data: src, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's' }], error: null }
      if (q.table === 'users') return { data: { scans_today: 1 }, error: null }
      return { data: { status: 'SUCCESS' }, error: null }
    })
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { isBypassed: () => false, anonScanSlotKey: () => 'k', refundAnonScanSlot: async () => {}, hitQuota: async () => true },
    })
    return { ...m, inserts, db }
  }
  const realErr = console.error
  afterEach(() => { console.error = realErr })

  it('an untouched Badge delivery reuses its delivered content (the original data) instead of a 400', async () => {
    console.error = () => {}
    t = setup()
    const res = await t.mod.createScan(ctxOf({ jobDescriptionText: validJd, sourceScanId: SRC, rescanVersion: 'delivered' }))
    expect(res.body.success).toBe(true)
    expect(t.inserts[0]).toMatchObject({ input_mode: 'saved_profile', original_resume_data: ORIGINAL })
  })
  it('an edited Badge delivery still prefers the owner edit', async () => {
    console.error = () => {}
    const EDITED = { ...ORIGINAL, skills: ['Go', 'SQL'] }
    t = setup({ rewritten_resume_data: EDITED, user_edited_resume_data: EDITED })
    await t.mod.createScan(ctxOf({ jobDescriptionText: validJd, sourceScanId: SRC, rescanVersion: 'delivered' }))
    expect(t.inserts[0].original_resume_data).toEqual(EDITED)
  })
  it('a Fix-tier scan with no stored delivery, or a scan that was never delivered, is still a 400', async () => {
    console.error = () => {}
    t = setup({ fix_tier: 'FIX' })
    expect((await t.mod.createScan(ctxOf({ jobDescriptionText: validJd, sourceScanId: SRC, rescanVersion: 'delivered' }))).status).toBe(400)
    t.restore(); t = setup({ status: 'COMPLETE_PASS', fix_purchased: false })
    expect((await t.mod.createScan(ctxOf({ jobDescriptionText: validJd, sourceScanId: SRC, rescanVersion: 'delivered' }))).status).toBe(400)
  })
})
