import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { generateAtsDocx } from '../src/services/docx.service.js'

// SECTION 12 AUDIT: docx.service.js had zero test coverage despite being a
// pure data->document transform (no supabase/network dependency, unlike
// pdf.service.js's remote-browser rendering) and being the file that
// produces the actual deliverable a customer pays for.
//
// docx files are zip archives; we don't assert on exact XML, just that the
// document is well-formed and that the plain text extracted from
// word/document.xml contains what it should — the same shape of check the
// app's own content scorer would need the text run as, and the exact
// failure mode called out in this file's own "null-safety" comments (a
// literal "null" leaking into a paying customer's resume).

async function extractText(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('word/document.xml').async('string')
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

const MINIMAL = { name: 'Jane Doe' }

describe('generateAtsDocx', () => {
  it('produces a well-formed, non-empty docx buffer for minimal input', async () => {
    const buf = await generateAtsDocx(MINIMAL, null)
    expect(Buffer.isBuffer(buf) || buf instanceof Uint8Array).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
    const zip = await JSZip.loadAsync(buf)
    expect(zip.file('word/document.xml')).toBeTruthy()
  })

  it('includes the candidate name', async () => {
    const text = await extractText(await generateAtsDocx({ name: 'Jane Q. Doe' }, null))
    expect(text).toContain('Jane Q. Doe')
  })

  it('joins contact fields with a separator and includes linkedin/portfolio when present', async () => {
    const text = await extractText(await generateAtsDocx({
      name: 'Jane', email: 'jane@x.com', location: 'Nairobi', phone: '+254...',
      linkedin: 'linkedin.com/in/jane', portfolio: 'jane.dev',
    }, null))
    expect(text).toContain('jane@x.com')
    expect(text).toContain('Nairobi')
    expect(text).toContain('linkedin.com/in/jane')
    expect(text).toContain('jane.dev')
  })

  it('labels the verification link "Verified" when verified=true (default) and "Scan Report" when verified=false', async () => {
    const verifiedText   = await extractText(await generateAtsDocx(MINIMAL, 'https://passthrough.dev/v/ABC123'))
    const unverifiedText = await extractText(await generateAtsDocx(MINIMAL, 'https://passthrough.dev/v/ABC123', { verified: false }))
    expect(verifiedText).toContain('Passthrough Verified')
    expect(verifiedText).toContain('https://passthrough.dev/v/ABC123')
    expect(unverifiedText).toContain('Passthrough Scan Report')
    expect(unverifiedText).not.toContain('Passthrough Verified:')
  })

  it('omits the verification line entirely when verificationUrl is null (not just blank)', async () => {
    const text = await extractText(await generateAtsDocx(MINIMAL, null))
    expect(text).not.toContain('Passthrough')
    expect(text).not.toContain('null')
  })

  // The exact failure mode this file's own comments call out: a null field
  // must never render as the literal string "null" in a paying customer's
  // document.
  it('never renders the literal string "null" when company/dates/institution are null', async () => {
    const text = await extractText(await generateAtsDocx({
      name: 'Jane',
      experience: [{ title: 'Engineer', company: null, dates: null, bullets: ['Did a thing'] }],
      education: [{ degree: 'BSc', institution: null, dates: null }],
      projects: [{ name: 'Side Project', technologies: null, description: null, link: null }],
    }, null))
    expect(text).not.toMatch(/\bnull\b/)
    expect(text).toContain('Engineer')
    expect(text).toContain('BSc')
    expect(text).toContain('Side Project')
  })

  it('renders bullets, skills and certifications sections only when present', async () => {
    const withSections = await extractText(await generateAtsDocx({
      name: 'Jane',
      experience: [{ title: 'Eng', company: 'Acme', dates: '2020–2023', bullets: ['Shipped X', 'Led Y'] }],
      skills: ['Python', 'SQL'],
      certifications: ['AWS Certified'],
    }, null))
    expect(withSections).toContain('EXPERIENCE')
    expect(withSections).toContain('Shipped X')
    expect(withSections).toContain('SKILLS')
    expect(withSections).toContain('Python')
    expect(withSections).toContain('SQL')
    expect(withSections).toContain('CERTIFICATIONS')
    expect(withSections).toContain('AWS Certified')

    const withoutSections = await extractText(await generateAtsDocx(MINIMAL, null))
    expect(withoutSections).not.toContain('EXPERIENCE')
    expect(withoutSections).not.toContain('SKILLS')
    expect(withoutSections).not.toContain('CERTIFICATIONS')
    expect(withoutSections).not.toContain('PROJECTS')
    expect(withoutSections).not.toContain('EDUCATION')
  })

  it('handles a fully empty resumeData object without throwing', async () => {
    await expect(generateAtsDocx({}, null)).resolves.toBeTruthy()
  })
})
