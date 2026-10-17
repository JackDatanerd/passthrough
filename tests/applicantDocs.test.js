import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { generateAtsDocx, generateCoverLetterDocx, accentHex } from '../src/services/docx.service.js'
import { buildResumeHTML, buildCoverLetterHTML } from '../src/services/pdfTemplate.service.js'
import { hrefFor, displayUrl } from '../src/lib/links.js'
import { densityFor, estimateLoad } from '../src/lib/docFit.js'
import { resumeStem, draftStem, coverLetterStem } from '../src/lib/fileStems.js'
import { paperForLocation, PAPER } from '../src/services/design.service.js'
import { extractText } from '../src/services/resume.parser.js'
import { stripBullet } from '../src/lib/bulletText.js'
import { checkRenderedPdf, allowedPages } from '../src/lib/pdfQa.js'
import { buildPdf, resumePage } from './helpers/pdfBuilder.js'

// APPLICANT DOCS pass: the delivered DOCX / PDF / cover letter as a document the applicant is proud to send.

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const parts = async buf => {
  const z = await JSZip.loadAsync(buf)
  return { doc: await z.file('word/document.xml').async('string'), styles: await z.file('word/styles.xml').async('string') }
}
const JOB = (n, b = 2) => ({ title: `Analyst ${n}`, company: 'Acme', location: 'Nairobi', dates: '2020 – 2022', bullets: Array.from({ length: b }, (_, i) => `Built dashboard ${i} that cut reporting time by ${10 + i}%`) })
const FULL = {
  name: 'Wanjiru Mwangi', email: 'w@mail.com', phone: '+254 712 345 678', location: 'Nairobi, Kenya',
  linkedin: 'linkedin.com/in/wanjiru', portfolio: 'wanjiru.design',
  summary: 'Analyst.', experience: [JOB(1), JOB(2)],
  education: [{ degree: 'MSc X', institution: 'Uni A', dates: '2020' }, { degree: 'BSc Y', institution: 'Uni B', dates: '2016', details: 'Honours.' }],
  skills: ['SQL', 'Python'], certifications: ['AWS CP', 'Google DA'],
  projects: [{ name: 'Matatu', technologies: ['Python'], description: 'Route tool.', link: 'github.com/w/matatu' }],
  awards: ['Award 2023'], languages: ['English', 'Swahili'],
}

describe('lib/links hrefFor', () => {
  it('links addresses, schemes and bare hosts on ANY top-level domain (the old DOCX list knew 13)', () => {
    expect(hrefFor('a@b.co')).toBe('mailto:a@b.co')
    expect(hrefFor('https://x.io/p')).toBe('https://x.io/p')
    for (const h of ['jane.design', 'jane.tech', 'jane.ng', 'jane.co.za', 'jane.in', 'jane.ca', 'jane.edu', 'jane.studio', 'jane.fr', 'jane.com.au', 'linktr.ee/jane', 'www.jane.dev/x?y=1'])
      expect(hrefFor(h)).toBe(`https://${h}`)
  })
  it('turns a phone number into tel: only when asked, and never produces another scheme', () => {
    expect(hrefFor('+254 712 345 678')).toBeNull()
    expect(hrefFor('+254 712 345 678', { phone: true })).toBe('tel:+254712345678')
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.com', 'Nairobi, Kenya', 'a b.com', '3.5', '', null, undefined, 'x'.repeat(400) + '.com'])
      expect(hrefFor(bad, { phone: true })).toBeNull()
  })
  it('displayUrl drops the scheme and trailing slash', () => {
    expect(displayUrl('https://passthrough.app/verify/AB12/')).toBe('passthrough.app/verify/AB12')
  })
})

