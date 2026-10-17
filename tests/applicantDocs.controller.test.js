import { describe, it, expect, afterEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// APPLICANT DOCS pass: the delivery routes — cover letter PDF, and the saved-profile downloads' name and paper.

let t
afterEach(() => { t?.restore(); vi.useRealTimers() })

function ctxFor({ headers, user = { id: 'u1', emailVerified: true }, query = {} } = {}) {
  return {
    env: {},
    get: k => (k === 'user' ? user : undefined),
    req: { param: () => 's1', query: k => query[k], json: async () => ({}) },
    json: (body, status = 200) => ({ body, status }),
    header: (k, v) => { headers[k] = v },
    body: b => ({ rawBody: b, status: 200 }),
  }
}

describe('downloadCoverLetterPdf', () => {
  function setup(scan, { render } = {}) {
    const seen = { html: null, opts: null }
    const db = createFakeSupabase(q => { if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null } })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/pdf.service.js': { generateResumePDF: async (env, html, opts) => { if (render) throw render; seen.html = html; seen.opts = opts; return Buffer.from('%PDF-fake') } },
    })
    return { mod, restore, seen }
  }
  const SCAN = { id: 's1', user_id: 'u1', cover_letter_text: 'Dear Hiring Manager,\n\nHi.\n\nSincerely,\nJosé Núñez', role_category: 'default',
    job_description_text: 'We organise programmes with colour-coded centres; you will prioritise and analyse behaviour across a UK-wide team.',
    rewritten_resume_data: { name: 'José Núñez', email: 'jose@x.com', phone: '+254 712 345 678' } }

  it('renders the letter on the posting\'s paper, with the letterhead, and names the file for the applicant', async () => {
    t = setup(SCAN)
    const headers = {}
    const res = await t.mod.downloadCoverLetterPdf(ctxFor({ headers }))
    expect(res.rawBody.toString()).toBe('%PDF-fake')
    expect(headers['Content-Type']).toBe('application/pdf')
    expect(headers['Content-Disposition']).toBe('attachment; filename="jose-nunez-cover-letter.pdf"')
    expect(t.seen.opts.paper).toBe('a4')
    expect(t.seen.html).toContain('<h1>José Núñez</h1>')
    expect(t.seen.html).toContain('href="mailto:jose@x.com"')
    expect(t.seen.html).toContain('href="tel:+254712345678"')
    expect(t.seen.html).toMatch(/\d{1,2} \w+ \d{4}/)           // a UK posting gets "16 October 2026", not "October 16, 2026"
  })
  it('uses Letter and the US date form for a US posting', async () => {
    t = setup({ ...SCAN, job_description_text: 'Join our team in Austin, Texas. You will own the analytics roadmap and ship dashboards.' })
    await t.mod.downloadCoverLetterPdf(ctxFor({ headers: {} }))
    expect(t.seen.opts.paper).toBe('letter')
    expect(t.seen.html).toMatch(/size: Letter/)
    expect(t.seen.html).toMatch(/[A-Z][a-z]+ \d{1,2}, \d{4}/)
  })
  it('dates the letter for the applicant\'s day, not UTC\'s (Nairobi is ahead; an unknown zone is UTC)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T22:30:00Z'))
    const dateFor = async query => { t?.restore(); t = setup(SCAN); await t.mod.downloadCoverLetterPdf(ctxFor({ headers: {}, query })); return t.seen.html }
    expect(await dateFor({ tz: 'Africa/Nairobi' })).toContain('17 October 2026')
    expect(await dateFor({})).toContain('16 October 2026')
    expect(await dateFor({ tz: 'Mars/Phobos' })).toContain('16 October 2026')
    expect(await dateFor({ tz: 'x'.repeat(200) })).toContain('16 October 2026')
    expect(await dateFor({ tz: 'America/Los_Angeles' })).toContain('16 October 2026')
  })
  it('404 without a letter, 403 for another user, 502 (with the docx fallback named) when the render fails', async () => {
    t = setup({ ...SCAN, cover_letter_text: null })
    expect((await t.mod.downloadCoverLetterPdf(ctxFor({ headers: {} }))).status).toBe(404)
    t.restore(); t = setup({ ...SCAN, user_id: 'someone-else' })
    expect((await t.mod.downloadCoverLetterPdf(ctxFor({ headers: {} }))).status).toBe(403)
    t.restore(); t = setup(SCAN, { render: new Error('browser down') })
    const res = await t.mod.downloadCoverLetterPdf(ctxFor({ headers: {} }))
    expect(res.status).toBe(502)
    expect(res.body.message).toMatch(/\.docx/)
  })
})

