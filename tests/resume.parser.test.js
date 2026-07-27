import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { extractText, serializeResumeData } from '../src/services/resume.parser.js'

// Builds a minimal but genuinely valid .docx (real OOXML zip structure),
// the same approach used to validate the mammoth->jszip rewrite live
// tonight — not a fake/mocked file, an actual document our own code
// generates and reads back.
async function buildTestDocx(bodyXml) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`)
  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' })
  return new Uint8Array(arrayBuffer)
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('extractText — .docx path (jszip-based, replaced mammoth)', () => {
  it('extracts plain text from a real docx without crashing', async () => {
    const bytes = await buildTestDocx('<w:p><w:r><w:t>Jane Doe - Software Engineer</w:t></w:r></w:p>')
    const text = await extractText(bytes, DOCX_MIME)
    expect(text).toContain('Jane Doe - Software Engineer')
  })

  it('handles tabs and line breaks within a paragraph without dropping them', async () => {
    // A real bug found tonight: tab/break characters inserted at the XML
    // level were falling outside the <w:t> capture regex and getting
    // silently dropped, collapsing "A\tB" into "AB".
    const bytes = await buildTestDocx(
      '<w:p><w:r><w:t>Austin, TX</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>jane@example.com</w:t></w:r></w:p>'
    )
    const text = await extractText(bytes, DOCX_MIME)
    expect(text).toContain('Austin, TX\tjane@example.com')
  })

  it('decodes XML entities correctly', async () => {
    const bytes = await buildTestDocx('<w:p><w:r><w:t>Python &amp; R, TensorFlow &lt;3&gt;</w:t></w:r></w:p>')
    const text = await extractText(bytes, DOCX_MIME)
    expect(text).toContain('Python & R, TensorFlow <3>')
  })

  it('degrades gracefully (empty string, no throw) on corrupt/invalid input', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5])
    const text = await extractText(garbage, DOCX_MIME)
    expect(text).toBe('')
  })

  it('degrades gracefully on empty input', async () => {
    const text = await extractText(new Uint8Array(0), DOCX_MIME)
    expect(text).toBe('')
  })
})

describe('serializeResumeData', () => {
  it('renders bullets in a form the content scorer recognizes as bullets', () => {
    const resumeData = {
      name: 'Jane Doe', email: 'jane@example.com',
      experience: [{ title: 'Engineer', company: 'Acme', dates: '2020-2024',
        bullets: ['Led the migration project'] }],
      education: [], skills: ['Python'], certifications: []
    }
    const text = serializeResumeData(resumeData)
    // Must match the BULLET_LINE pattern in ats.service.js's scoreContent —
    // if these two ever drift out of sync, content scoring on this path
    // silently breaks again.
    expect(text).toMatch(/^\s*[•\-\*◦▪‣·].*Led the migration project/m)
  })

  it('does not crash on missing optional fields', () => {
    const resumeData = { name: null, email: null, experience: [], education: [], skills: [], certifications: [] }
    expect(() => serializeResumeData(resumeData)).not.toThrow()
  })
})