describe('lib/fileStems', () => {
  it('transliterates accents once, for every download', () => {
    expect(resumeStem('José Núñez')).toBe('Jose-Nunez-Resume')
    expect(resumeStem('Zoë Müller')).toBe('Zoe-Muller-Resume')
    expect(draftStem('José Núñez')).toBe('jose-nunez-resume-draft')
    expect(coverLetterStem('Zoë Müller')).toBe('zoe-muller-cover-letter')
  })
  it('falls back to a plain name when nothing is usable', () => {
    expect(resumeStem('')).toBe('Resume')
    expect(resumeStem('李雷')).toBe('Resume')
    expect(coverLetterStem(null)).toBe('cover-letter')
  })
})

// Shapes whose real page counts were measured (LibreOffice for the DOCX, WeasyPrint for the template): jobs x bullets.
const bl = n => Array.from({ length: n }, (_, i) => `Delivered project ${i} that improved reporting accuracy and reduced manual effort across the finance team by ${10 + i} percent.`)
const SHAPE = (jobs, b) => ({
  name: 'Test Person', email: 't@x.com', phone: '+254 700 000 000', location: 'Nairobi, Kenya', linkedin: 'linkedin.com/in/t',
  summary: 'Analyst with experience across several industries and a record of measurable delivery for stakeholders.',
  experience: Array.from({ length: jobs }, (_, i) => ({ title: 'Analyst ' + i, company: 'Company ' + i, location: 'Nairobi', dates: '2015 – 2018', bullets: bl(b) })),
  education: [{ degree: 'BSc Statistics', institution: 'University of Nairobi', dates: '2010 – 2014' }], skills: ['SQL', 'Python', 'Excel', 'Power BI', 'Tableau'], certifications: ['AWS CP'],
})

describe('lib/docFit', () => {
  it('DOCX: squeezes the sizes that really spill two lines onto page 2, leaves the ones that fit and the ones that need two pages', () => {
    for (const [j, b] of [[4, 4], [5, 3], [7, 2]]) expect(densityFor(SHAPE(j, b), 'a4', 'docx')).toBe('compact')   // 60-62 units: 2 lines on page 2 at normal, 1 page compact
    for (const [j, b] of [[2, 5], [5, 2], [6, 2]]) expect(densityFor(SHAPE(j, b), 'a4', 'docx')).toBe('normal')    // already one page
    for (const [j, b] of [[8, 2], [6, 4], [5, 4]]) expect(densityFor(SHAPE(j, b), 'a4', 'docx')).toBe('normal')    // genuinely two pages, compact would not save it
  })
  it('PDF template: squeezes what spills at normal and compact fixes, leaves what compact cannot fix', () => {
    for (const [j, b] of [[3, 4], [4, 3], [6, 2]]) expect(densityFor(SHAPE(j, b), 'a4', 'pdf')).toBe('compact')
    for (const [j, b] of [[2, 5], [3, 3], [3, 5], [5, 3]]) expect(densityFor(SHAPE(j, b), 'a4', 'pdf')).toBe('normal')
    expect(densityFor(SHAPE(4, 3), 'a4')).toBe(densityFor(SHAPE(4, 3), 'a4', 'pdf'))   // pdf is the default target
  })
  it('Letter holds less than A4', () => {
    const d = SHAPE(3, 4)
    expect(densityFor(d, 'a4', 'pdf')).toBe('compact')
    expect(estimateLoad(d)).toBeGreaterThan(0)
    expect(['normal', 'compact']).toContain(densityFor(d, 'letter', 'docx'))
  })
  it('never throws on junk', () => {
    expect(() => densityFor(null)).not.toThrow()
    expect(() => densityFor({ experience: 'x', skills: 5, projects: [null] }, 'a4', 'docx')).not.toThrow()
    expect(estimateLoad(null)).toBeGreaterThan(0)
  })
})

