import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'module'
import JSZip from 'jszip'
import uploadResume from '../src/middleware/upload.js'
import { hasResumeContent, dropBlankEntries, parseClientResumeData } from '../src/lib/resumeData.js'
import { restoreFactualFields, sanitizeResumeShape } from '../src/services/claude.service.js'
import { generateAtsDocx } from '../src/services/docx.service.js'
import { buildResumeHTML } from '../src/services/pdfTemplate.service.js'
import { serializeResumeData } from '../src/services/resume.parser.js'
import { render } from '../src/templates/emails.js'

const require = createRequire(import.meta.url)
const rl = require('../src/middleware/rateLimiter.js')

// "Start from scratch" resume creation — round 1 closeout tests.

function ctxFor(request) {
  const store = {}
  return { store, req: { header: n => request.headers.get(n), raw: request }, set: (k, v) => { store[k] = v }, json: (body, status) => ({ body, status }) }
}
async function run(build) {
  const fd = new FormData(); build(fd)
  const c = ctxFor(new Request('https://api.test/api/scan', { method: 'POST', body: fd }))
  let passed = false
  const res = await uploadResume(c, async () => { passed = true })
  return { res, passed, store: c.store }
}
async function docText(buf) {
  const zip = await JSZip.loadAsync(buf)
  return (await zip.file('word/document.xml').async('string')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

const FULL = {
  name: 'Jane Doe', email: 'j@x.com', phone: '555', summary: 'Engineer.',
  experience: [{ company: 'Acme', title: 'Dev', dates: '2020-2022', location: 'Lagos', bullets: ['Built things'] }],
  education: [{ institution: 'MIT', degree: 'BSc', dates: '2016', details: 'GPA 3.9 Honours' }],
  skills: ['Go'], certifications: [],
  languages: ['English', 'Yoruba'], awards: ['Dean\'s List'], publications: ['A Paper (2021)'],
  volunteer: [{ organization: 'Red Cross', role: 'Helper', dates: '2019', bullets: ['Packed boxes'] }],
  projects: []
}

describe('upload.js — brain-dump length counts characters, not CRLF', () => {
  it('multipart CRLF newlines are normalised to LF before the cap is applied', async () => {
    const text = 'line\n'.repeat(60_000) // 300k chars as typed; multipart turns each \n into \r\n
    const { store } = await run(fd => fd.set('brainDumpText', text))
    expect(store.formFields.brainDumpText).not.toMatch(/\r/)
    expect(store.formFields.brainDumpText).toHaveLength(100_000)
  })
  it('a text under the cap round-trips with the exact character count the user typed', async () => {
    const text = 'a\nb\nc\n'.repeat(1000)
    const { store } = await run(fd => fd.set('brainDumpText', text))
    expect(store.formFields.brainDumpText).toHaveLength(text.length)
  })
})

describe('upload.js — resumeDataJson', () => {
  it('passes a normal structured resume through', async () => {
    const { passed, store } = await run(fd => fd.set('resumeDataJson', JSON.stringify(FULL)))
    expect(passed).toBe(true)
    expect(JSON.parse(store.formFields.resumeDataJson).name).toBe('Jane Doe')
  })
  it('rejects one over the size cap with a 400 instead of truncating it into invalid JSON', async () => {
    const { res, passed } = await run(fd => fd.set('resumeDataJson', JSON.stringify({ summary: 'x'.repeat(150_000) })))
    expect(passed).toBe(false); expect(res.status).toBe(400)
  })
})

describe('resumeData — new sections', () => {
  it('hasResumeContent counts volunteer, awards, publications and certifications, but not languages alone', () => {
    expect(hasResumeContent({ volunteer: [{ organization: 'Red Cross' }] })).toBe(true)
    expect(hasResumeContent({ awards: ['Prize'] })).toBe(true)
    expect(hasResumeContent({ publications: ['Paper'] })).toBe(true)
    expect(hasResumeContent({ certifications: ['AWS'] })).toBe(true)
    expect(hasResumeContent({ name: 'Jane', languages: ['English'] })).toBe(false)
    expect(hasResumeContent({ name: 'Jane' })).toBe(false)
  })
  it('dropBlankEntries removes empty volunteer rows and blank list lines', () => {
    const out = dropBlankEntries({ volunteer: [{ organization: '', role: '  ', bullets: [''] }, { organization: 'X', bullets: ['', 'ok'] }], languages: ['', 'French'], awards: [' '], publications: [] })
    expect(out.volunteer).toHaveLength(1)
    expect(out.volunteer[0].bullets).toEqual(['ok'])
    expect(out.languages).toEqual(['French']); expect(out.awards).toEqual([])
  })
  it('parseClientResumeData keeps the new fields', () => {
    const r = parseClientResumeData(FULL)
    expect(r.ok).toBe(true)
    expect(r.data.education[0].details).toBe('GPA 3.9 Honours')
    expect(r.data.experience[0].location).toBe('Lagos')
    expect(r.data.languages).toEqual(['English', 'Yoruba'])
  })
})

describe('claude.service — factual fields survive a rewrite', () => {
  it('restoreFactualFields copies the person-supplied sections and entry details back', () => {
    const rewritten = {
      name: 'Jane Doe',
      experience: [{ company: 'Acme', title: 'Dev', dates: '2020-2022', bullets: ['Improved'], location: 'Mars' }],
      education: [{ institution: 'MIT', degree: 'BSc', dates: '2016', details: 'invented' }],
      languages: ['Klingon'], awards: [], volunteer: []
    }
    const out = restoreFactualFields(FULL, rewritten)
    expect(out.languages).toEqual(['English', 'Yoruba'])
    expect(out.awards).toEqual(['Dean\'s List'])
    expect(out.publications).toEqual(['A Paper (2021)'])
    expect(out.volunteer[0].organization).toBe('Red Cross')
    expect(out.experience[0].location).toBe('Lagos')
    expect(out.education[0].details).toBe('GPA 3.9 Honours')
  })
  it('an entry the model renamed gets no location rather than someone else\'s', () => {
    const out = restoreFactualFields(FULL, { experience: [{ company: 'Other Co', title: 'Dev', bullets: [] }], education: [] })
    expect(out.experience[0].location).toBeNull()
  })
  it('sanitizeResumeShape keeps the new fields', () => {
    const out = sanitizeResumeShape({ ...FULL })
    expect(out.languages).toEqual(['English', 'Yoruba'])
    expect(out.volunteer[0].role).toBe('Helper')
    expect(out.experience[0].location).toBe('Lagos')
    expect(out.education[0].details).toBe('GPA 3.9 Honours')
  })
})

describe('renderers include the new sections', () => {
  it('docx', async () => {
    const t = await docText(await generateAtsDocx(FULL))
    for (const s of ['Lagos', 'GPA 3.9 Honours', 'Red Cross', 'Packed boxes', 'Dean', 'A Paper', 'Yoruba']) expect(t, s).toContain(s)
    expect(t).not.toMatch(/\bnull\b|undefined/)
  })
  it('pdf html', () => {
    const h = buildResumeHTML(FULL, undefined, null, { verified: false })
    for (const s of ['Lagos', 'GPA 3.9 Honours', 'Red Cross', 'Packed boxes', 'Dean', 'A Paper', 'Yoruba']) expect(h, s).toContain(s)
    expect(h).not.toMatch(/>null<|undefined/)
  })
  it('scoring text serialisation', () => {
    const t = serializeResumeData(FULL)
    for (const s of ['Lagos', 'GPA 3.9 Honours', 'VOLUNTEER', 'AWARDS', 'PUBLICATIONS', 'LANGUAGES', 'Yoruba']) expect(t, s).toContain(s)
  })
})

describe('anonymous scan slot', () => {
  it('the key is per client address under the anonscan namespace', () => {
    const c = { req: { header: n => (n.toLowerCase() === 'cf-connecting-ip' ? '203.0.113.9' : undefined) } }
    expect(rl.anonScanSlotKey(c)).toMatch(/^rl:anonscan:/)
  })
  it('refund ignores a missing key or one outside the anonscan namespace (never touches another limiter)', async () => {
    const op = vi.fn()
    const env = { RATE_LIMIT_DO: undefined, __op: op }
    await expect(rl.refundAnonScanSlot(env, null)).resolves.toBeUndefined()
    await expect(rl.refundAnonScanSlot(env, 'rl:auth:1.2.3.4')).resolves.toBeUndefined()
    await expect(rl.refundAnonScanSlot(env, 42)).resolves.toBeUndefined()
  })
})

describe('email', () => {
  it('the anonymous result mail states how long the link works', () => {
    const html = render('anon_scan_result', { NAME: 'Jane', SCORE: '80', PASSED: 'passes', SCAN_URL: 'https://x/s', HOURS: '24', FRONTEND_URL: 'https://x' })
    expect(html).toMatch(/works for 24 hours/)
  })
})