describe('cover letter DOCX — palette accent, and a limiter of its own', () => {
  it('draws the Word letter in the palette the PDF uses', async () => {
    const seen = {}
    const scan = { id: 's1', user_id: 'u1', cover_letter_text: 'Dear X,\n\nHi.', role_category: 'default', job_description_text: 'Join our team in Austin, Texas.', rewritten_resume_data: { name: 'Jane Doe' } }
    const db = createFakeSupabase(q => { if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null } })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/docx.service.js': { generateCoverLetterDocx: async (text, name, opts) => { seen.opts = opts; return new Uint8Array([1]) }, generateAtsDocx: async () => new Uint8Array([1]) },
    })
    t = { restore }
    await mod.downloadCoverLetter(ctxFor({ headers: {} }))
    const design = require('../src/services/design.service.js')
    expect(seen.opts.accent).toBe(design.getDesignTokens('u1', 's1', 'default', { jdText: scan.job_description_text }).palette.primary)
  })
  it('the PDF route has its own rate-limit bucket, not the paid regenerate-pdf one', async () => {
    const rl = (await import('../src/middleware/rateLimiter.js')).default
    expect(typeof rl.coverLetterPdf).toBe('function')
    expect(rl.coverLetterPdf).not.toBe(rl.pdfRegen)
    const routes = (await import('node:fs')).readFileSync(new URL('../src/routes/scan.routes.js', import.meta.url), 'utf8')
    expect(routes).toMatch(/cover-letter-pdf',\s*auth,\s*rl\.coverLetterPdf,/)
    expect(routes).not.toMatch(/cover-letter-pdf'[^\n]*pdfRegen/)
  })
})

describe('saved-profile downloads', () => {
  function setup(resumeData) {
    const seen = { docxOpts: null, pdfOpts: null, html: null }
    const db = createFakeSupabase(q => { if (q.table === 'users' && q.op === 'select') return { data: { saved_profile: { resumeData } }, error: null } })
    const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'lib/verification.js': { recordTombstones: async () => {} },
      'services/docx.service.js': { generateAtsDocx: async (d, u, o) => { seen.docxOpts = o; return new Uint8Array([1]) } },
      'services/pdf.service.js': { generateResumePDF: async (env, html, o) => { seen.pdfOpts = o; seen.html = html; return new Uint8Array([2]) } },
    })
    return { mod, restore, seen }
  }
  const RD = { name: 'José Núñez', location: 'Nairobi, Kenya', skills: ['SQL'], experience: [{ title: 'Analyst', company: 'Acme', bullets: ['Built dashboards'] }] }

  it('names the files with the shared accent-aware stem, and reads the paper from the applicant\'s location', async () => {
    t = setup(RD)
    const h1 = {}, h2 = {}
    await t.mod.downloadProfileDocx(ctxFor({ headers: h1 }))
    await t.mod.downloadProfilePdf(ctxFor({ headers: h2 }))
    expect(h1['Content-Disposition']).toBe('attachment; filename="Jose-Nunez-Resume.docx"')
    expect(h2['Content-Disposition']).toBe('attachment; filename="Jose-Nunez-Resume.pdf"')
    expect(t.seen.docxOpts.paper).toBe('a4')
    expect(t.seen.pdfOpts.paper).toBe('a4')
    expect(t.seen.html).toMatch(/size: A4/)
  })
  it('keeps Letter for a US location and when the location says nothing', async () => {
    for (const [loc, paper] of [['Austin, TX', 'letter'], ['', 'letter'], [undefined, 'letter']]) {
      t = setup({ ...RD, location: loc })
      await t.mod.downloadProfileDocx(ctxFor({ headers: {} }))
      expect(t.seen.docxOpts.paper).toBe(paper)
      t.restore()
    }
    t = undefined
  })
})
