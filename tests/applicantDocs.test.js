import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { generateAtsDocx, generateCoverLetterDocx, accentHex, textHex } from '../src/services/docx.service.js'
import { buildResumeHTML, buildCoverLetterHTML } from '../src/services/pdfTemplate.service.js'
import { hrefFor, displayUrl } from '../src/lib/links.js'
import { densityFor, estimateLoad, letterDensityFor, LETTER_WORDS } from '../src/lib/docFit.js'
import { resumeStem, draftStem, coverLetterStem, disposition } from '../src/lib/fileStems.js'
import { paperForLocation } from '../src/services/design.service.js'
import { extractText } from '../src/services/resume.parser.js'
import { stripBullet } from '../src/lib/bulletText.js'
import { contactRows, contactItems } from '../src/lib/contactLayout.js'
import { isSerifHeading } from '../src/lib/typeface.js'
import { FONT_FACE_CSS } from '../src/lib/embeddedFonts.js'
import { unligature } from '../src/lib/textClean.js'
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
    expect(html).not.toMatch(/\.page \{[^}]*min-height/)
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
    expect(html).toContain('<li dir="auto">Pasted bullet</li>')
    expect(html).toContain('<li dir="auto">Dash bullet</li>')
    expect(html).toContain('<li dir="auto">AWS</li>')
    expect(html).toContain('<li dir="auto">Desc</li>')
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
    expect(text).toContain('SQL, Python, R, Excel')
    expect(text).toContain('English, Swahili')
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

// ── pass 6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const SHORT = { name: 'A B', email: 'a@b.co', phone: '+254 712 345 678', location: 'Nairobi', linkedin: 'linkedin.com/in/ab', summary: 'S.', skills: ['x'] }
const LONG = { ...SHORT, email: 'wanjiru.mwangi.analytics@gmail.com', location: 'Nairobi, Kenya (open to relocation)', linkedin: 'linkedin.com/in/wanjirumwangi-data-analyst', portfolio: 'wanjiru-mwangi.portfolio.dev/projects' }

