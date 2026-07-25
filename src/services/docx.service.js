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
  // Plain text URL — ATS ignores it, humans can click it in a document viewer
  parts.push(`Passthrough Verified: ${verificationUrl}`)
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
      children.push(new Paragraph({
        children: [
          new TextRun({ text: job.title,            bold: true, font: 'Calibri', size: 22 }),
          new TextRun({ text: ` — ${job.company}`,             font: 'Calibri', size: 22 }),
          new TextRun({ text: `  ${job.dates}`,                font: 'Calibri', size: 22, color: '666666' })
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
    for (const e of resumeData.education)
      children.push(new Paragraph({
        children: [
          new TextRun({ text: e.degree,               bold: true, font: 'Calibri', size: 22 }),
          new TextRun({ text: ` — ${e.institution}`,             font: 'Calibri', size: 22 }),
          new TextRun({ text: `  ${e.dates}`,                    font: 'Calibri', size: 22, color: '666666' })
        ]
      }))
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
