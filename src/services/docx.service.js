const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx')


// PARAMETER: verificationUrl (full URL from badgeService.buildVerificationUrl)
// NOT verificationCode — avoids hardcoded domain
// CHANGE FROM v8: returns the DOCX bytes (Buffer) directly instead of writing
// to outputPath and returning that path. R2 has no filesystem — the caller
// .put()s these bytes into the bucket under the key from config/storage.js.
async function generateAtsDocx(resumeData, verificationUrl) {
  const children = []

  children.push(new Paragraph({
    children: [new TextRun({ text: resumeData.name || '', bold: true, size: 32, font: 'Calibri Light' })]
  }))

  const parts = []
  if (resumeData.email) parts.push(resumeData.email)
  if (resumeData.location) parts.push(resumeData.location)
  if (resumeData.phone)    parts.push(resumeData.phone)
  // AUDIT FIX (section audit — "generate a resume from scratch"): linkedin/
  // portfolio previously had no schema field at all, so there was nothing to
  // render here even when a candidate provided one — see the schema note on
  // claude.service.js's parseResumeStructure.
  if (resumeData.linkedin)  parts.push(resumeData.linkedin)
  if (resumeData.portfolio) parts.push(resumeData.portfolio)
  // Plain text URL — ATS ignores it, humans can click it in a document viewer.
  // Omitted entirely (not just left blank) when there's no verification link
  // for this tier — see FIX_PLAIN in scan.controller.js's generateFix.
  if (verificationUrl) parts.push(`Passthrough Verified: ${verificationUrl}`)
  children.push(new Paragraph({
    children: [new TextRun({ text: parts.join(' | '), size: 18, font: 'Calibri' })]
  }))
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
      const titleLine = [job.title, job.company].filter(Boolean).join(' — ')
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

  // ListParagraph style is used purely for left-indentation on bullet lines
  // now — bullets themselves are a literal "•" text character (see above),
  // not Word's native numbering/list feature. That's a deliberate choice:
  // native list formatting is a well-documented real-world ATS-parsing risk
  // (many employer ATS engines mis-parse or drop it entirely), and it also
  // means the bullet marker never exists as extractable plain text, which
  // silently broke our own content scorer's bullet/action-verb detection on
  // any resume we generated ourselves.
  const doc = new Document({
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

module.exports = { generateAtsDocx }