describe('generateAtsDocx — design layer', () => {
  it('names a font and real heading styles (a paragraph that names none falls back to Times New Roman in Word)', async () => {
    const { doc, styles } = await parts(await generateAtsDocx(FULL, null))
    const h2 = styles.match(/<w:style [^>]*w:styleId="Heading2"[\s\S]*?<\/w:style>/)[0]
    expect(h2).toMatch(/Calibri/)
    expect(h2).toMatch(/<w:b\/>/)
    expect(h2).toMatch(/w:keepNext/)
    expect(h2).toMatch(/w:pBdr/)
    expect(styles).toMatch(/<w:docDefaults>[\s\S]*Calibri[\s\S]*<\/w:docDefaults>/)
    expect(doc).not.toMatch(/Calibri Light/)
  })
  it('hangs wrapped bullets under the text and keeps the literal glyph', async () => {
    const { doc } = await parts(await generateAtsDocx(FULL, null))
    expect(doc).toMatch(/w:hanging="260"/)
    const text = await extractText(await generateAtsDocx(FULL, null), DOCX)
    expect(text).toMatch(/•\tBuilt dashboard 0/)
    expect(text).not.toMatch(/✓/)
    expect(text).toMatch(/•\tAWS CP/)
  })
  it('right-aligns dates with a tab stop, and the extractor does not add a phantom leading tab', async () => {
    const buf = await generateAtsDocx(FULL, null)
    const { doc } = await parts(buf)
    expect(doc).toMatch(/<w:tab w:val="right"/)
    const lines = (await extractText(buf, DOCX)).split('\n')
    const job = lines.find(l => l.includes('Analyst 1'))
    expect(job).toBe('Analyst 1 — Acme — Nairobi\t2020 – 2022')
  })
  it('keeps a title with its first bullet and leaves no trailing blank paragraph', async () => {
    const { doc } = await parts(await generateAtsDocx(FULL, null))
    expect(doc).toMatch(/w:keepNext/)
    const body = doc.match(/<w:body>([\s\S]*)<w:sectPr/)[1]
    expect(body.trimEnd().endsWith('</w:p>')).toBe(true)
    expect(body).not.toMatch(/<w:p\/>/)            // no blank spacer paragraphs anywhere
  })
  it('separates education entries', async () => {
    const { doc } = await parts(await generateAtsDocx(FULL, null))
    const titles = [...doc.matchAll(/<w:p>(?:(?!<\/w:p>)[\s\S])*?(?:MSc X|BSc Y)[\s\S]*?<\/w:p>/g)].map(m => m[0])
    expect(titles.length).toBeGreaterThanOrEqual(2)
    expect(titles[1]).toMatch(/w:spacing[^>]*w:before="\d+"/)
  })
  it('puts the credential on its own line and links every contact detail that is a link', async () => {
    const { doc } = await parts(await generateAtsDocx(FULL, 'https://passthrough.app/verify/AB12'))
    const rels = await (await JSZip.loadAsync(await generateAtsDocx(FULL, 'https://passthrough.app/verify/AB12'))).file('word/_rels/document.xml.rels').async('string')
    for (const t of ['mailto:w@mail.com', 'tel:+254712345678', 'https://linkedin.com/in/wanjiru', 'https://wanjiru.design', 'https://github.com/w/matatu', 'https://passthrough.app/verify/AB12'])
      expect(rels).toContain(t)
    const text = await extractText(await generateAtsDocx(FULL, 'https://passthrough.app/verify/AB12'), DOCX)
    const lines = text.split('\n')
    expect(lines.some(l => l.startsWith('Passthrough Verified: https://passthrough.app/verify/AB12'))).toBe(true)
    expect(doc).toBeTruthy()
  })
  it('keeps the page size by paper and tighter margins than the old 1-inch default', async () => {
    const a4 = (await parts(await generateAtsDocx(FULL, null, { paper: 'a4' }))).doc
    const letter = (await parts(await generateAtsDocx(FULL, null))).doc
    expect(a4).toMatch(/w:pgSz[^>]*w:w="11906"/)
    expect(letter).toMatch(/w:pgSz[^>]*w:w="12240"/)
    expect(a4).not.toMatch(/w:pgMar[^>]*w:left="1440"/)
  })
  it('still produces a valid file for empty input', async () => {
    for (const v of [{}, null, { name: 'Only Name' }]) await expect(generateAtsDocx(v, null)).resolves.toBeTruthy()
  })
})

