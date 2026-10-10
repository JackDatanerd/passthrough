// Scan/ATS round 4 — scoring integrity, the fabrication guard, the HTML sanitizer, and the Claude cost ledger.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ats = require('../src/services/ats.service.js')
const claude = require('../src/services/claude.service.js')
const claudeUsage = require('../src/lib/claudeUsage.js')
const { failureMessage, isRetryable, FAILURE_MESSAGES } = require('../src/lib/scanFailure.js')

afterEach(() => vi.restoreAllMocks())

const JD = `Senior Backend Engineer
What you'll do
- Build and operate Node.js microservices on AWS using Docker and Kubernetes
- Design PostgreSQL schemas, Redis caching, GraphQL APIs and Kafka pipelines
- Own CI/CD with Terraform and Jenkins, observability with Datadog and Grafana
Requirements
- 5+ years of experience with TypeScript, Node.js, PostgreSQL, Kubernetes, Terraform, Kafka
- Strong knowledge of distributed systems, system design and API design`
const BASE = `Jane Doe
jane@example.com | Nairobi
SUMMARY
Backend developer with experience building web services.
EXPERIENCE
Developer — Foo Ltd — 2019 - 2024
• Built REST services for internal tools used by the finance team across the region
• Improved reporting performance by 40% by rewriting slow queries for the data team
• Led a team of 3 engineers delivering a billing migration ahead of schedule
• Maintained deployment scripts and monitored production services for the platform team
EDUCATION
BSc Computer Science — University of Nairobi — 2015 - 2019
SKILLS
JavaScript, SQL, Git, Linux, REST APIs`
const FILLER = '\nPROJECTS\nSide work\n• Wrote documentation and tutorials for open source contributors worldwide\n• Presented talks at local meetups about software testing practices and code review habits\n'
const STUFF = 'Node.js, AWS, Docker, Kubernetes, PostgreSQL, Redis, GraphQL, Kafka, Terraform, Jenkins, Datadog, Grafana, TypeScript, CI/CD, microservices, distributed systems, system design, API design, observability'

describe('keyword stuffing', () => {
  const plain = ats.scoreResume(BASE + FILLER, JD)
  const stuffed = ats.scoreResume(BASE.replace('REST APIs', `REST APIs, ${STUFF}`) + FILLER, JD)
  it('a skills list full of job-description terms no role evidences no longer carries the score (measured: it took a 62 to an 88)', () => {
    expect(plain.score).toBeLessThan(70)
    expect(stuffed.keywordScore).toBeLessThan(40)
    expect(stuffed.score).toBeLessThan(80)                       // under the credential line
    expect(stuffed.detail.keywords.integrity.stuffed).toBe(true)
    expect(stuffed.detail.keywords.warnings.join(' ')).toMatch(/only in a skills list/)
  })
  it('an honest resume that lists skills AND uses them in its roles scores exactly as before', () => {
    const honest = BASE.replace('Built REST services', 'Built Node.js and AWS services with Docker and PostgreSQL').replace('REST APIs', 'REST APIs, Node.js, AWS, Docker, PostgreSQL')
    const r = ats.scoreResume(honest + FILLER, JD)
    expect(r.detail.keywords.integrity.stuffed).toBe(false)
    expect(r.detail.keywords.warnings).toEqual([])
  })
  it('a resume with no recognisable Skills heading is judged as it always was', () => {
    const noHeading = BASE.replace('SKILLS\n', '') + ', ' + STUFF
    expect(ats.scoreResume(noHeading + FILLER, JD).detail.keywords.integrity.stuffed).toBe(false)
  })
  it('an inline "Skills:" line counts as a skills list too', () => {
    const inline = BASE.replace('SKILLS\nJavaScript, SQL, Git, Linux, REST APIs', `Skills: JavaScript, SQL, ${STUFF}`)
    expect(ats.scoreResume(inline + FILLER, JD).detail.keywords.integrity.stuffed).toBe(true)
  })
})

