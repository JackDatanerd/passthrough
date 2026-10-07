const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = require('docx')


// PARAMETER: verificationUrl (full URL from badgeService.buildVerificationUrl)
// NOT verificationCode — avoids hardcoded domain
// CHANGE FROM v8: returns the DOCX bytes (Buffer) directly instead of writing
// to outputPath and returning that path. R2 has no filesystem — the caller
// .put()s these bytes into the bucket under the key from config/storage.js.
//
// SECTION 7 AUDIT: `verified` (default true) selects the credential wording.
// false is used when the final score is under the Verified threshold — the link
// still points at the (honest) scan-report page, but the document must not
// claim a credential the page will not confirm.
// AUDIT FIX (Auth/Scan round): the docx library escapes & < > but writes any
// other character verbatim, including XML-1.0-illegal control characters
// (form feed / vertical tab / NUL and lone surrogates) that PDF text
// extraction and pasted text can carry into a resume. Word refuses a document
// containing one ("unreadable content") — a paid deliverable that won't open.
// Verified against the docx library: U+000B / U+0000 / U+000C reach
// word/document.xml unchanged. Every string is cleaned before it is used.
function xmlSafe(v) {
  if (typeof v === 'string')
    return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  if (Array.isArray(v)) return v.map(xmlSafe)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, xmlSafe(x)]))
  return v
}

// A contact detail as a clickable link where it plainly is one (an address, a profile URL). Only
// http(s) and mailto targets are ever produced; anything else stays plain text. Word does not
// turn typed URLs into links when it opens a file, so plain text meant the verification link and
// the profile links on a delivered resume could not be clicked.
function hrefFor(text) {
  const t = String(text || '').trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return `mailto:${t}`
  if (/^https?:\/\/\S+$/i.test(t)) return t
  if (/^(?:www\.|(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|co|me|app|ai|xyz|info|ke|uk)(?:\/|$))\S*$/i.test(t) && !/\s/.test(t)) return `https://${t}`
  return null
}
const linkRun = (text, size = 18) => new TextRun({ text, size, font: 'Calibri', color: '0563C1', underline: {} })