describe('generateCoverLetterDocx — letterhead', () => {
  it('shares the resume letterhead, with a rule and the date', async () => {
    const buf = await generateCoverLetterDocx('Dear X,\n\nHello there.\n\nSincerely,\nWanjiru', 'Wanjiru Mwangi', { contact: FULL, date: '16 October 2026', paper: 'a4' })
    const { doc, styles } = await parts(buf)
    expect(doc).toMatch(/w:pBdr/)
    expect(doc).toMatch(/w:pgSz[^>]*w:w="11906"/)
    expect(styles).toMatch(/Calibri/)
    const text = await extractText(buf, DOCX)
    expect(text).toContain('Wanjiru Mwangi')
    expect(text).toContain('16 October 2026')
    expect(text).toContain('Hello there.')
  })
  it('is a valid plain letter with just text and a name, or nothing at all', async () => {
    await expect(generateCoverLetterDocx('Dear X,\n\nHi.', 'Jane')).resolves.toBeTruthy()
    await expect(generateCoverLetterDocx('', '')).resolves.toBeTruthy()
  })
})

describe('buildResumeHTML — links, credential, fit, print rules', () => {
  const html = buildResumeHTML(FULL, { paper: 'a4' }, 'https://passthrough.app/verify/AB12', { verified: true })
  it('links the contact line and project link like the DOCX does', () => {
    for (const h of ['mailto:w@mail.com', 'tel:+254712345678', 'https://linkedin.com/in/wanjiru', 'https://wanjiru.design', 'https://github.com/w/matatu'])
      expect(html).toContain(`href="${h}"`)
    expect(html).not.toContain('href="Nairobi')
  })
  it('prints the verification address next to the credential', () => {
    expect(html).toContain('class="credurl"')
    expect(html).toContain('>passthrough.app/verify/AB12<')
    expect(buildResumeHTML(FULL, {}, null)).not.toMatch(/class="credurl"|Passthrough/)
  })
  it('keeps headings with their section and the page box under the printable height', () => {
    expect(html).toMatch(/break-after: avoid/)
    expect(html).toMatch(/min-height: 268mm/)
    expect(buildResumeHTML(FULL, { paper: 'letter' }, null)).toMatch(/min-height: 9\.85in/)
    expect(PAPER.a4.minHeight).toBe('268mm')
  })
  it('goes denser only when the resume is just over a page, and honours an explicit density', () => {
    const none = buildResumeHTML({ name: 'A', experience: [JOB(1)] }, { paper: 'a4' }, null)
    expect(none).toMatch(/line-height: 1\.45/)
    expect(buildResumeHTML({ name: 'A', experience: [JOB(1)] }, { paper: 'a4', density: 'compact' }, null)).toMatch(/line-height: 1\.36/)
  })
  it('escapes everything and never emits another scheme', () => {
    const h = buildResumeHTML({ name: '<b>x</b>', email: 'javascript:alert(1)', linkedin: '"><script>', projects: [{ name: 'P', link: 'data:text/html,x', description: 'd' }] }, {}, null)
    expect(h).not.toMatch(/<script|href="javascript|href="data:/i)
    expect(h).toContain('&lt;b&gt;')
  })
})

describe('buildCoverLetterHTML', () => {
  const html = buildCoverLetterHTML('Dear X,\n\nHi <b>there</b>.\nSecond line.\n\nSincerely,\nJane', FULL, { paper: 'a4' }, { date: '16 October 2026' })
  it('has the letterhead, date and one paragraph per block with line breaks kept', () => {
    expect(html).toContain('<h1>Wanjiru Mwangi</h1>')
    expect(html).toContain('href="mailto:w@mail.com"')
    expect(html).toContain('16 October 2026')
    expect(html).toContain('Hi &lt;b&gt;there&lt;/b&gt;.<br>Second line.')
    expect(html.match(/class="block"/g).length).toBe(3)
    expect(html).toMatch(/size: A4/)
  })
  it('does not throw on empty input', () => {
    expect(() => buildCoverLetterHTML('', null, null)).not.toThrow()
  })
})