describe('copied job-description text', () => {
  it('a resume that repeats the posting word for word is flagged and its keyword score halved', () => {
    const jdBody = JD.split('\n').slice(2).join('\n')
    const copied = BASE.replace('SKILLS', `${jdBody}\n${jdBody}\nSKILLS`) + FILLER
    const r = ats.scoreResume(copied, JD)
    expect(r.detail.keywords.integrity.copiedRatio).toBeGreaterThanOrEqual(0.12)
    expect(r.detail.keywords.warnings.join(' ')).toMatch(/word for word/)
  })
  it('a few shared phrases by chance are not copying', () => {
    expect(ats.scoreResume(BASE + FILLER, JD).detail.keywords.warnings.join(' ')).not.toMatch(/word for word/)
  })
})

describe('hidden text and image-only PDFs', () => {
  it('hidden text costs format points and halves the keyword score', () => {
    const clean = ats.scoreResume(BASE.replace('REST APIs', 'REST APIs, Node.js') + FILLER, JD)
    const hidden = ats.scoreResume(BASE.replace('REST APIs', 'REST APIs, Node.js') + FILLER, JD, { structure: { hiddenTextChars: 80 } })
    expect(hidden.formatScore).toBe(clean.formatScore - 25)
    expect(hidden.keywordScore).toBeLessThanOrEqual(Math.ceil(clean.keywordScore / 2))
    expect(hidden.detail.format.issues.join(' ')).toMatch(/hidden text/i)
  })
  it('a few stray characters of hidden text are not penalised', () => {
    const r = ats.scoreResume(BASE + FILLER, JD, { structure: { hiddenTextChars: 6 } })
    expect(r.detail.format.issues.join(' ')).not.toMatch(/hidden text/i)
  })
  it('an image-only PDF is scored as the blank page an ATS sees', () => {
    const r = ats.scoreResume(BASE + FILLER, JD, { structure: { imageOnly: true, pages: 1, columns: 1, images: 1, hiddenTextChars: 0 } })
    expect(r.formatScore).toBeLessThanOrEqual(35)
  })
  it('the file\'s link block is not scored as resume prose', () => {
    const withLinks = BASE + FILLER + '\n\n[hyperlinks in this document]\nhttps://www.linkedin.com/in/janedoe\nhttps://github.com/jane'
    expect(ats.scoreResume(withLinks, JD).score).toBe(ats.scoreResume(BASE + FILLER, JD).score)
  })
})

describe('content score by language', () => {
  const ES = `María López
maria@example.com | Madrid
RESUMEN
Desarrolladora con experiencia en servicios web y bases de datos para equipos de finanzas.
EXPERIENCIA
Desarrolladora — Empresa SA — 2019 - 2024
• Desarrollé servicios REST para herramientas internas utilizadas por el equipo financiero de toda la región
• Mejoré el rendimiento de los informes en un 40% reescribiendo consultas lentas para el equipo de datos
• Lideré un equipo de 3 ingenieros en una migración de facturación completada antes de lo previsto
• Mantuve scripts de despliegue y supervisé los servicios de producción de la plataforma de la empresa
• Documenté procesos y escribí tutoriales para colaboradores de código abierto en todo el mundo
• Presenté charlas en reuniones locales sobre pruebas de software y revisión de código en equipos
FORMACIÓN
Grado en Informática — Universidad de Madrid — 2015 - 2019
PROYECTOS
Herramienta interna
• Creé una herramienta interna para automatizar la conciliación de pagos entre varias regiones y sistemas
• Escribí la documentación técnica y los manuales de uso para los equipos de soporte y de finanzas
• Coordiné la migración de datos históricos con los equipos de operaciones y con los responsables de cada región
• Formé a nuevos compañeros en buenas prácticas de revisión de código, pruebas automatizadas y seguridad básica
HABILIDADES
JavaScript, SQL, Git, Linux, REST, Docker, AWS, PostgreSQL, Node.js, integración continua y despliegue automatizado`
  it('does not mistake a Spanish resume for an English one', () => {
    expect(ats.looksEnglish(ES)).toBe(false)
    expect(ats.looksEnglish(BASE + FILLER + BASE)).toBe(true)
  })
  it('skips the English-only action-verb check instead of scoring a non-English resume ~0 on content', () => {
    const r = ats.scoreResume(ES, JD)
    expect(r.detail.content.language).toBe('other')
    expect(r.detail.content.actionVerbRate).toBe(null)
    expect(r.contentScore).toBeGreaterThanOrEqual(65)
    expect(r.detail.content.issues.join(' ')).toMatch(/only reads English/)
  })
  it('an English resume is still checked for action verbs', () => {
    const r = ats.scoreResume(BASE + FILLER, JD)
    expect(r.detail.content.language).toBe('en')
    expect(r.detail.content.actionVerbRate).toBeGreaterThan(0)
  })
})

