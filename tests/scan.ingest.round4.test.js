// Scan/ATS round 4 — what an uploaded file's ingest now sees and refuses. Real PDF / DOCX bytes throughout.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'module'
import JSZip from 'jszip'
const require = createRequire(import.meta.url)
const { buildPdf, resumePage } = require('./helpers/pdfBuilder.js')
const { analyzePdf, MAX_PDF_PAGES } = require('../src/services/pdf.inspect.js')
const parser = require('../src/services/resume.parser.js')
const claude = require('../src/services/claude.service.js')
const ats = require('../src/services/ats.service.js')

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PDF = 'application/pdf'
const ENCRYPTED_PDF_B64 = 'JVBERi0xLjQKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSIC9GMiAzIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYSAvRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjEgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250Cj4+CmVuZG9iagozIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhLUJvbGQgL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcgL05hbWUgL0YyIC9TdWJ0eXBlIC9UeXBlMSAvVHlwZSAvRm9udAo+PgplbmRvYmoKNCAwIG9iago8PAovQSA8PAovUyAvVVJJIC9UeXBlIC9BY3Rpb24gL1VSSSAoXDIzMDFcMzIxXDMwNTVcMzU1ZFwyMzJcMzY1XDI2M2VzXDIxM1pcMjI0UlwzMjBNS0RcMzcxXDI2NVwyMDBcMjIzXDIwMlwwMjRcMjcxelwzMjJcMzAwUWlgXDIxMlwzNjcpCj4+IC9Cb3JkZXIgWyAwIDAgMCBdIC9SZWN0IFsgMjEwIDc1Ny44ODk4IDI1MiA3NjkuODg5OCBdIC9TdWJ0eXBlIC9MaW5rIC9UeXBlIC9Bbm5vdAo+PgplbmRvYmoKNSAwIG9iago8PAovQW5ub3RzIFsgNCAwIFIgXSAvQ29udGVudHMgMTAgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgOSAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgCiAgL1RyYW5zIDw8Cgo+PiAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNiAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDkgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago3IDAgb2JqCjw8Ci9BdXRob3IgKFwzMjMgXDMyMktLLVwzNzBcMjE2WikgL0NyZWF0aW9uRGF0ZSAoXDM2NnRcMjE3XDAyNVwwMDB2XDI0NlwzMTNcMDMxXDIwNlwzNDBGXDM2N1o3Q1wzNDRcMjIyakMyXDIzMGgpIC9DcmVhdG9yIChcMzIzIFwzMjJLSy1cMzcwXDIxNlopIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoXDM2NnRcMjE3XDAyNVwwMDB2XDI0NlwzMTNcMDMxXDIwNlwzNDBGXDM2N1o3Q1wzNDRcMjIyakMyXDIzMGgpIC9Qcm9kdWNlciAoXDM0MCtcMzE1SkA0XDMzM1wyMzJLXDIzN1wyMDA3XDIwMkJJXDAyM1wyNTVcMzIwO1wwMjZ7XDIxMGJcMjY3XDIzNFwzMzFcMzA3XDAzNnNcMzAwXDM3NVwzMzVcMzUyXDAyMVwzNzZcMjUzKSAKICAvU3ViamVjdCAoXDMwNyBcMzE2VVcjXDM3NlwyMzVAXDMzMlwyNjQpIC9UaXRsZSAoXDMwNyBcMzExTEYsXDM2MlwyMzcpIC9UcmFwcGVkIC9GYWxzZQo+PgplbmRvYmoKOCAwIG9iago8PAovRmlsdGVyIC9TdGFuZGFyZCAvTyA8OTRFODA5NDQ0MUFFNEM5NjQ0NjkzRjMzQzA3Q0I1NEY1ODdEQ0UxRTI2ODJGRTlFQ0VBNjEwN0ExRUY2MzBERD4gL1AgLTggL1IgMiAvVSA8NDgxQjgwQkU2NzRGMUUyRTE2MEY1RjNENDg5QTgxRDlFODZEOEJFMjMzRUJDNDBGNDc1RjQyQjdCNDA4RTg3RD4gL1YgMQo+PgplbmRvYmoKOSAwIG9iago8PAovQ291bnQgMSAvS2lkcyBbIDUgMCBSIF0gL1R5cGUgL1BhZ2VzCj4+CmVuZG9iagoxMCAwIG9iago8PAovRmlsdGVyIFsgL0FTQ0lJODVEZWNvZGUgL0ZsYXRlRGVjb2RlIF0gL0xlbmd0aCA3MzcKPj4Kc3RyZWFtCrPLKwfUMTaRnP1pEiNWlsaTdI6xjnWHJPGuerZgSQuhjutlxEgS4mziqn2MoZGwKyTiqrOZm0hzSuiyNv1jh2wSlnlUaLY2hSkW6zNGZ3MxJESJsGsd/1HU+FDhbACBQN0mnzuH0PTPAHuNm5ScWPkEMEt0ZxpBqFU1wWzeaLbQ8zGcRCi1lHF7Zu3tscLtz7NLhrHZ9q/o2PqVBVQf/tJthywrCMPEvpPeCkvf5FFUrGbhOJysnB8DpMI98Fv9VJyiy+8amNOcVGcTuewSPJ9kXEcHf9y+I1uQQd9cjvi9MkV6c8US2R0iCwTAkoLIurHfa3KpH5p+gEXgMdq4hhlx0lQET37/Wets0P/tIAckPEjjim3J/2YAO1Bj6+yTo7CmCHy0v+hthOOoW2uujByVDhbNHJ1j+Z+rNR/xjxtkjdM59GpsvmxobcED8LRq3rhaNBAhLUaJzwQmF4fbtX3EpUVKAAaZIAL5YwuJt9CJ0fbMoHP9ST92X1WJdatNg3t5v+sZzaNa5inYNRQ/pHwZoNHBvCFjZa20M32hm9yuK76OsJUZaizSEt9VR+SihE0agffrvNOe6+GeLOlNbCwcDy47t1O9OIl9Rphm67651e2zbhc4LwejT9fv8TOGGBkk1zjkP26yMDdhsD4aM9XmXQB2Euj+FFhKhq6CnvioYLiyPgkhl079WYXTD/8dLjewwSfU71CbBjfGw9DUelH4M8uPEenxaEsY4TKKvSELTWFJZUMmyVmRYNIDVqmnOg8omCwJW5J9DXT4N5OFnQnVFCDFi2lBcTlaLHI+ivlbTR0qP9MciMQZAHUbcbuvhRq8xSV0M17by2+gjKVRHnVjLIECRbhNOIcn5GXpwSFIDiB2yeeE7dU62HlWw2PUerQvDSZwgYfwmdb7FbjJU+ZKmS2OYPpLA2WK8ITCPdZpjO1IziIpdeZWV9S1b+6GGfRsI2rSo3o4FH2xKDdThVN8ZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgMTEKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAxMDIgMDAwMDAgbiAKMDAwMDAwMDIwOSAwMDAwMCBuIAowMDAwMDAwMzIxIDAwMDAwIG4gCjAwMDAwMDA1NjEgMDAwMDAgbiAKMDAwMDAwMDc4MyAwMDAwMCBuIAowMDAwMDAwODUxIDAwMDAwIG4gCjAwMDAwMDEzMTQgMDAwMDAgbiAKMDAwMDAwMTUwOSAwMDAwMCBuIAowMDAwMDAxNTY4IDAwMDAwIG4gCnRyYWlsZXIKPDwKL0VuY3J5cHQgOCAwIFIKL0lEIApbPGY4ZTExMWNlNDcxNGJkNWJlNjNmODg5N2ZjY2JhZWY5PjxmOGUxMTFjZTQ3MTRiZDViZTYzZjg4OTdmY2NiYWVmOT5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNyAwIFIKL1Jvb3QgNiAwIFIKL1NpemUgMTEKPj4Kc3RhcnR4cmVmCjIzOTYKJSVFT0YK'
const WHITE = [255, 255, 255]
const JD = 'Backend Engineer. Build REST services in Node.js on AWS with PostgreSQL and Docker. Own CI/CD, monitoring and deployment automation. 3+ years of experience with JavaScript, SQL, Git, Linux and REST APIs.'