describe('paperForLocation', () => {
  it('reads Letter / A4 from the applicant location and says nothing when it cannot tell', () => {
    for (const l of ['Austin, TX', 'Dublin, OH', 'Toronto, Canada', 'New York, NY', 'London, ON']) expect(paperForLocation(l)).toBe('letter')
    for (const l of ['Nairobi, Kenya', 'London, UK', 'Dublin, Ireland', 'Lagos, Nigeria', 'Berlin, DE']) expect(paperForLocation(l)).toBe('a4')
    for (const l of ['', null, 'Somewhere', 'Wilmington, DE', 'Mumbai, IN']) expect(paperForLocation(l)).toBeNull()
  })
})

describe('stripBullet', () => {
  it('removes one pasted marker and nothing that is content', () => {
    for (const [i, o] of [['• Built it', 'Built it'], ['•Built it', 'Built it'], ['- Built it', 'Built it'], ['– Built it', 'Built it'], ['* Built it', 'Built it'], ['· Built it', 'Built it'],
      ['  ●  Built it', 'Built it'], ['• - Built it', 'Built it'], ['▪ ▪ Built it', 'Built it']]) expect(stripBullet(i)).toBe(o)
    for (const keep of ['5% growth in revenue', '-based architecture', '–5% churn', '2019 – 2021 at Acme', 'Built it', '• ', '-']) expect(stripBullet(keep)).toBe(keep)
    expect(stripBullet(null)).toBe('')
  })
  it('a bullet that arrives with its own glyph is not doubled in the DOCX or the PDF', async () => {
    const rd = { name: 'A', experience: [{ title: 'Eng', company: 'X', dates: '2020', bullets: ['• Pasted bullet', '- Dash bullet', '* Star bullet', 'Plain bullet'] }], certifications: ['• AWS'], projects: [{ name: 'P', description: '• Desc' }] }
    const text = await extractText(await generateAtsDocx(rd, null), DOCX)
    expect(text).toMatch(/^•\tPasted bullet$/m)
    expect(text).toMatch(/^•\tDash bullet$/m)
    expect(text).toMatch(/^•\tAWS$/m)
    expect(text).not.toMatch(/•\t[•*-]/)
    const html = buildResumeHTML(rd, {}, null)
    expect(html).toContain('<li>Pasted bullet</li>')
    expect(html).toContain('<li>Dash bullet</li>')
    expect(html).toContain('<li>AWS</li>')
    expect(html).toContain('<li>Desc</li>')
  })
})

describe('the location is never a link', () => {
  const rd = { name: 'A', email: 'a@b.co', location: 'St.Louis', linkedin: 'linkedin.com/in/a' }
  it('DOCX and PDF template keep "St.Louis" as text and still link the rest', async () => {
    const z = await JSZip.loadAsync(await generateAtsDocx(rd, null))
    const rels = await z.file('word/_rels/document.xml.rels').async('string')
    expect(rels).not.toContain('St.Louis')
    expect(rels).toContain('https://linkedin.com/in/a')
    const html = buildResumeHTML(rd, {}, null)
    expect(html).not.toContain('href="https://St.Louis"')
    expect(html).toContain('St.Louis')
    expect(html).toContain('href="https://linkedin.com/in/a"')
    expect(buildCoverLetterHTML('Hi', rd, {}, {})).not.toContain('href="https://St.Louis"')
  })
})