async function generateAtsDocx(resumeData, verificationUrl, { verified = true } = {}) {
  resumeData = xmlSafe(resumeData)
  verificationUrl = xmlSafe(verificationUrl)
  const children = []

  children.push(new Paragraph({
    children: [new TextRun({ text: resumeData.name || '', bold: true, size: 32, font: 'Calibri Light' })]
  }))

  // [{ text, href? }] — joined with " | " below.
  const parts = []
  const addPart = (text, href = hrefFor(text)) => { if (text) parts.push({ text, href }) }
  addPart(resumeData.email)
  addPart(resumeData.location, null)
  addPart(resumeData.phone, null)
  // AUDIT FIX (section audit — "generate a resume from scratch"): linkedin/
  // portfolio previously had no schema field at all, so there was nothing to
  // render here even when a candidate provided one — see the schema note on
  // claude.service.js's parseResumeStructure.
  addPart(resumeData.linkedin)
  addPart(resumeData.portfolio)
  // The credential line: a real link to the verification page. Omitted entirely (not just left
  // blank) when there's no verification link for this tier — see FIX_PLAIN in
  // scan.controller.js's generateFix. The label stays plain text so it extracts as before.
  const credLabel = verificationUrl ? `${verified ? 'Passthrough Verified' : 'Passthrough Scan Report'}: ` : ''
  const contactRuns = []
  parts.forEach((p, i) => {
    if (i > 0) contactRuns.push(new TextRun({ text: ' | ', size: 18, font: 'Calibri' }))
    contactRuns.push(p.href
      ? new ExternalHyperlink({ link: p.href, children: [linkRun(p.text)] })
      : new TextRun({ text: p.text, size: 18, font: 'Calibri' }))
  })
  if (verificationUrl) {
    if (contactRuns.length) contactRuns.push(new TextRun({ text: ' | ', size: 18, font: 'Calibri' }))
    contactRuns.push(new TextRun({ text: credLabel, size: 18, font: 'Calibri' }))
    contactRuns.push(hrefFor(verificationUrl)
      ? new ExternalHyperlink({ link: hrefFor(verificationUrl), children: [linkRun(verificationUrl)] })
      : new TextRun({ text: verificationUrl, size: 18, font: 'Calibri' }))
  }
  children.push(new Paragraph({ children: contactRuns }))
  children.push(new Paragraph({ text: '' }))

  if (resumeData.summary) {
    children.push(new Paragraph({ text: 'PROFESSIONAL SUMMARY', heading: HeadingLevel.HEADING_2 }))
    children.push(new Paragraph({ children: [new TextRun({ text: resumeData.summary, font: 'Calibri', size: 22 })] }))
    children.push(new Paragraph({ text: '' }))
  }

  if (resumeData.experience?.length) {
    children.push(new Paragraph({ text: 'EXPERIENCE', heading: HeadingLevel.HEADING_2 }))
    for (const job of resumeData.experience) {
      // job.company/job.dates may legitimately be null — Claude is
      // instructed (see claude.service.js) to leave ambiguous fields null
      // rather than guess. Template-literal interpolation would otherwise
      // stringify that as the literal text "null" in a paying customer's
      // delivered resume. Build from filtered, joined parts instead — same
      // pattern resume.parser.js's serializeResumeData already uses.
      const titleLine = [job.title, job.company, job.location].filter(Boolean).join(' — ')
      children.push(new Paragraph({
        children: [
          new TextRun({ text: titleLine, bold: true, font: 'Calibri', size: 22 }),
          ...(job.dates ? [new TextRun({ text: `  ${job.dates}`, font: 'Calibri', size: 22, color: '666666' })] : [])
        ]
      }))
      for (const b of (job.bullets || []))
        children.push(new Paragraph({
          style: 'ListParagraph',
          children: [new TextRun({ text: `•  ${b}`, font: 'Calibri', size: 22 })]
        }))
      children.push(new Paragraph({ text: '' }))
    }
  }

  if (resumeData.education?.length) {
    children.push(new Paragraph({ text: 'EDUCATION', heading: HeadingLevel.HEADING_2 }))
    for (const e of resumeData.education) {
      // Same null-safety as the experience block above.
      const titleLine = [e.degree, e.institution].filter(Boolean).join(' — ')
      children.push(new Paragraph({
        children: [
          new TextRun({ text: titleLine, bold: true, font: 'Calibri', size: 22 }),
          ...(e.dates ? [new TextRun({ text: `  ${e.dates}`, font: 'Calibri', size: 22, color: '666666' })] : [])
        ]
      }))
      if (e.details)
        children.push(new Paragraph({ children: [new TextRun({ text: e.details, font: 'Calibri', size: 22 })] }))
    }
    children.push(new Paragraph({ text: '' }))
  }

  if (resumeData.skills?.length) {
    children.push(new Paragraph({ text: 'SKILLS', heading: HeadingLevel.HEADING_2 }))
    children.push(new Paragraph({
      children: [new TextRun({ text: resumeData.skills.join(' · '), font: 'Calibri', size: 22 })]
    }))
    children.push(new Paragraph({ text: '' }))
  }

  if (resumeData.certifications?.length) {
    children.push(new Paragraph({ text: 'CERTIFICATIONS', heading: HeadingLevel.HEADING_2 }))
    for (const cert of resumeData.certifications)
      children.push(new Paragraph({
        children: [new TextRun({ text: `✓ ${cert}`, font: 'Calibri', size: 22 })]
      }))
    children.push(new Paragraph({ text: '' }))
  }

  // AUDIT FIX (section audit — "generate a resume from scratch"): see
  // resume.parser.js's serializeResumeData for why this section exists now
  // (it didn't before) and who it matters most for.
  if (resumeData.projects?.length) {
    children.push(new Paragraph({ text: 'PROJECTS', heading: HeadingLevel.HEADING_2 }))
    for (const p of resumeData.projects) {
      const techLine = p.technologies?.length ? p.technologies.join(', ') : null
      children.push(new Paragraph({
        children: [
          new TextRun({ text: p.name || '', bold: true, font: 'Calibri', size: 22 }),
          ...(techLine ? [new TextRun({ text: `  ${techLine}`, font: 'Calibri', size: 22, color: '666666' })] : [])
        ]
      }))
      if (p.description)
        children.push(new Paragraph({
          style: 'ListParagraph',
          children: [new TextRun({ text: `•  ${p.description}`, font: 'Calibri', size: 22 })]
        }))
      if (p.link)
        children.push(new Paragraph({
          children: [new TextRun({ text: p.link, font: 'Calibri', size: 20, color: '666666' })]
        }))
      children.push(new Paragraph({ text: '' }))
    }
  }

  // Sections the schema gained for from-scratch resumes (see lib/resumeData.js). Same plain
  // literal-bullet style as everything above, so they extract and score like the rest.
  if (resumeData.volunteer?.length) {
    children.push(new Paragraph({ text: 'VOLUNTEER EXPERIENCE', heading: HeadingLevel.HEADING_2 }))
    for (const v of resumeData.volunteer) {
      const titleLine = [v.role, v.organization].filter(Boolean).join(' — ')
      children.push(new Paragraph({
        children: [
          new TextRun({ text: titleLine, bold: true, font: 'Calibri', size: 22 }),
          ...(v.dates ? [new TextRun({ text: `  ${v.dates}`, font: 'Calibri', size: 22, color: '666666' })] : [])
        ]
      }))
      for (const b of (v.bullets || []))
        children.push(new Paragraph({ style: 'ListParagraph', children: [new TextRun({ text: `•  ${b}`, font: 'Calibri', size: 22 })] }))
      children.push(new Paragraph({ text: '' }))
    }
  }
  for (const [title, key] of [['AWARDS', 'awards'], ['PUBLICATIONS', 'publications']]) {
    if (!resumeData[key]?.length) continue
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_2 }))
    for (const item of resumeData[key])
      children.push(new Paragraph({ style: 'ListParagraph', children: [new TextRun({ text: `•  ${item}`, font: 'Calibri', size: 22 })] }))
    children.push(new Paragraph({ text: '' }))
  }
  if (resumeData.languages?.length) {
    children.push(new Paragraph({ text: 'LANGUAGES', heading: HeadingLevel.HEADING_2 }))
    children.push(new Paragraph({ children: [new TextRun({ text: resumeData.languages.join(' · '), font: 'Calibri', size: 22 })] }))
    children.push(new Paragraph({ text: '' }))
  }

  // ListParagraph style is used purely for left-indentation on bullet lines
  // now — bullets themselves are a literal "•" text character (see above),
  // not Word's native numbering/list feature. That's a deliberate choice:
  // native list formatting is a well-documented real-world ATS-parsing risk
  // (many employer ATS engines mis-parse or drop it entirely), and it also
  // means the bullet marker never exists as extractable plain text, which
  // silently broke our own content scorer's bullet/action-verb detection on
  // any resume we generated ourselves.
  const doc = new Document({
    // Without these the file's properties read creator "Un-named" and no title — what a
    // recruiter sees in a file listing / document inspector / ATS import.
    title:   resumeData.name ? `${resumeData.name} — Resume` : 'Resume',
    creator: resumeData.name || 'Passthrough',
    lastModifiedBy: 'Passthrough',
    description: 'ATS-friendly resume',
    styles: {
      paragraphStyles: [{
        id:         'ListParagraph',
        name:       'List Paragraph',
        basedOn:    'Normal',
        quickFormat: true,
        paragraph:  { indent: { left: 720 } }
      }]
    },
    sections: [{ children }]
  })

  return Packer.toBuffer(doc)
}

// A plain cover letter: one paragraph per blank-line-separated block, line breaks kept inside a
// block (the salutation / sign-off). The candidate's name is only the file's title.
async function generateCoverLetterDocx(text, name) {
  const body = xmlSafe(String(text || ''))
  const blocks = body.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const children = blocks.map(b => new Paragraph({
    spacing: { after: 200 },
    children: b.split('\n').flatMap((line, i) => [
      new TextRun({ text: line, font: 'Calibri', size: 22, break: i > 0 ? 1 : 0 })
    ])
  }))
  const who = xmlSafe(name || '')
  const doc = new Document({
    title: who ? `${who} — Cover letter` : 'Cover letter',
    creator: who || 'Passthrough',
    lastModifiedBy: 'Passthrough',
    sections: [{ children }]
  })
  return Packer.toBuffer(doc)
}

module.exports = { generateAtsDocx, generateCoverLetterDocx, xmlSafe }