describe('bullets that say what was done but not how much', () => {
  it('lists the bullets with no number so they can be fixed before paying for anything', () => {
    const u = ats.scoreResume(BASE + FILLER, JD).detail.content.unquantified
    expect(u.count).toBeGreaterThanOrEqual(3)
    expect(u.examples.length).toBeLessThanOrEqual(5)
    expect(u.examples.join('|')).toMatch(/Built REST services/)
    expect(u.examples.join('|')).not.toMatch(/40%/)          // a quantified bullet is not listed
    expect(u.examples.every(e => !e.startsWith('•'))).toBe(true)
  })
})

// ── fabrication guard ──────────────────────────────────────────────────────────────────────────────────────
const role = (company, title, dates = '2018 - 2020') => ({ company, title, dates, bullets: ['Did the work for the team'] })
const resumeOf = (experience, extra = {}) => ({ experience, education: [], projects: [], skills: [], certifications: [], ...extra })
const clone = o => JSON.parse(JSON.stringify(o))

describe('detectFabrication: a dropped role is caught', () => {
  const orig = resumeOf([role('Acme Ltd', 'Analyst', '2018 - 2020'), role('Acme Ltd', 'Senior Analyst', '2020 - 2024'), role('Google', 'Engineer', '2015 - 2018'), role('Google Cloud', 'Engineer', '2014 - 2015')])
  it('a faithful rewrite passes', () => expect(claude.detectFabrication(orig, clone(orig))).toBe(false))
  it('a reordered but complete rewrite passes', () => {
    const r = clone(orig); r.experience.reverse()
    expect(claude.detectFabrication(orig, r)).toBe(false)
  })
  it('dropping one of two roles at the same employer is caught (it used to pass)', () => {
    const r = clone(orig); r.experience.splice(0, 1)
    expect(claude.detectFabrication(orig, r)).toBe(true)
  })
  it('dropping "Google Cloud" while "Google" remains is caught (it used to pass)', () => {
    const r = clone(orig); r.experience.splice(3, 1)
    expect(claude.detectFabrication(orig, r)).toBe(true)
  })
  it('dropping every role at an employer is still caught', () => {
    const r = clone(orig); r.experience.splice(0, 2)
    expect(claude.detectFabrication(orig, r)).toBe(true)
  })
  it('one rewritten entry cannot stand in for two originals', () => {
    const r = clone(orig); r.experience[0] = clone(orig.experience[1])
    expect(claude.detectFabrication(orig, r)).toBe(true)
  })
  it('tidying a title ("Developer" -> "Software Developer") is not a drop', () => {
    const o = resumeOf([role('Foo Ltd', 'Developer')]), r = resumeOf([role('Foo Limited', 'Software Developer')])
    expect(claude.detectFabrication(o, r)).toBe(false)
  })
  it('dropping the MSc beside a BSc at one university is caught', () => {
    const o = resumeOf([], { education: [{ institution: 'University of Nairobi', degree: 'BSc Computer Science', dates: '2011 - 2015' }, { institution: 'University of Nairobi', degree: 'MSc Computer Science', dates: '2016 - 2018' }] })
    const r = clone(o); r.education.splice(1, 1)
    expect(claude.detectFabrication(o, r)).toBe(true)
    expect(claude.detectFabrication(o, clone(o))).toBe(false)
  })
  it('dropping one of two projects whose names overlap is caught', () => {
    const o = resumeOf([], { projects: [{ name: 'Atlas', description: 'x' }, { name: 'Atlas Mobile', description: 'y' }] })
    const r = clone(o); r.projects.splice(1, 1)
    expect(claude.detectFabrication(o, r)).toBe(true)
  })
})