describe('checkRenderedPdf — the render gate for delivered PDFs', () => {
  const DATA = { name: 'Jane Doe', email: 'jane@example.com', experience: [{ title: 'Developer', company: 'Foo', bullets: ['x'] }] }
  it('passes a clean single-column resume that carries the name and email', async () => {
    const r = await checkRenderedPdf(buildPdf([resumePage()]), DATA)
    expect(r.reasons).toEqual([])
    expect(r.ok).toBe(true)
  })
  it('rejects a layout with far more pages than the content needs', async () => {
    const r = await checkRenderedPdf(buildPdf([resumePage(), resumePage(), resumePage(), resumePage(), resumePage()]), DATA)
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/5 pages/)
    expect(allowedPages(DATA)).toBe(2)
  })
  it('rejects hidden text (tiny type)', async () => {
    const r = await checkRenderedPdf(buildPdf([resumePage([{ text: 'keyword stuffing react node aws', x: 50, y: 40, size: 2 }])]), DATA)
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('hidden text')
  })
  it('rejects a PDF whose text does not carry the candidate name or email', async () => {
    const r = await checkRenderedPdf(buildPdf([resumePage()]), { ...DATA, name: 'Someone Else', email: 'other@x.com' })
    expect(r.ok).toBe(false)
    expect(r.reasons).toEqual(expect.arrayContaining(['name missing from the PDF text', 'email missing from the PDF text']))
  })
  it('never blocks on its own failure: unreadable bytes are skipped, not rejected', async () => {
    const r = await checkRenderedPdf(new Uint8Array([1, 2, 3]), DATA)
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe(true)
  })
})

// ── pass 3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const contrastWhite = hex => 1.05 / (lum(hex) + 0.05)

describe('section rules are visible on every palette', () => {
  const RD = { name: 'A', summary: 'S', skills: ['x'] }
  it('draws the rule from the primary colour, not the pale accent tint', () => {
    for (const [primary, accent] of [['#374151', '#F3F4F6'], ['#B45309', '#FEF3C7'], ['#111827', '#E5E7EB'], ['#1E3A8A', '#CBD5E1']]) {
      const html = buildResumeHTML(RD, { palette: { bg: '#FFFFFF', primary, accent, text: '#111' } }, null)
      const rule = /border-bottom: 1px solid (#[0-9a-f]{6})/i.exec(html)[1]
      expect(rule.toLowerCase()).not.toBe(accent.toLowerCase())
      expect(contrastWhite(rule)).toBeGreaterThan(1.8)        // the old accent rules sat at 1.1-1.4: invisible on paper
      const cl = buildCoverLetterHTML('Hi', { name: 'A', email: 'a@b.co' }, { palette: { bg: '#FFFFFF', primary, accent, text: '#111' } }, {})
      expect(cl).toContain(`border-bottom: 1px solid ${rule}`)
    }
  })
})

describe('skills and languages are not doubled either', () => {
  const rd = { name: 'A', skills: ['• SQL', '- Python', '* R', 'Excel'], languages: ['• English', '– Swahili'], experience: [{ title: 'E', company: 'X', bullets: ['b'] }] }
  it('strips a pasted glyph from every entry in the DOCX and the PDF template', async () => {
    const text = await extractText(await generateAtsDocx(rd, null), DOCX)
    expect(text).toContain('SQL · Python · R · Excel')
    expect(text).toContain('English · Swahili')
    const html = buildResumeHTML(rd, {}, null)
    expect(html).toContain('SQL &middot; Python &middot; R &middot; Excel')
    expect(html).toContain('English &middot; Swahili')
  })
})

describe('a running footer after page one', () => {
  it('DOCX: "Name · Page X of Y" on every page but the first, nothing on a single page', async () => {
    const z = await JSZip.loadAsync(await generateAtsDocx(FULL, null))
    const names = Object.keys(z.files).filter(n => /word\/footer\d+\.xml$/.test(n))
    expect(names.length).toBe(2)
    const xmls = await Promise.all(names.map(n => z.file(n).async('string')))
    const withText = xmls.filter(x => /PAGE/.test(x))
    expect(withText.length).toBe(1)
    expect(withText[0]).toMatch(/NUMPAGES/)
    expect(withText[0]).toContain('Wanjiru Mwangi')
    expect(xmls.find(x => !/PAGE/.test(x)).replace(/<[^>]+>/g, '').trim()).toBe('')
    const doc = await z.file('word/document.xml').async('string')
    expect(doc).toMatch(/<w:titlePg\/>/)
    expect(doc).toMatch(/w:footer="400"/)
  })
  it('DOCX without a name still gets "Page X of Y"', async () => {
    const z = await JSZip.loadAsync(await generateAtsDocx({ skills: ['x'] }, null))
    const xmls = await Promise.all(Object.keys(z.files).filter(n => /word\/footer\d+\.xml$/.test(n)).map(n => z.file(n).async('string')))
    expect(xmls.some(x => /Page /.test(x) && /PAGE/.test(x))).toBe(true)
  })
  it('PDF template: margin-box footer after page one, with the name safely escaped', () => {
    const html = buildResumeHTML({ name: 'Wanjiru "Wa\\" <Mwangi>' , skills: ['x'] }, { paper: 'a4' }, null)
    expect(html).toMatch(/@bottom-center \{ content: "Wanjiru Wa Mwangi  \\00B7  Page " counter\(page\) " of " counter\(pages\)/)
    expect(html).toMatch(/@page :first \{ @bottom-center \{ content: none \} \}/)
    expect(buildResumeHTML({ skills: ['x'] }, {}, null)).toMatch(/content: "Page " counter\(page\)/)
  })
})

describe('very long unbroken strings stay on the page', () => {
  it('sets overflow-wrap on the page body of the resume and the letter', () => {
    expect(buildResumeHTML({ name: 'A' }, {}, null)).toMatch(/overflow-wrap: anywhere/)
    expect(buildCoverLetterHTML('Hi', { name: 'A' }, {}, {})).toMatch(/overflow-wrap: anywhere/)
  })
})

// ── pass 5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('phone links', () => {
  it('links a number with the plus anywhere before the first digit, and keeps the plus', () => {
    for (const [i, o] of [['+254 712 345 678', 'tel:+254712345678'], ['(+254) 712 345 678', 'tel:+254712345678'], ['+(254) 712-345-678', 'tel:+254712345678'],
      ['+1 (415) 555-0100', 'tel:+14155550100'], ['(415) 555-0100', 'tel:4155550100'], ['0712 345 678', 'tel:0712345678']])
      expect(hrefFor(i, { phone: true })).toBe(o)
    for (const bad of ['12345', '(+) 1234567', '2020 – 2022', '+', '(+254) call me', '1234567890123456789'])
      expect(hrefFor(bad, { phone: true })).toBeNull()
  })
})

