const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, Tab, TabStopType, BorderStyle, Footer, PageNumber, AlignmentType } = require('docx')
const { hrefFor } = require('../lib/links')
const { densityFor } = require('../lib/docFit')
const { stripBullet } = require('../lib/bulletText')

// PARAMETER: verificationUrl (full URL from badgeService.buildVerificationUrl)
// NOT verificationCode — avoids hardcoded domain
// Returns the DOCX bytes (Buffer) directly: R2 has no filesystem — the caller .put()s these bytes into the bucket under
// the key from config/storage.js.
//
// `verified` (default true) selects the credential wording. false is used when the final score is under the Verified
// threshold — the link still points at the (honest) scan-report page, but the document must not claim a credential the
// page will not confirm.
//
// xmlSafe: the docx library escapes & < > but writes any other character verbatim, including XML-1.0-illegal control
// characters (form feed / vertical tab / NUL and lone surrogates) that PDF text extraction and pasted text can carry into
// a resume. Word refuses a document containing one ("unreadable content") — a paid deliverable that won't open. Every
// string is cleaned before it is used.
function xmlSafe(v) {
  if (typeof v === 'string')
    return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  if (Array.isArray(v)) return v.map(xmlSafe)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, xmlSafe(x)]))
  return v
}

// Letter (US) unless told A4 (UK / Europe) - see design.service.js detectPaper. docx counts in twentieths of a point.
const PAGES = { letter: { width: 12240, height: 15840 }, a4: { width: 11906, height: 16838 } }
const pageSize = paper => (paper === 'a4' ? PAGES.a4 : PAGES.letter)

// ── Design ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// The look is defined ONCE, as document styles (not per-run), so the headings are real Word headings that carry their
// own font, colour, rule and keep-with-next. Before this the section headings were Word's stock Heading 2 (blue, regular
// weight, no font named anywhere in the file — Word falls back to Times New Roman for a paragraph that names none),
// spacing was blank paragraphs, and a wrapped bullet returned to the margin under the bullet glyph.
//
// ATS safety is unchanged: single column, no tables / text boxes / images, real text, literal "•" bullets (a native list
// is a documented parsing risk, see the note above the Document below), standard section names. A right-aligned date is a
// tab stop (extracts as a tab between the title and the dates), which every parser reads as a separator.
const NAVY = '1F3A5F', MUTED = '5B6470'
const DENSITY = {
  normal:  { body: 21, name: 40, small: 18, jobGap: 150, entryGap: 100, bulletAfter: 30, headBefore: 230, headAfter: 80, marginTB: 1000, marginLR: 1080 },
  compact: { body: 20, name: 38, small: 17, jobGap: 100, entryGap: 70,  bulletAfter: 20, headBefore: 170, headAfter: 60, marginTB: 800,  marginLR: 960  },
}
const BULLET_INDENT = { left: 400, hanging: 260 }   // the glyph sits at 140, the text (and every wrapped line) at 400

const linkRun = (text, size = 18) => new TextRun({ text, size, color: '0563C1', underline: {} })
const plainRun = (text, size) => new TextRun({ text, size })

// A contact detail run: a real link where it plainly is one (an address, a profile URL, a phone number). Word does not
// turn typed URLs into links when it opens a file, so plain text meant the profile links on a delivered resume could not
// be clicked.
function contactRuns(parts, size) {
  const runs = []
  parts.forEach((part, i) => {
    const p = typeof part === 'string' ? part : part.text
    if (i > 0) runs.push(plainRun(' | ', size))
    // The location is never a link: "St.Louis" is a place, not a host (it came out as https://St.Louis).
    const href = part && part.link === false ? null : hrefFor(p, { phone: true })
    runs.push(href ? new ExternalHyperlink({ link: href, children: [linkRun(p, size)] }) : plainRun(p, size))
  })
  return runs
}

function buildStyles(d) {
  return {
    default: {
      document: { run: { font: 'Calibri', size: d.body }, paragraph: { spacing: { after: 0, line: 259 } } },
      heading2: {
        run: { font: 'Calibri', size: d.body + 2, bold: true, color: NAVY, characterSpacing: 20 },
        paragraph: {
          spacing: { before: d.headBefore, after: d.headAfter }, keepNext: true, keepLines: true,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 2 } },
        },
      },
    },
  }
}