describe('contact rows', () => {
  it('one row when it fits, two (details, then links) when it would not, never an empty row', () => {
    expect(contactRows(contactItems(SHORT))).toHaveLength(1)
    const rows = contactRows(contactItems(LONG))
    expect(rows).toHaveLength(2)
    expect(rows[0].map(i => i.text)).toEqual([LONG.email, LONG.phone, LONG.location])
    expect(rows[1].map(i => i.text)).toEqual([LONG.linkedin, LONG.portfolio])
    // all-details or all-links stay on one row however long
    expect(contactRows(contactItems({ email: 'x'.repeat(60) + '@mail.com', phone: '+254 712 345 678', location: 'y'.repeat(40) }))).toHaveLength(1)
    expect(contactRows(contactItems({ linkedin: 'linkedin.com/in/' + 'a'.repeat(60), portfolio: 'b'.repeat(60) + '.dev' }))).toHaveLength(1)
    expect(contactRows([])).toEqual([])
    expect(contactRows(null)).toEqual([])
    expect(contactItems({ location: 'St.Louis' })[0].link).toBe(false)
  })
  it('PDF template: whole items only, the separator stays with the item before it', () => {
    const one = buildResumeHTML(SHORT, { paper: 'a4' }, null)
    expect(one.match(/<p class="contact/g)).toHaveLength(1)
    const two = buildResumeHTML(LONG, { paper: 'a4' }, null)
    expect(two).toMatch(/<p class="contact more">/)
    expect(two.match(/<p class="contact/g)).toHaveLength(2)
    expect(two).toMatch(/<span class="nw"><a href="mailto:[^"]+">[^<]+<\/a> &nbsp;\|<\/span> <span class="nw"><a href="tel:/)
    expect(two).toMatch(/\.nw \{ white-space: nowrap \}/)
    expect(two).not.toMatch(/<span class="nw">\s*&nbsp;\|/)         // no separator at the start of an item
    expect(buildCoverLetterHTML('Hi', LONG, { paper: 'a4' }, {}).match(/<p class="contact/g)).toHaveLength(2)
  })
  it('DOCX and the Word letter: the links go on a second line, text order unchanged', async () => {
    const text = await extractText(await generateAtsDocx(LONG, null), DOCX)
    expect(text).toContain(`${LONG.email} | ${LONG.phone} | ${LONG.location}\n${LONG.linkedin} | ${LONG.portfolio}`)
    const short = await extractText(await generateAtsDocx(SHORT, null), DOCX)
    expect(short).toContain('a@b.co | +254 712 345 678 | Nairobi | linkedin.com/in/ab')
    const letter = await extractText(await generateCoverLetterDocx('Dear X,\n\nHi.', 'A B', { contact: LONG }), DOCX)
    expect(letter).toContain(`${LONG.location}\n${LONG.linkedin} | ${LONG.portfolio}`)
  })
})

describe('the credential check mark is drawn, not typed', () => {
  it('uses an inline SVG and no U+2713 in the template', () => {
    const html = buildResumeHTML(SHORT, { paper: 'a4' }, 'https://usepassthrough.com/verify/AB12', { verified: true })
    expect(html).toContain('class="ck"')
    expect(html).toMatch(/<a class="cred"[^>]*><svg[^>]*aria-hidden="true">[\s\S]*<\/svg>Passthrough Verified<\/a>/)
    expect(html).not.toMatch(/&#10003;|✓|\u2713/)
    const unverified = buildResumeHTML(SHORT, { paper: 'a4' }, 'https://usepassthrough.com/verify/AB12', { verified: false })
    expect(unverified).not.toContain('class="ck"')
    expect(unverified).toContain('Passthrough Scan Report')
  })
})

describe('the Word heading face follows the PDF', () => {
  it('isSerifHeading matches the template\'s serif palettes only', () => {
    for (const n of ['Merriweather', 'Playfair Display', 'Libre Baskerville', 'Cormorant Garamond', 'Crimson Text']) expect(isSerifHeading(n)).toBe(true)
    for (const n of ['Raleway', 'Inter', 'Montserrat', '', null, undefined]) expect(isSerifHeading(n)).toBe(false)
  })
  it('Georgia headings and name when serif, Calibri otherwise, in the resume and the letter', async () => {
    const serif = await parts(await generateAtsDocx(FULL, null, { serif: true }))
    expect(serif.styles.match(/w:styleId="Heading2"[\s\S]*?<\/w:style>/)[0]).toMatch(/Georgia/)
    expect(serif.doc).toMatch(/Georgia/)
    const sans = await parts(await generateAtsDocx(FULL, null))
    expect(sans.styles.match(/w:styleId="Heading2"[\s\S]*?<\/w:style>/)[0]).toMatch(/Calibri/)
    expect(sans.doc).not.toMatch(/Georgia/)
    const letter = await parts(await generateCoverLetterDocx('Dear X,\n\nHi.', 'A B', { contact: SHORT, serif: true }))
    expect(letter.doc).toMatch(/Georgia/)
  })
})

// ── pass 7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the Word body copy takes the PDF\'s text colour', () => {
  it('textHex: a 6-digit hex with or without #, otherwise none (automatic black)', () => {
    expect(textHex('#14532d')).toBe('14532D')
    expect(textHex('111827')).toBe('111827')
    for (const bad of [undefined, null, '', 'black', '#12345', 'rgb(0,0,0)']) expect(textHex(bad)).toBeUndefined()
  })
  it('sets it as the document default in the resume and the letter, and sets nothing without one', async () => {
    const def = xml => xml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)[0]
    expect(def((await parts(await generateAtsDocx(FULL, null, { text: '#14532D' }))).styles)).toMatch(/w:color w:val="14532D"/)
    expect(def((await parts(await generateCoverLetterDocx('Dear X,\n\nHi.', 'A B', { contact: FULL, text: '#451A03' }))).styles)).toMatch(/w:color w:val="451A03"/)
    expect(def((await parts(await generateAtsDocx(FULL, null))).styles)).not.toMatch(/w:color/)
    expect(def((await parts(await generateAtsDocx(FULL, null, { text: 'nope' }))).styles)).not.toMatch(/w:color/)
  })
  it('headings, links and the muted dates keep their own colours', async () => {
    const { doc, styles } = await parts(await generateAtsDocx(FULL, null, { accent: '#B45309', text: '#451A03' }))
    expect(styles.match(/w:styleId="Heading2"[\s\S]*?<\/w:style>/)[0]).toMatch(/w:color w:val="B45309"/)
    // Links are set in the document's own ink (like the PDF's), not a fixed Word blue beside a palette accent.
    expect(doc).not.toMatch(/0563C1/)
    expect(doc).toMatch(/<w:hyperlink[\s\S]*?w:color w:val="451A03"/)
    expect(doc).toMatch(/w:color w:val="5B6470"/)
  })
})

describe('a cover letter that is only just over a page is tightened', () => {
  const words = n => Array.from({ length: n }, (_, i) => 'word' + (i % 97)).join(' ')
  it('letterDensityFor: normal up to the page, compact for a modest overflow, normal again when two pages are honest', () => {
    for (const [n, target, want] of [[300, 'pdf', 'normal'], [380, 'pdf', 'compact'], [425, 'pdf', 'compact'], [470, 'pdf', 'normal'],
      [450, 'docx', 'normal'], [471, 'docx', 'compact'], [560, 'docx', 'compact'], [700, 'docx', 'normal']])
      expect(letterDensityFor(words(n), 'a4', target)).toBe(want)
    expect(letterDensityFor(words(350), 'letter', 'pdf')).toBe('compact')          // Letter holds less than A4 (350 is normal on A4)
    expect(letterDensityFor(words(350), 'a4', 'pdf')).toBe('normal')
    expect(letterDensityFor('', 'a4')).toBe('normal')
    expect(letterDensityFor(null, 'a4', 'docx')).toBe('normal')
    expect(LETTER_WORDS.pdf.normal).toBeLessThan(LETTER_WORDS.docx.normal)
  })
  it('the PDF letter and the Word letter pick the denser layout by themselves, and honour an explicit density', async () => {
    const body = n => `Dear X,\n\n${words(n)}.\n\nSincerely,\nA B`
    expect(buildCoverLetterHTML(body(420), SHORT, { paper: 'a4' }, {})).toMatch(/line-height: 1\.42/)
    expect(buildCoverLetterHTML(body(300), SHORT, { paper: 'a4' }, {})).toMatch(/line-height: 1\.55/)
    expect(buildCoverLetterHTML(body(300), SHORT, { paper: 'a4', density: 'compact' }, {})).toMatch(/line-height: 1\.42/)
    const sz = async (n, o = {}) => (await parts(await generateCoverLetterDocx(body(n), 'A B', { contact: SHORT, paper: 'a4', ...o }))).doc.match(/<w:pgMar[^>]*w:left="(\d+)"/)[1]
    expect(await sz(300)).toBe('1300')
    expect(await sz(520)).toBe('1150')
    expect(await sz(300, { density: 'compact' })).toBe('1150')
  })
})

// ── pass 8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('embedded fonts', () => {
  const faces = [...FONT_FACE_CSS.matchAll(/@font-face \{ font-family: "([^"]+)"; font-weight: (\d+);[^}]*src: url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\) format\("woff2"\); unicode-range: ([^}]+?) \}/g)]
  it('are fifteen real woff2 faces (Latin, Latin Extended, Vietnamese, Cyrillic, Greek x Sans 400/700 and Serif 700) as data URIs, each with its own unicode-range, within a size budget', () => {
    expect(faces).toHaveLength(15)
    const names = faces.map(f => `${f[1]} ${f[2]}`)
    expect(names.filter(n => n === 'DocSans 400')).toHaveLength(5)
    expect(names.filter(n => n === 'DocSans 700')).toHaveLength(5)
    expect(names.filter(n => n === 'DocSerif 700')).toHaveLength(5)
    let total = 0
    for (const f of faces) { const bytes = Buffer.from(f[3], 'base64'); total += bytes.length; expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2') }
    expect(total).toBeLessThan(260 * 1024)
    expect(FONT_FACE_CSS).not.toMatch(/https?:\/\//)
    // a face without a unicode-range would claim every character and shadow the others: the three subsets must have three different ranges
    for (const fam of ['DocSans', 'DocSerif']) expect(new Set(faces.filter(f => f[1] === fam).map(f => f[4])).size).toBe(5)
    expect(faces.find(f => /U\+0000-00FF/.test(f[4]))).toBeTruthy()   // Latin
    expect(faces.find(f => /U\+0100-02BA/.test(f[4]))).toBeTruthy()   // Latin Extended: Polish, Czech, Turkish, Romanian ...
    expect(faces.find(f => /U\+1EA0-1EF9/.test(f[4]))).toBeTruthy()   // Vietnamese
    expect(faces.find(f => /U\+0400-045F/.test(f[4]))).toBeTruthy()   // Cyrillic: Russian, Ukrainian, Bulgarian, Serbian ...
    expect(faces.find(f => /U\+0370-0377/.test(f[4]))).toBeTruthy()   // Greek
  })
  it('lead the font stacks of the resume and the letter, and never mention the product name', () => {
    const sans = buildResumeHTML({ name: 'A', skills: ['x'] }, { paper: 'a4', fonts: { heading: 'Raleway' } }, null)
    expect(sans.match(/@font-face/g)).toHaveLength(15)
    expect(sans).toContain('font-family: "DocSans", "Helvetica Neue", Arial')
    expect(sans).not.toMatch(/Passthrough/)
    const serif = buildResumeHTML({ name: 'A', skills: ['x'] }, { paper: 'a4', fonts: { heading: 'Merriweather' } }, null)
    expect(serif).toContain('font-family: "DocSerif", Georgia')
    const letter = buildCoverLetterHTML('Hi', { name: 'A' }, { paper: 'a4' }, {})
    expect(letter.match(/@font-face/g)).toHaveLength(15)
    expect(letter).toContain('"DocSans"')
  })
})

describe('right-to-left text', () => {
  const AR = { name: 'وانجيرو مويانجي', summary: 'محلل بيانات لديه خمس سنوات من الخبرة.', skills: ['SQL', 'بايثون'], experience: [{ title: 'محلل', company: 'سفاري', dates: '2022', bullets: ['بنيت لوحة معلومات.', 'Built a dashboard.'] }] }
  it('PDF template: each block takes its own direction, and list markers follow their item', () => {
    const html = buildResumeHTML(AR, { paper: 'a4' }, null)
    expect(html).toMatch(/unicode-bidi: plaintext/)
    expect(html.match(/<li dir="auto">/g).length).toBeGreaterThanOrEqual(2)
  })
  it('DOCX: Arabic bullets and paragraphs are right-to-left, English ones are untouched', async () => {
    const { doc } = await parts(await generateAtsDocx(AR, null))
    const paras = doc.match(/<w:p>[\s\S]*?<\/w:p>/g)
    const ar = paras.find(p => p.includes('بنيت لوحة'))
    const en = paras.find(p => p.includes('Built a dashboard.'))
    expect(ar).toMatch(/<w:bidi\/>/)
    expect(ar).toMatch(/<w:rtl\/>/)
    expect(en).not.toMatch(/<w:bidi\/>/)
    expect(en).not.toMatch(/<w:rtl\/>/)
    expect(paras.find(p => p.includes('محلل بيانات'))).toMatch(/<w:bidi\/>/)
    expect((await parts(await generateAtsDocx(FULL, null))).doc).not.toMatch(/<w:bidi\/>/)
  })
})

describe('ligature code points are letters again', () => {
  it('unligature expands the seven ligature characters and nothing else', () => {
    expect(unligature('\uFB01nance \uFB02ow o\uFB03ce \uFB00 \uFB04 \uFB05 \uFB06')).toBe('finance flow office ff ffl st st')
    expect(unligature('5² ™ ½ é ＡＢ plain')).toBe('5² ™ ½ é ＡＢ plain')
    expect(unligature(null)).toBeNull()
    expect(unligature(42)).toBe(42)
  })
  it('the Word file and the PDF template never carry one (an ATS matching "finance" would miss "\uFB01nance")', async () => {
    const rd = { name: 'A', summary: '\uFB01nance o\uFB03ce', skills: ['\uFB02ow'], experience: [{ title: 'Of\uFB01cer', company: 'X', bullets: ['e\uFB03cient \uFB01x'] }] }
    const text = await extractText(await generateAtsDocx(rd, null), DOCX)
    expect(text).not.toMatch(/[\uFB00-\uFB06]/)
    expect(text).toContain('finance office')
    expect(text).toContain('efficient fix')
    const html = buildResumeHTML(rd, { paper: 'a4' }, null)
    expect(html.replace(/<style>[\s\S]*?<\/style>/, '')).not.toMatch(/[\uFB00-\uFB06]/)
    expect(html).toContain('finance office')
    expect(buildCoverLetterHTML('o\uFB03ce', rd, { paper: 'a4' }, {})).not.toMatch(/[\uFB00-\uFB06]/)
  })
})

describe('Word does not mark the applicant\'s own details as spelling errors', () => {
  const lang = xml => (xml.match(/<w:lang w:val="([^"]+)"/) || [])[1]
  const para = (doc, needle) => doc.match(/<w:p>[\s\S]*?<\/w:p>/g).find(p => p.includes(needle))
  const RD = { name: 'Wanjiru Mwangi', email: 'w@mail.com', linkedin: 'linkedin.com/in/wanjirumwangi-data', summary: 'We optimise the colour programme.',
    skills: ['SQL', 'dbt'], languages: ['Swahili'], certifications: ['AWS Cloud Practitioner'], awards: ['Safaricom Innovation Award'],
    experience: [{ title: 'Analyst', company: 'Safaricom', dates: '2020', bullets: ['Optimised the pricing model.'] }],
    education: [{ degree: 'BSc', institution: 'University of Nairobi', dates: '2014', details: 'Dissertation on forecasting.' }],
    projects: [{ name: 'Matatu Optimiser', technologies: ['OR-Tools'], description: 'Route tool.', link: 'github.com/w/matatu' }] }
  it('sets the document language from the paper: A4 is en-GB, Letter is en-US', async () => {
    expect(lang((await parts(await generateAtsDocx(RD, null, { paper: 'a4' }))).styles)).toBe('en-GB')
    expect(lang((await parts(await generateAtsDocx(RD, null, { paper: 'letter' }))).styles)).toBe('en-US')
    expect(lang((await parts(await generateAtsDocx(RD, null))).styles)).toBe('en-US')
    expect(lang((await parts(await generateCoverLetterDocx('Dear X,\n\nHi.', 'A', { paper: 'a4' }))).styles)).toBe('en-GB')
    expect(lang((await parts(await generateCoverLetterDocx('Dear X,\n\nHi.', 'A', { paper: 'letter' }))).styles)).toBe('en-US')
  })
  it('exempts names, links, title lines, skills, certifications and awards - and still checks the prose', async () => {
    const { doc } = await parts(await generateAtsDocx(RD, 'https://usepassthrough.com/verify/AB12', { paper: 'a4' }))
    for (const needle of ['Wanjiru Mwangi', 'w@mail.com', 'linkedin.com/in/wanjirumwangi-data', 'verify/AB12', 'Safaricom', 'University of Nairobi', 'Matatu Optimiser', 'OR-Tools', 'github.com/w/matatu', 'dbt', 'Swahili', 'AWS Cloud Practitioner', 'Safaricom Innovation Award'])
      expect(para(doc, needle), needle).toMatch(/<w:noProof\/>/)
    for (const needle of ['We optimise the colour programme.', 'Optimised the pricing model.', 'Dissertation on forecasting.', 'Route tool.'])
      expect(para(doc, needle), needle).not.toMatch(/<w:noProof\/>/)
  })
  it('exempts the page footer and the letterhead of the letter, not the letter itself', async () => {
    const z = await JSZip.loadAsync(await generateAtsDocx(RD, null))
    const footers = await Promise.all(Object.keys(z.files).filter(n => /word\/footer\d+\.xml$/.test(n)).map(n => z.file(n).async('string')))
    expect(footers.find(x => /PAGE/.test(x))).toMatch(/<w:noProof\/>/)
    const { doc } = await parts(await generateCoverLetterDocx('Dear X,\n\nWe optimise the colour.', 'Wanjiru Mwangi', { contact: RD }))
    expect(para(doc, 'Wanjiru Mwangi')).toMatch(/<w:noProof\/>/)
    expect(para(doc, 'w@mail.com')).toMatch(/<w:noProof\/>/)
    expect(para(doc, 'We optimise the colour.')).not.toMatch(/<w:noProof\/>/)
  })
})

// ── pass 10 ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('download filenames keep the applicant\'s own script', () => {
  it('Latin names (accents folded) keep the plain ASCII header exactly as before', () => {
    expect(disposition('resume', 'José Núñez', 'pdf')).toBe('attachment; filename="Jose-Nunez-Resume.pdf"')
    expect(disposition('draft', 'Zoë Müller', 'docx')).toBe('attachment; filename="zoe-muller-resume-draft.docx"')
    expect(disposition('letter', 'Jane Doe', 'pdf')).toBe('attachment; filename="jane-doe-cover-letter.pdf"')
    expect(disposition('resume', '', 'pdf')).toBe('attachment; filename="Resume.pdf"')
    expect(disposition('resume', null, 'docx')).toBe('attachment; filename="Resume.docx"')
  })
  it('names with letters folding cannot reach also carry an RFC 5987 filename*', () => {
    const dec = h => decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(h)[1])
    const cyr = disposition('resume', 'Анна Иванова', 'pdf')
    expect(cyr).toMatch(/^attachment; filename="Resume\.pdf"; filename\*=UTF-8''/)
    expect(dec(cyr)).toBe('Анна-Иванова-Resume.pdf')
    expect(dec(disposition('resume', 'Анна Smith', 'docx'))).toBe('Анна-Smith-Resume.docx')
    expect(dec(disposition('resume', '李雷', 'pdf'))).toBe('李雷-Resume.pdf')
    expect(dec(disposition('letter', 'Νίκος Π.', 'docx'))).toBe('νίκος-π-cover-letter.docx')
    expect(dec(disposition('draft', 'وانجيرو مويانجي', 'pdf'))).toBe('وانجيرو-مويانجي-resume-draft.pdf')
    expect(disposition('resume', 'Анна Smith', 'docx')).toContain('filename="Smith-Resume.docx"')
  })
  it('never lets a name carry quotes, slashes, controls or a header break into the header, and caps the length', () => {
    const h = disposition('resume', 'Анна "Q"; filename=evil.exe\r\nX-Injected: 1/../../etc', 'pdf')
    expect(h).not.toMatch(/[\r\n]/)
    const star = /filename\*=UTF-8''([^;]+)$/.exec(h)[1]
    expect(star).toMatch(/^[A-Za-z0-9%._-]+$/)
    expect(decodeURIComponent(star)).not.toMatch(/[\\/"';:\r\n]/)
    expect([...decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition('resume', 'Я'.repeat(200), 'pdf'))[1])].length).toBeLessThanOrEqual(40 + '-Resume.pdf'.length)
  })
})

describe('the accent stripe is on every page', () => {
  it('is one fixed element carried through the print margins, not a border that ends with the content', () => {
    for (const html of [buildResumeHTML(FULL, { paper: 'a4' }, null), buildResumeHTML(FULL, { paper: 'letter' }, null), buildCoverLetterHTML('Hi', FULL, { paper: 'a4' }, {})]) {
      expect(html).toMatch(/body::before \{ content: ""; position: fixed; left: 0; top: -14mm; bottom: -14mm; width: 4px; background: #[0-9A-Fa-f]{6} \}/)
      expect(html).not.toMatch(/\.page \{[^}]*border-left/)
      expect(html).not.toMatch(/\.page \{[^}]*min-height/)
      expect(html).toMatch(/\.page \{ width: [^;]+; padding: 0 \d+mm 0 calc\(\d+mm \+ 4px\) \}/)    // the text stays where it was, 4px stripe included
    }
  })
})
