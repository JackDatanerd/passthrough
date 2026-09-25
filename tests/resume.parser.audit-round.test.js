import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { extractText } from '../src/services/resume.parser.js'
import { scoreResume } from '../src/services/ats.service.js'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
async function docx(bodyXml, extraParts = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${bodyXml}</w:body></w:document>`)
  for (const [name, xml] of Object.entries(extraParts))
    zip.file(name, `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${xml}</w:hdr>`)
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }))
}
const p = t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`
const li = t => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`

describe('DOCX list paragraphs get a bullet marker (native Word bullets are not text)', () => {
  it('a <w:numPr> paragraph is extracted with a leading bullet', async () => {
    const text = await extractText(await docx(p('Experience') + li('Led a team of five engineers.')), DOCX_MIME)
    expect(text.split('\n')).toContain('• Led a team of five engineers.')
  })
  it('numId 0 means "no numbering" — not a bullet', async () => {
    const x = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>Plain line</w:t></w:r></w:p>'
    expect(await extractText(await docx(x), DOCX_MIME)).toBe('Plain line')
  })
  it('a ListBullet-styled paragraph is a bullet too', async () => {
    const x = '<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Styled bullet</w:t></w:r></w:p>'
    expect(await extractText(await docx(x), DOCX_MIME)).toBe('• Styled bullet')
  })
  it('END TO END: the same resume scores the same with native bullets as with literal ones', async () => {
    const bullets = ['Led a team of five engineers to build data pipelines in Python and SQL, reducing latency by 40% across services.',
      'Designed and deployed REST APIs used by 200,000 customers each month.', 'Improved test coverage from 40% to 90% by introducing automated testing of every release.']
    const build = mk => p('Jane Doe') + p('jane@example.com | 555-1234') + p('SUMMARY') + p('Backend engineer.') + p('EXPERIENCE') + p('Senior Engineer — Acme 2019-2024') +
      [0, 1, 2].flatMap(() => bullets.map(mk)).join('') + p('EDUCATION') + p('BSc Computer Science') + p('SKILLS') + p('Python, SQL, Go')
    const jd = 'Software engineer with Python and SQL experience building data pipelines.'
    const native = scoreResume(await extractText(await docx(build(li)), DOCX_MIME), jd)
    const literal = scoreResume(await extractText(await docx(build(t => p('• ' + t))), DOCX_MIME), jd)
    expect(native.contentScore).toBe(literal.contentScore)
    expect(native.score).toBe(literal.score)
    expect(native.contentScore).toBeGreaterThan(60)
  })
})

describe('DOCX header / footer text', () => {
  it('contact details in a Word header are included (and the Contact section is found)', async () => {
    const bytes = await docx(p('EXPERIENCE') + p('Engineer at Acme'), { 'word/header1.xml': p('Jane Doe') + p('jane@example.com | 555 123 4567') })
    const text = await extractText(bytes, DOCX_MIME)
    expect(text.split('\n').slice(0, 2)).toEqual(['Jane Doe', 'jane@example.com | 555 123 4567'])
  })
  it('footers contribute only lines that carry contact information (no page-number noise)', async () => {
    const bytes = await docx(p('Body'), { 'word/footer1.xml': p('Page 1 of 2') + p('linkedin.com/in/jane') })
    const text = await extractText(bytes, DOCX_MIME)
    expect(text).toContain('linkedin.com/in/jane')
    expect(text).not.toContain('Page 1 of 2')
  })
  it('a header line already present in the body is not duplicated', async () => {
    const bytes = await docx(p('Jane Doe') + p('Body'), { 'word/header1.xml': p('Jane Doe') })
    expect((await extractText(bytes, DOCX_MIME)).split('\n').filter(l => l === 'Jane Doe')).toHaveLength(1)
  })
})

describe('DOCX text extraction details', () => {
  it('a text box stored as DrawingML + VML fallback is extracted once, not twice', async () => {
    const x = `<mc:AlternateContent><mc:Choice>${p('Boxed contact jane@example.com')}</mc:Choice><mc:Fallback>${p('Boxed contact jane@example.com')}</mc:Fallback></mc:AlternateContent>`
    expect((await extractText(await docx(x), DOCX_MIME)).match(/Boxed contact/g)).toHaveLength(1)
  })
  it('decodes &amp; last (literal "&lt;" survives) and numeric character references', async () => {
    const x = p('A &amp;lt; B &#8211; C &#x2013; D')
    expect(await extractText(await docx(x), DOCX_MIME)).toBe('A &lt; B – C – D')
  })
  it('an empty self-closed paragraph does not swallow its neighbour', async () => {
    const x = '<w:p w:rsidR="00A1"/>' + p('After the empty one') + p('Third')
    expect((await extractText(await docx(x), DOCX_MIME)).split('\n')).toEqual(['After the empty one', 'Third'])
  })
})