describe('restoreFactualFields keeps a location when the title is tidied', () => {
  const input = { experience: [{ company: 'Foo Ltd', title: 'Software Developer', location: 'Nairobi' }, { company: 'Bar Inc', title: 'Analyst', location: 'Mombasa' }],
                  education: [{ institution: 'Uni A', degree: 'BSc Computer Science', details: 'First class' }] }
  it('re-attaches by employer when the (company, title) pair no longer matches', () => {
    const out = claude.restoreFactualFields(input, { experience: [{ company: 'Foo Ltd', title: 'Software Engineer' }, { company: 'Bar Inc', title: 'Analyst' }], education: [] })
    expect(out.experience.map(e => e.location)).toEqual(['Nairobi', 'Mombasa'])
  })
  it('re-attaches an education detail when the degree wording changes', () => {
    const out = claude.restoreFactualFields(input, { experience: [], education: [{ institution: 'Uni A', degree: 'Bachelor of Science in Computer Science' }] })
    expect(out.education[0].details).toBe('First class')
  })
  it('does not guess when several originals share the employer and nothing lines up', () => {
    const two = { experience: [{ company: 'Foo', title: 'A', location: 'X' }, { company: 'Foo', title: 'B', location: 'Y' }], education: [] }
    const out = claude.restoreFactualFields(two, { experience: [{ company: 'Foo', title: 'C' }], education: [] })
    expect(out.experience[0].location).toBe(null)
  })
  it('the exact pair still wins', () => {
    const out = claude.restoreFactualFields(input, { experience: [{ company: 'Bar Inc', title: 'Analyst' }], education: [] })
    expect(out.experience[0].location).toBe('Mombasa')
  })
})

// ── sanitizer ─────────────────────────────────────────────────────────────────────────────────────────────
describe('sanitizeGeneratedHtml: escaped spellings of url( and @import', () => {
  const page = css => `<!DOCTYPE html><html><head><style>${css}</style></head><body><p style="x">hi</p></body></html>`
  it.each([
    ['hex-escaped function name', 'body{background:u\\72l(http://attacker.example/x.png)}'],
    ['letter-escaped function name', 'body{background:\\u\\r\\l(http://attacker.example/x.png)}'],
    ['escaped @import', '@\\69mport "http://attacker.example/a.css";'],
    ['escaped @import url', '@\\69mport u\\72l(http://attacker.example/a.css);'],
  ])('%s is removed', (_, css) => {
    const out = claude.sanitizeGeneratedHtml(page(css))
    expect(out).not.toMatch(/attacker\.example/)
  })
  it('an entity-encoded url( inside a style attribute is removed', () => {
    const out = claude.sanitizeGeneratedHtml('<div style="background:&#117;rl(http://attacker.example/x.png)">hi</div>')
    expect(out).not.toMatch(/attacker\.example/)
  })
  it('a hex-entity spelling is removed too', () => {
    const out = claude.sanitizeGeneratedHtml('<div style="background:&#x75;rl(http://attacker.example/x.png)">hi</div>')
    expect(out).not.toMatch(/attacker\.example/)
  })
  it('ordinary CSS survives, including escaped bullets in content:', () => {
    const css = 'ul li::before{content:"\\2022 ";color:#333} @page{size:A4;margin:14mm 0}'
    const out = claude.sanitizeGeneratedHtml(page(css))
    expect(out).toContain('content:"\\2022 "')
    expect(out).toContain('@page{size:A4;margin:14mm 0}')
  })
  it('an allow-listed font import still works', () => {
    const out = claude.sanitizeGeneratedHtml(page('@import url("https://fonts.googleapis.com/css2?family=Inter");'))
    expect(out).toContain('fonts.googleapis.com')
  })
})