async function generateAtsDocx(resumeData, verificationUrl, { verified = true, paper } = {}) {
  resumeData = xmlSafe(resumeData) || {}
  verificationUrl = xmlSafe(verificationUrl)
  const size = pageSize(paper)
  const d = DENSITY[densityFor(resumeData, paper === 'a4' ? 'a4' : 'letter', 'docx')]
  const textWidth = size.width - 2 * d.marginLR       // the right-aligned date stops here
  const children = []

  const heading = text => new Paragraph({ text, heading: 'Heading2' })
  const bullet = text => new Paragraph({
    keepLines: true, indent: BULLET_INDENT, spacing: { after: d.bulletAfter },
    children: [new TextRun({ children: ['•', new Tab(), stripBullet(text)] })],
  })
  // A title line with the dates (or tech list) right-aligned on the same line. keepNext: a title is never stranded at the
  // bottom of a page away from its first bullet.
  const titleRow = (left, right, gap) => new Paragraph({
    keepNext: true, keepLines: true, spacing: { before: gap },
    tabStops: right ? [{ type: TabStopType.RIGHT, position: textWidth }] : undefined,
    children: [
      new TextRun({ text: left, bold: true }),
      ...(right ? [new TextRun({ children: [new Tab(), right], color: MUTED, size: d.body - 1 })] : []),
    ],
  })
  const plain = (text, extra = {}) => new Paragraph({ ...extra, children: [new TextRun({ text })] })

  // ── Header: name, contact line, credential line ──
  if (resumeData.name)
    children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: resumeData.name, bold: true, size: d.name, color: NAVY })] }))

  // addPart: [{ text }] — joined with " | " below. link detection is shared with the PDF (lib/links.js).
  const parts = []
  for (const [v, link] of [[resumeData.email, true], [resumeData.phone, true], [resumeData.location, false], [resumeData.linkedin, true], [resumeData.portfolio, true]])
    if (v) parts.push({ text: String(v), link })
  // The credential line: a real link to the verification page, on its own line (it used to trail the contact line and
  // wrap awkwardly). Omitted entirely (not just left blank) when there's no verification link for this tier — see
  // FIX_PLAIN in scan.controller.js's generateFix. The label stays plain text so it extracts as before.
  if (parts.length)
    children.push(new Paragraph({ spacing: { after: verificationUrl ? 20 : 60 }, children: contactRuns(parts, d.small) }))
  if (verificationUrl) {
    const label = `${verified ? 'Passthrough Verified' : 'Passthrough Scan Report'}: `
    const href = hrefFor(verificationUrl)
    children.push(new Paragraph({
      spacing: { after: 60 },
      children: [plainRun(label, d.small), href ? new ExternalHyperlink({ link: href, children: [linkRun(verificationUrl, d.small)] }) : plainRun(verificationUrl, d.small)],
    }))
  }

  if (resumeData.summary) {
    children.push(heading('PROFESSIONAL SUMMARY'))
    children.push(plain(resumeData.summary))
  }

  const sec = { experience: [], education: [], skills: [], certifications: [], projects: [], volunteer: [], awards: [], publications: [], languages: [] }

  if (resumeData.experience?.length) {
    const out = sec.experience
    out.push(heading('EXPERIENCE'))
    for (const job of resumeData.experience) {
      // job.company/job.dates may legitimately be null — Claude is instructed (see claude.service.js) to leave ambiguous
      // fields null rather than guess. Build from filtered, joined parts so the literal text "null" can never reach a
      // paying customer's resume (same pattern resume.parser.js's serializeResumeData uses).
      out.push(titleRow([job.title, job.company, job.location].filter(Boolean).join(' — '), job.dates, d.jobGap))
      for (const b of (job.bullets || [])) out.push(bullet(b))
    }
  }

  if (resumeData.education?.length) {
    const out = sec.education
    out.push(heading('EDUCATION'))
    for (const e of resumeData.education) {
      out.push(titleRow([e.degree, e.institution].filter(Boolean).join(' — '), e.dates, d.entryGap))
      if (e.details) out.push(plain(e.details))
    }
  }

  if (resumeData.skills?.length) {
    sec.skills.push(heading('SKILLS'))
    sec.skills.push(plain(resumeData.skills.map(stripBullet).filter(x => String(x).trim()).join(' · ')))
  }

  if (resumeData.certifications?.length) {
    sec.certifications.push(heading('CERTIFICATIONS'))
    // A literal bullet like every other list (it was a "✓", a glyph some fonts and parsers drop).
    for (const cert of resumeData.certifications) sec.certifications.push(bullet(cert))
  }

  if (resumeData.projects?.length) {
    const out = sec.projects
    out.push(heading('PROJECTS'))
    for (const p of resumeData.projects) {
      out.push(titleRow(p.name || '', p.technologies?.length ? p.technologies.join(', ') : null, d.entryGap))
      if (p.description) out.push(bullet(p.description))
      if (p.link) {
        // A project link is a link where it plainly is one (same rule as the contact line), indented under its bullet.
        const href = hrefFor(p.link)
        out.push(new Paragraph({
          indent: { left: BULLET_INDENT.left },
          children: [href ? new ExternalHyperlink({ link: href, children: [linkRun(p.link, d.body - 1)] }) : new TextRun({ text: p.link, size: d.body - 1, color: MUTED })],
        }))
      }
    }
  }

  // Sections the schema gained for from-scratch resumes (see lib/resumeData.js). Same plain literal-bullet style as
  // everything above, so they extract and score like the rest.
  if (resumeData.volunteer?.length) {
    const out = sec.volunteer
    out.push(heading('VOLUNTEER EXPERIENCE'))
    for (const v of resumeData.volunteer) {
      out.push(titleRow([v.role, v.organization].filter(Boolean).join(' — '), v.dates, d.jobGap))
      for (const b of (v.bullets || [])) out.push(bullet(b))
    }
  }
  for (const [title, key] of [['AWARDS', 'awards'], ['PUBLICATIONS', 'publications']]) {
    if (!resumeData[key]?.length) continue
    sec[key].push(heading(title))
    for (const item of resumeData[key]) sec[key].push(bullet(item))
  }
  if (resumeData.languages?.length) {
    sec.languages.push(heading('LANGUAGES'))
    sec.languages.push(plain(resumeData.languages.map(stripBullet).filter(x => String(x).trim()).join(' · ')))
  }

  // Section order. With job history: Experience > Projects > Education (the usual US/UK order). Without any (a student,
  // a career changer, a from-scratch resume): Education then Projects lead, because that is the strongest evidence they
  // have. pdfTemplate.service.js and the AI layout prompt use the same order.
  const hasJobs = !!resumeData.experience?.length
  const order = hasJobs
    ? ['experience', 'projects', 'education', 'skills', 'certifications', 'volunteer', 'awards', 'publications', 'languages']
    : ['education', 'projects', 'volunteer', 'skills', 'certifications', 'awards', 'publications', 'languages']
  for (const k of order) children.push(...sec[k])
  // No trailing blank paragraph: spacing is paragraph spacing now, so nothing can spill onto an empty last page.
  if (!children.length) children.push(new Paragraph({ text: '' }))

  // Bullets are a literal "•" text character followed by a tab (hanging indent), not Word's native numbering feature.
  // That is a deliberate choice: native list formatting is a well-documented real-world ATS-parsing risk (many employer
  // ATS engines mis-parse or drop it entirely), and it also means the bullet marker never exists as extractable plain
  // text, which silently broke our own content scorer's bullet/action-verb detection on any resume we generated.
  const doc = new Document({
    // Without these the file's properties read creator "Un-named" and no title — what a recruiter sees in a file listing
    // / document inspector / ATS import.
    title:   resumeData.name ? `${resumeData.name} — Resume` : 'Resume',
    creator: resumeData.name || 'Passthrough',
    lastModifiedBy: 'Passthrough',
    description: 'ATS-friendly resume',
    styles: buildStyles(d),
    sections: [{
      // A running footer on every page AFTER the first ("Jane Doe · Page 2 of 2"): printed pages of a two-page resume can
      // separate, and a recruiter should be able to tell whose page 2 it is. The first page has an empty footer so a
      // one-page resume carries nothing extra. The footer sits close to the page edge (400) so it never eats into the
      // bottom margin the fit calibration was measured with.
      properties: { titlePage: true, page: { size, margin: { top: d.marginTB, bottom: d.marginTB, left: d.marginLR, right: d.marginLR, footer: 400, header: 400 } } },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ children: [resumeData.name ? `${resumeData.name}  ·  Page ` : 'Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: MUTED })],
        })] }),
        first: new Footer({ children: [new Paragraph({ children: [] })] }),
      },
      children,
    }],
  })

  return Packer.toBuffer(doc)
}

