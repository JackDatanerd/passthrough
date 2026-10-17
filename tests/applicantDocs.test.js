import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { generateAtsDocx, generateCoverLetterDocx } from '../src/services/docx.service.js'
import { buildResumeHTML, buildCoverLetterHTML } from '../src/services/pdfTemplate.service.js'
import { hrefFor, displayUrl } from '../src/lib/links.js'
import { densityFor, estimateLoad } from '../src/lib/docFit.js'
import { resumeStem, draftStem, coverLetterStem } from '../src/lib/fileStems.js'
import { paperForLocation, PAPER } from '../src/services/design.service.js'
import { extractText } from '../src/services/resume.parser.js'

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

describe('lib/docFit', () => {
  it('leaves a short resume and a clearly two-page resume alone, and tightens one that is just over a page', () => {
    expect(densityFor({ name: 'A', summary: 'Hi.', experience: [JOB(1)] }, 'a4')).toBe('normal')
    expect(densityFor({ experience: Array.from({ length: 14 }, (_, i) => JOB(i, 4)) }, 'a4')).toBe('normal')
    const edge = { summary: 'x'.repeat(300), experience: [JOB(1, 4), JOB(2, 4), JOB(3, 4)], education: [{ degree: 'BSc', institution: 'U', dates: '2016' }], skills: ['a', 'b'] }
    // Find a size just over capacity by adding jobs one at a time.
    let d = { ...edge }, n = 4
    while (densityFor(d, 'a4') === 'normal' && n < 12) d = { ...edge, experience: [...edge.experience, ...Array.from({ length: n - 3 }, (_, i) => JOB(10 + i, 3))] }, n++
    expect(densityFor(d, 'a4')).toBe('compact')
  })
  it('Letter holds less than A4', () => {
    const d = { summary: 'x'.repeat(200), experience: [JOB(1, 4), JOB(2, 4), JOB(3, 3), JOB(4, 2)], education: [{ degree: 'BSc', institution: 'U' }], skills: ['a'] }
    const a4 = densityFor(d, 'a4'), letter = densityFor(d, 'letter')
    expect(['normal', 'compact']).toContain(a4)
    expect(['normal', 'compact']).toContain(letter)
    expect(estimateLoad(d)).toBeGreaterThan(0)
  })
  it('never throws on junk', () => {
    expect(() => densityFor(null)).not.toThrow()
    expect(() => densityFor({ experience: 'x', skills: 5, projects: [null] })).not.toThrow()
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