// ── cost ledger ────────────────────────────────────────────────────────────────────────────────────────────
describe('claude cost ledger', () => {
  function fakeFetch(usage) {
    return vi.fn(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ content: [{ type: 'text', text: '{"aiScore":50,"missingKeywords":[]}' }], stop_reason: 'end_turn', usage }), text: async () => '' }))
  }
  it('a call reports its token usage, label and model to the job\'s collector', async () => {
    vi.stubGlobal('fetch', fakeFetch({ input_tokens: 1200, output_tokens: 80 }))
    const env = { ANTHROPIC_API_KEY: 'k', __usage: [] }
    const r = await claude.scoreResumeWithAI(env, 'resume text '.repeat(20), 'jd text '.repeat(20))
    expect(r.success).toBe(true)
    expect(r.usage).toEqual({ input_tokens: 1200, output_tokens: 80 })
    expect(env.__usage).toHaveLength(1)
    expect(env.__usage[0]).toMatchObject({ label: 'score', input_tokens: 1200, output_tokens: 80 })
    vi.unstubAllGlobals()
  })
  it('without a collector nothing breaks', async () => {
    vi.stubGlobal('fetch', fakeFetch({ input_tokens: 5, output_tokens: 5 }))
    expect((await claude.scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'a'.repeat(100), 'b'.repeat(100))).success).toBe(true)
    vi.unstubAllGlobals()
  })
  it('track() copies env rather than mutating the shared one', () => {
    const env = { A: 1 }
    const t = claudeUsage.track(env)
    expect(t).not.toBe(env); expect(t.A).toBe(1); expect(env.__usage).toBeUndefined(); expect(t.__usage).toEqual([])
  })
  it('record() writes one row per call and empties the collector; a missing table never throws', async () => {
    const inserted = []
    const sb = { from: t => ({ insert: async rows => { inserted.push([t, rows]); return { error: null } } }) }
    const env = { __usage: [{ label: 'score', model: 'm', input_tokens: 10, output_tokens: 2 }, { label: 'rewrite', model: 'm', input_tokens: 99, output_tokens: 40 }] }
    await claudeUsage.record(sb, env, { scanId: 's1' })
    expect(inserted[0][0]).toBe('claude_usage')
    expect(inserted[0][1].map(r => [r.scan_id, r.label, r.input_tokens])).toEqual([['s1', 'score', 10], ['s1', 'rewrite', 99]])
    expect(env.__usage).toEqual([])
    const broken = { from: () => ({ insert: async () => ({ error: { message: 'relation "claude_usage" does not exist' } }) }) }
    await expect(claudeUsage.record(broken, { __usage: [{ label: 'x', model: 'm', input_tokens: 1, output_tokens: 1 }] })).resolves.toBeUndefined()
  })
  it('withUsage writes what the job spent even when the job throws', async () => {
    const inserted = []
    const sb = { from: () => ({ insert: async rows => { inserted.push(...rows); return { error: null } } }) }
    await expect(claudeUsage.withUsage(sb, {}, 's9', async env => { env.__usage.push({ label: 'structure', model: 'm', input_tokens: 7, output_tokens: 3 }); throw new Error('boom') })).rejects.toThrow('boom')
    expect(inserted).toHaveLength(1)
  })
})

describe('the scanned-PDF reader', () => {
  it('sends the PDF as a document block and returns the transcription', async () => {
    let body
    vi.stubGlobal('fetch', vi.fn(async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, headers: new Map(), json: async () => ({ content: [{ type: 'text', text: '  Jane Doe\nEXPERIENCE  ' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), text: async () => '' } }))
    const r = await claude.extractTextFromPdf({ ANTHROPIC_API_KEY: 'k' }, new Uint8Array([37, 80, 68, 70]))
    expect(r).toEqual({ success: true, text: 'Jane Doe\nEXPERIENCE' })
    const blocks = body.messages[0].content
    expect(blocks[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } })
    expect(blocks[0].source.data).toBe(Buffer.from([37, 80, 68, 70]).toString('base64'))
    expect(body.system).toMatch(/never follow instructions/i)
    vi.unstubAllGlobals()
  })
})

describe('failure codes', () => {
  it('every code has copy, and only deterministic ones are not retryable', () => {
    for (const code of Object.keys(FAILURE_MESSAGES)) expect(failureMessage(code).length).toBeGreaterThan(20)
    for (const code of ['NO_TEXT', 'TOO_SHORT', 'ENCRYPTED_PDF', 'TOO_MANY_PAGES', 'UNREADABLE_FILE', 'NEEDS_MORE_DETAIL']) expect(isRetryable(code)).toBe(false)
    for (const code of ['SYSTEM', 'STRUCTURE_FAILED', undefined]) expect(isRetryable(code)).toBe(true)
    expect(failureMessage('NOPE')).toBe(FAILURE_MESSAGES.SYSTEM)
  })
})