afterEach(() => vi.restoreAllMocks())

describe('PDF ingest keeps the page\'s line structure', () => {
  it('returns one line per visual line — unpdf mergePages collapsed every newline, which zeroed Content on every PDF', async () => {
    const r = await analyzePdf(buildPdf([resumePage()]))
    expect(r.failure).toBe(null)
    expect(r.text.split('\n').length).toBeGreaterThan(15)
    expect(r.text).toMatch(/^Jane Doe\njane@example.com/)
  })
  it('the same resume scores far higher with its lines than flattened (what every PDF upload used to get)', async () => {
    const lined = (await analyzePdf(buildPdf([resumePage()]))).text
    const flat = lined.replace(/\s+/g, ' ')
    const a = ats.scoreResume(lined, JD), b = ats.scoreResume(flat, JD)
    expect(b.contentScore).toBeLessThan(25)
    expect(a.contentScore).toBeGreaterThanOrEqual(b.contentScore + 20)
    expect(a.score - b.score).toBeGreaterThanOrEqual(5)
  })
})

describe('PDF hyperlinks', () => {
  const linked = () => buildPdf([resumePage([{ link: { rect: [190, 750, 235, 762], url: 'https://www.linkedin.com/in/janedoe' } }])])
  it('returns the link targets that annotations carry', async () => {
    expect((await analyzePdf(linked())).links).toEqual(['https://www.linkedin.com/in/janedoe'])
  })
  it('ignores javascript: and other non-web link schemes', async () => {
    const r = await analyzePdf(buildPdf([resumePage([{ link: { rect: [10, 10, 50, 20], url: 'javascript:alert(1)' } }, { link: { rect: [10, 30, 50, 40], url: 'file:///etc/passwd' } }])]))
    expect(r.links).toEqual([])
  })
  it('analyzeUpload appends them as a block the structurer is told about — and the scorer ignores that block', async () => {
    const up = await parser.analyzeUpload(linked(), PDF)
    expect(up.text).toContain('[hyperlinks in this document]\nhttps://www.linkedin.com/in/janedoe')
    const withBlock = ats.scoreResume(up.text, JD), without = ats.scoreResume(up.text.split('\n\n[hyperlinks')[0], JD)
    expect(withBlock.score).toBe(without.score)
  })
})