describe('the Word files take the PDF\'s palette colour', () => {
  const colorsIn = xml => [...xml.matchAll(/<w:color w:val="([0-9A-Fa-f]{6})"/g)].map(m => m[1].toUpperCase())
  it('accentHex accepts a 6-digit hex with or without # and falls back to the template blue otherwise', () => {
    expect(accentHex('#b45309')).toBe('B45309')
    expect(accentHex('1e3a8a')).toBe('1E3A8A')
    for (const bad of [undefined, null, '', 'red', '#12345', '#GGGGGG', 'javascript:1']) expect(accentHex(bad)).toBe('1E40AF')
  })
  it('colours the name, the headings and their rules in the resume', async () => {
    const { doc, styles } = await parts(await generateAtsDocx(FULL, null, { accent: '#B45309' }))
    expect(colorsIn(doc)).toContain('B45309')
    expect(styles).toMatch(/w:styleId="Heading2"[\s\S]*?w:color w:val="B45309"[\s\S]*?<\/w:style>/)
    expect(styles.match(/w:styleId="Heading2"[\s\S]*?<\/w:style>/)[0]).toMatch(/<w:bottom [^>]*w:color="B45309"/)
    expect(doc).not.toMatch(/1F3A5F/i)
  })
  it('does the same for the cover letter, and defaults to the template blue', async () => {
    const letter = await parts(await generateCoverLetterDocx('Dear X,\n\nHi.', 'A B', { contact: FULL, accent: '#0F766E' }))
    expect(colorsIn(letter.doc)).toContain('0F766E')
    expect(letter.doc).toMatch(/<w:bottom [^>]*w:color="0F766E"/)
    expect(colorsIn((await parts(await generateAtsDocx(FULL, null))).doc)).toContain('1E40AF')
  })
})