// A cover letter on one page: the candidate's name and contact line as a letterhead (the same header the resume carries,
// in the same type and colour, so the two documents read as a set), the date, then the body - one paragraph per
// blank-line-separated block, line breaks kept inside a block (the salutation / sign-off). `contact` and `date` are
// optional: called with just (text, name) the file is the plain letter it always was.
async function generateCoverLetterDocx(text, name, { contact = null, date = null, paper } = {}) {
  const body = xmlSafe(String(text || ''))
  const blocks = body.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const who = xmlSafe(name || '')
  const d = DENSITY.normal
  const size = pageSize(paper)
  const head = []
  const c = xmlSafe(contact || {})
  const parts = [[c.email, true], [c.phone, true], [c.location, false], [c.linkedin, true], [c.portfolio, true]]
    .map(([v, link]) => ({ text: String(v || '').trim(), link })).filter(x => x.text)
  const rule = { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 6 } }
  // The rule closes the letterhead: under the contact line, or under the name when there is no contact line.
  if (who) head.push(new Paragraph({ spacing: { after: parts.length ? 40 : 280 }, border: parts.length ? undefined : rule, children: [new TextRun({ text: who, bold: true, size: d.name, color: NAVY })] }))
  if (parts.length) head.push(new Paragraph({ spacing: { after: 280 }, border: rule, children: contactRuns(parts, d.small) }))
  if (date) head.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: xmlSafe(String(date)) })] }))
  const children = [...head, ...blocks.map(b => new Paragraph({
    spacing: { after: 180 },
    children: b.split('\n').flatMap((line, i) => [new TextRun({ text: line, break: i > 0 ? 1 : 0 })]),
  }))]
  if (!children.length) children.push(new Paragraph({ text: '' }))
  const doc = new Document({
    title: who ? `${who} — Cover letter` : 'Cover letter',
    creator: who || 'Passthrough',
    lastModifiedBy: 'Passthrough',
    styles: buildStyles({ ...d, body: 22 }),
    sections: [{ properties: { page: { size, margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } } }, children }],
  })
  return Packer.toBuffer(doc)
}

module.exports = { generateAtsDocx, generateCoverLetterDocx, xmlSafe }