describe('PDF hidden text', () => {
  it('drops tiny text from the text and counts it; text placed off the page never reaches the text at all', async () => {
    const r = await analyzePdf(buildPdf([resumePage([
      { text: 'kubernetes terraform kafka graphql', x: 50, y: 30, size: 2 },
      { text: 'redis docker microservices', x: -400, y: 500, size: 10 },
    ])]))
    expect(r.structure.hiddenTextChars).toBeGreaterThanOrEqual(30)
    expect(r.text).not.toMatch(/kubernetes|graphql|microservices/)
  })
  it('counts white text on a white page (it cannot be mapped back to items, so it stays in the text but is reported)', async () => {
    const r = await analyzePdf(buildPdf([resumePage([{ text: 'kubernetes terraform kafka graphql redis', x: 50, y: 40, size: 8, color: WHITE }])]))
    expect(r.structure.hiddenTextChars).toBeGreaterThanOrEqual(30)
  })
  it('white text on a large dark band is design, not stuffing', async () => {
    const r = await analyzePdf(buildPdf([{ ops: [
      { rect: [0, 700, 595, 142], color: [31, 58, 95] },
      { text: 'Jane Doe', x: 50, y: 790, size: 22, color: WHITE },
      { text: 'jane@example.com', x: 50, y: 770, size: 10, color: WHITE },
    ] }]))
    expect(r.structure.hiddenTextChars).toBe(0)
  })
  it('a thin black rule does not switch the white-text check off', async () => {
    const r = await analyzePdf(buildPdf([{ ops: [
      { rect: [50, 740, 495, 1], color: [0, 0, 0] },
      { text: 'Jane Doe', x: 50, y: 790, size: 12 },
      { text: 'kubernetes terraform hidden words here', x: 50, y: 50, size: 10, color: WHITE },
    ] }]))
    expect(r.structure.hiddenTextChars).toBeGreaterThanOrEqual(30)
  })
})

describe('PDF layout', () => {
  it('detects two columns from long text sitting beside long text', async () => {
    const ops = []
    for (let i = 0; i < 8; i++) {
      ops.push({ text: 'Built REST services for finance tools used', x: 50, y: 780 - i * 16, size: 9 })
      ops.push({ text: 'Backend developer with experience building web services', x: 320, y: 780 - i * 16, size: 9 })
    }
    expect((await analyzePdf(buildPdf([{ ops }]))).structure.columns).toBe(2)
  })
  it('a single column with right-aligned dates is still one column', async () => {
    const ops = []
    for (let i = 0; i < 8; i++) {
      ops.push({ text: 'Software Engineer, Foo Ltd, Nairobi', x: 50, y: 780 - i * 16, size: 10 })
      ops.push({ text: '2019 - 2024', x: 480, y: 780 - i * 16, size: 10 })
    }
    expect((await analyzePdf(buildPdf([{ ops }]))).structure.columns).toBe(1)
  })
  it('counts a photo-sized image but not a small icon', async () => {
    expect((await analyzePdf(buildPdf([resumePage([{ image: { x: 450, y: 700, w: 100, h: 100, px: 200 } }])]))).structure.images).toBe(1)
    expect((await analyzePdf(buildPdf([resumePage([{ image: { x: 450, y: 700, w: 12, h: 12, px: 24 } }])]))).structure.images).toBe(0)
  })
})

describe('PDF failures carry a code', () => {
  it('a PDF over the page cap is refused before any text work', async () => {
    const r = await analyzePdf(buildPdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => resumePage())))
    expect(r.failure).toEqual({ code: 'TOO_MANY_PAGES', pages: MAX_PDF_PAGES + 1 })
  })
  it('a password-protected PDF is ENCRYPTED_PDF, not a generic parse failure', async () => {
    expect((await analyzePdf(Buffer.from(ENCRYPTED_PDF_B64, 'base64'))).failure.code).toBe('ENCRYPTED_PDF')
  })
  it('bytes that are not a PDF are UNREADABLE_FILE', async () => {
    expect((await analyzePdf(new Uint8Array([1, 2, 3, 4, 5]))).failure.code).toBe('UNREADABLE_FILE')
  })
})

describe('scanned (image-only) PDFs', () => {
  const scan = () => buildPdf([{ ops: [{ image: { x: 0, y: 0, w: 595, h: 842, px: 300 } }] }])
  const LONG = 'Jane Doe\nEXPERIENCE\n• ' + 'Built services used by the finance team across the region. '.repeat(4)
  it('without a model call available it fails as NO_TEXT (an ATS reads it as blank)', async () => {
    const up = await parser.analyzeUpload(scan(), PDF)
    expect(up.failure.code).toBe('NO_TEXT')
  })
  it('is transcribed by the model when one is available, and flagged imageOnly so the score says so', async () => {
    const spy = vi.spyOn(claude, 'extractTextFromPdf').mockResolvedValue({ success: true, text: LONG })
    const up = await parser.analyzeUpload(scan(), PDF, { env: { ANTHROPIC_API_KEY: 'k' } })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(up.failure).toBe(null)
    expect(up.structure.imageOnly).toBe(true)
    expect(up.text).toBe(LONG)
    const r = ats.scoreResume(up.text, JD, { structure: up.structure })
    expect(r.detail.format.issues.join(' ')).toMatch(/image-only pdf/i)
    expect(r.formatScore).toBeLessThanOrEqual(40)
  })
  it('a model failure is still NO_TEXT, and a long scan is not sent at all', async () => {
    vi.spyOn(claude, 'extractTextFromPdf').mockResolvedValue({ success: false, text: '' })
    expect((await parser.analyzeUpload(scan(), PDF, { env: { ANTHROPIC_API_KEY: 'k' } })).failure.code).toBe('NO_TEXT')
    const spy = vi.spyOn(claude, 'extractTextFromPdf').mockResolvedValue({ success: true, text: LONG })
    spy.mockClear()
    const long = buildPdf(Array.from({ length: 6 }, () => ({ ops: [{ image: { x: 0, y: 0, w: 595, h: 842, px: 300 } }] })))
    expect((await parser.analyzeUpload(long, PDF, { env: { ANTHROPIC_API_KEY: 'k' } })).failure.code).toBe('NO_TEXT')
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── DOCX ──────────────────────────────────────────────────────────────────────────────────────────────────
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const run = (t, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`
const para = (...r) => `<w:p>${r.join('')}</w:p>`
const REL = (id, url) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${url}" TargetMode="External"/>`
const FILLER = para(run('Built REST services for internal finance tools used across three regions of the company')).repeat(3)
async function docx(body, rels = '', files = {}) {
  const z = new JSZip()
  z.file('word/document.xml', `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`)
  if (rels) z.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships>${rels}</Relationships>`)
  for (const [k, v] of Object.entries(files)) z.file(k, v)
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }))
}

describe('DOCX hyperlinks', () => {
  it('appends the target after link text that does not show it, with entities decoded', async () => {
    const b = await docx(para(run('Jane Doe')) + para(run('jane@example.com | '), `<w:hyperlink r:id="rId7">${run('LinkedIn')}</w:hyperlink>`) + FILLER,
      REL('rId7', 'https://www.linkedin.com/in/janedoe?x=1&amp;y=2'))
    expect((await parser.extractText(b, DOCX)).split('\n')[1]).toBe('jane@example.com | LinkedIn (https://www.linkedin.com/in/janedoe?x=1&y=2)')
  })
  it('does not repeat a URL the text already shows, and strips mailto:', async () => {
    const b = await docx(para(`<w:hyperlink r:id="rId8">${run('www.janedoe.dev')}</w:hyperlink>`, run(' '), `<w:hyperlink r:id="rId9">${run('Email me')}</w:hyperlink>`) + FILLER,
      REL('rId8', 'https://janedoe.dev/') + REL('rId9', 'mailto:jane@example.com'))
    expect((await parser.extractText(b, DOCX)).split('\n')[0]).toBe('www.janedoe.dev Email me (jane@example.com)')
  })
  it('reads field-code links, and ignores non-web targets', async () => {
    const b = await docx(para('<w:r><w:instrText xml:space="preserve"> HYPERLINK "https://github.com/jane" </w:instrText></w:r>', run('GitHub')) + para(`<w:hyperlink r:id="rId2">${run('Click')}</w:hyperlink>`) + FILLER,
      REL('rId2', 'javascript:alert(1)'))
    const lines = (await parser.extractText(b, DOCX)).split('\n')
    expect(lines[0]).toBe('GitHub (https://github.com/jane)')
    expect(lines[1]).toBe('Click')
  })
  it('reads links in headers too', async () => {
    const b = await docx(FILLER, '', {
      'word/header1.xml': `<w:hdr ${NS}>${para(`<w:hyperlink r:id="rId1">${run('Portfolio')}</w:hyperlink>`)}</w:hdr>`,
      'word/_rels/header1.xml.rels': `<Relationships>${REL('rId1', 'https://jane.example.com')}</Relationships>`,
    })
    expect(await parser.extractText(b, DOCX)).toContain('Portfolio (https://jane.example.com)')
  })
})

describe('DOCX hidden text', () => {
  const hiddenBody = () => para(run('Jane Doe')) + FILLER
    + para(run('kubernetes terraform kafka', '<w:vanish/>'))
    + para(run('graphql redis docker', '<w:color w:val="FFFFFF"/>'))
    + para(run('datadog grafana', '<w:sz w:val="4"/>'))
    + para(run('visible keep me', '<w:vanish w:val="0"/>'))
  it('drops vanish / white / sub-3pt runs from the text and counts them', async () => {
    const up = await parser.analyzeUpload(await docx(hiddenBody()), DOCX)
    expect(up.structure.hiddenTextChars).toBe(56)
    expect(up.text).not.toMatch(/kubernetes|graphql|datadog/)
    expect(up.text).toContain('visible keep me')
  })
  it('keeps white text that sits on a dark shaded band', async () => {
    const b = await docx(`<w:p><w:pPr><w:shd w:val="clear" w:fill="1F3A5F"/></w:pPr>${run('Jane Doe', '<w:color w:val="FFFFFF"/>')}</w:p>` + FILLER)
    const up = await parser.analyzeUpload(b, DOCX)
    expect(up.structure.hiddenTextChars).toBe(0)
    expect(up.text).toContain('Jane Doe')
  })
  it('keeps white text when the document has a filled shape for it to sit on', async () => {
    const b = await docx(para(run('Jane Doe', '<w:color w:val="FFFFFF"/>')) + '<w:p><w:r><mc:AlternateContent><w:pict><v:rect/></w:pict></mc:AlternateContent></w:r></w:p>' + FILLER)
    expect((await parser.analyzeUpload(b, DOCX)).structure.hiddenTextChars).toBe(0)
  })
  it('reports hidden text and penalises the keyword score for it', async () => {
    const up = await parser.analyzeUpload(await docx(hiddenBody()), DOCX)
    const r = ats.scoreResume(up.text, JD, { structure: up.structure })
    expect(r.detail.format.issues.join(' ')).toMatch(/hidden text/i)
    expect(r.detail.keywords.warnings.join(' ')).toMatch(/hidden text/i)
  })
})

describe('analyzeUpload failures', () => {
  it('a near-empty DOCX is TOO_SHORT', async () => {
    expect((await parser.analyzeUpload(await docx(para(run('Jane'))), DOCX)).failure.code).toBe('TOO_SHORT')
  })
  it('a corrupt DOCX is UNREADABLE_FILE and never throws', async () => {
    expect((await parser.analyzeUpload(new Uint8Array([9, 9, 9]), DOCX)).failure.code).toBe('UNREADABLE_FILE')
  })
  it('extractText still returns plain text for generated documents (no model fallback, no link block)', async () => {
    expect(await parser.extractText(await docx(para(run('Jane Doe')) + FILLER), DOCX)).toMatch(/^Jane Doe/)
  })
})
