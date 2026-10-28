const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, Tab, TabStopType, BorderStyle, Footer, PageNumber, AlignmentType } = require('docx')
const { hrefFor } = require('../lib/links')
const { densityFor } = require('../lib/docFit')
const { stripBullet } = require('../lib/bulletText')
const { unligature } = require('../lib/textClean')
const { contactRows, contactItems } = require('../lib/contactLayout')
const { letterDensityFor } = require('../lib/docFit')
const { canonDates } = require('../lib/dateFormat')

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
    return unligature(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
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
const MUTED = '5B6470'
// Right-to-left scripts (Arabic, Hebrew, Syriac, Thaana, N'Ko, Arabic presentation forms): such a paragraph is set right-to-left so it is aligned and
// indented from the right and its bullet sits on the right. Everything else is untouched.
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const isRtl = t => RTL.test(String(t || ''))
// The accent (name, headings, rules) is the palette's primary - the same colour the PDF is drawn in - so the Word file and the PDF
// read as a set. Anything that is not a 6-digit hex falls back to the template's default blue (also what the saved-profile PDF uses).
// The body copy colour is the palette's `text` (a deliberately dark tint, 9:1 or better against white) - the colour the PDF's body is set in.
// Not a 6-digit hex -> no colour set, i.e. Word's automatic black.
const textHex = v => { const m = /^#?([0-9a-f]{6})$/i.exec(String(v == null ? '' : v).trim()); return m ? m[1].toUpperCase() : undefined }
const DEFAULT_ACCENT = '1E40AF'
const accentHex = v => { const m = /^#?([0-9a-f]{6})$/i.exec(String(v == null ? '' : v).trim()); return m ? m[1].toUpperCase() : DEFAULT_ACCENT }
const DENSITY = {
  normal:  { body: 21, name: 40, small: 18, jobGap: 150, entryGap: 100, bulletAfter: 30, headBefore: 230, headAfter: 80, marginTB: 1000, marginLR: 1080 },
  compact: { body: 20, name: 38, small: 17, jobGap: 100, entryGap: 70,  bulletAfter: 20, headBefore: 170, headAfter: 60, marginTB: 800,  marginLR: 960  },
}
const BULLET_INDENT = { left: 400, hanging: 260 }   // the glyph sits at 140, the text (and every wrapped line) at 400

// Word underlines anything its dictionary does not know with a red squiggle, and the file's owner sees that when they open it: their own
// name, LinkedIn handle, portfolio URL, employer names and skills (jargon) all came out marked as errors. `noProof` exempts a run from
// spelling and grammar checking; it is set on names, addresses, links, title lines, skills and the like - never on prose (summary, bullets,
// details), so the applicant still gets real typo help where it matters.
// Links are set in the document's ink (underlined, so they still read as links), like the PDF's: a hard-coded Word blue beside a wine or
// teal accent looked like two designs in one file. A document with no usable ink keeps the conventional blue.
const LINK_BLUE = '0563C1'
const linkRun = (text, size = 18, color = LINK_BLUE) => new TextRun({ text, size, color, underline: {}, noProof: true })
const plainRun = (text, size) => new TextRun({ text, size, noProof: true })

// The document language, so Word does not judge British spelling ("optimise", "honours") by US rules or the reverse: the same paper
// heuristic the rest of the file uses - A4 (UK / Europe / Australia) is en-GB, Letter (US) en-US.
const langOf = paper => (paper === 'a4' ? 'en-GB' : 'en-US')

// A contact detail run: a real link where it plainly is one (an address, a profile URL, a phone number). Word does not
// turn typed URLs into links when it opens a file, so plain text meant the profile links on a delivered resume could not
// be clicked.
function contactRuns(parts, size, linkInk) {
  const runs = []
  parts.forEach((part, i) => {
    const p = typeof part === 'string' ? part : part.text
    if (i > 0) runs.push(plainRun(' | ', size))
    // The location is never a link: "St.Louis" is a place, not a host (it came out as https://St.Louis).
    const href = part && part.link === false ? null : hrefFor(p, { phone: true })
    runs.push(href ? new ExternalHyperlink({ link: href, children: [linkRun(p, size, linkInk)] }) : plainRun(p, size))
  })
  return runs
}

// The heading face follows the PDF's: Georgia where the palette sets its headings in a serif, Calibri otherwise.
const headingFontOf = serif => (serif ? 'Georgia' : 'Calibri')

function buildStyles(d, color, headFont = 'Calibri', bodyColor, lang = 'en-US') {
  return {
    default: {
      document: { run: { font: 'Calibri', size: d.body, language: { value: lang }, ...(bodyColor ? { color: bodyColor } : {}) }, paragraph: { spacing: { after: 0, line: 259 } } },
      heading2: {
        run: { font: headFont, size: d.body + 2, bold: true, color, characterSpacing: 20 },
        paragraph: {
          spacing: { before: d.headBefore, after: d.headAfter }, keepNext: true, keepLines: true,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color, space: 2 } },
        },
      },
    },
  }
}

async function generateAtsDocx(resumeData, verificationUrl, { verified = true, paper, accent, serif = false, text: bodyText, credential = true } = {}) {
  const color = accentHex(accent)
  const bodyColor = textHex(bodyText)
  const linkInk = bodyColor || LINK_BLUE
  const headFont = headingFontOf(serif)
  resumeData = xmlSafe(resumeData) || {}
  verificationUrl = xmlSafe(verificationUrl)
  const size = pageSize(paper)
  const d = DENSITY[densityFor(resumeData, paper === 'a4' ? 'a4' : 'letter', 'docx')]
  const textWidth = size.width - 2 * d.marginLR       // the right-aligned date stops here
  const children = []

  const heading = text => new Paragraph({ text, heading: 'Heading2' })
  const bullet = (text, { noProof = false } = {}) => new Paragraph({
    keepLines: true, indent: BULLET_INDENT, spacing: { after: d.bulletAfter }, bidirectional: isRtl(text),
    children: [new TextRun({ children: ['•', new Tab(), stripBullet(text)], rightToLeft: isRtl(text), noProof })],
  })
  // A title line with the dates (or tech list) right-aligned on the same line. keepNext: a title is never stranded at the
  // bottom of a page away from its first bullet.
  const titleRow = (left, right, gap) => new Paragraph({
    keepNext: true, keepLines: true, spacing: { before: gap },
    tabStops: right ? [{ type: TabStopType.RIGHT, position: textWidth }] : undefined,
    children: [
      new TextRun({ text: left, bold: true, noProof: true }),
      ...(right ? [new TextRun({ children: [new Tab(), right], color: MUTED, size: d.body - 1, noProof: true })] : []),
    ],
  })
  const plain = (text, extra = {}, { noProof = false } = {}) => new Paragraph({ ...extra, bidirectional: isRtl(text), children: [new TextRun({ text, rightToLeft: isRtl(text), noProof })] })

  // ── Header: name, contact line, credential line ──
  if (resumeData.name)
    children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: resumeData.name, bold: true, size: d.name, color, font: headFont, noProof: true })] }))

  // The contact details: one row, or two when they would not fit one (lib/contactLayout.js - a single long line wrapped in the
  // middle of a profile URL). link detection is shared with the PDF (lib/links.js).
  const rows = contactRows(contactItems(resumeData))
  // The credential line: a real link to the verification page, on its own line (it used to trail the contact line and
  // wrap awkwardly). Omitted entirely (not just left blank) when there's no verification link for this tier — see
  // FIX_PLAIN in scan.controller.js's generateFix. The label stays plain text so it extracts as before.
  // `credential: false` is the owner's choice (look 4, scans.doc_marks.header): the line is left out like it is for a tier with no link.
  const showCredential = !!verificationUrl && credential !== false
  rows.forEach((row, ri) => children.push(new Paragraph({
    spacing: { after: ri < rows.length - 1 || showCredential ? 20 : 60 }, children: contactRuns(row, d.small, linkInk),
  })))
  if (showCredential) {
    const label = `${verified ? 'Passthrough Verified' : 'Passthrough Scan Report'}: `
    const href = hrefFor(verificationUrl)
    children.push(new Paragraph({
      spacing: { after: 60 },
      children: [plainRun(label, d.small), href ? new ExternalHyperlink({ link: href, children: [linkRun(verificationUrl, d.small, linkInk)] }) : plainRun(verificationUrl, d.small)],
    }))
  }

  if (resumeData.summary) {
    children.push(heading('PROFESSIONAL SUMMARY'))
    // A line break inside a text run is not a break in Word; one paragraph per line is what the reader (and the ATS) sees.
    for (const line of String(resumeData.summary).split(/\r?\n+/).map(l => l.trim()).filter(Boolean)) children.push(plain(line))
  }

  const sec = { experience: [], education: [], skills: [], certifications: [], projects: [], volunteer: [], awards: [], publications: [], languages: [] }

  if (resumeData.experience?.length) {
    const out = sec.experience
    out.push(heading('EXPERIENCE'))
    for (const job of resumeData.experience) {
      // job.company/job.dates may legitimately be null — Claude is instructed (see claude.service.js) to leave ambiguous
      // fields null rather than guess. Build from filtered, joined parts so the literal text "null" can never reach a
      // paying customer's resume (same pattern resume.parser.js's serializeResumeData uses).
      out.push(titleRow([job.title, job.company, job.location].filter(Boolean).join(' — '), canonDates(job.dates), d.jobGap))
      for (const b of (job.bullets || [])) out.push(bullet(b))
    }
  }

  if (resumeData.education?.length) {
    const out = sec.education
    out.push(heading('EDUCATION'))
    for (const e of resumeData.education) {
      out.push(titleRow([e.degree, e.institution].filter(Boolean).join(' — '), canonDates(e.dates), d.entryGap))
      if (e.details) for (const line of String(e.details).split(/\r?\n+/).map(l => l.trim()).filter(Boolean)) out.push(plain(line))
    }
  }

  if (resumeData.skills?.length) {
    sec.skills.push(heading('SKILLS'))
    sec.skills.push(plain(resumeData.skills.map(stripBullet).filter(x => String(x).trim()).join(', '), {}, { noProof: true }))
  }

  if (resumeData.certifications?.length) {
    sec.certifications.push(heading('CERTIFICATIONS'))
    // A literal bullet like every other list (it was a "✓", a glyph some fonts and parsers drop).
    for (const cert of resumeData.certifications) sec.certifications.push(bullet(cert, { noProof: true }))
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
          children: [href ? new ExternalHyperlink({ link: href, children: [linkRun(p.link, d.body - 1, linkInk)] }) : new TextRun({ text: p.link, size: d.body - 1, color: MUTED, noProof: true })],
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
      out.push(titleRow([v.role, v.organization].filter(Boolean).join(' — '), canonDates(v.dates), d.jobGap))
      for (const b of (v.bullets || [])) out.push(bullet(b))
    }
  }
  for (const [title, key] of [['AWARDS', 'awards'], ['PUBLICATIONS', 'publications']]) {
    if (!resumeData[key]?.length) continue
    sec[key].push(heading(title))
    for (const item of resumeData[key]) sec[key].push(bullet(item, key === 'awards' ? { noProof: true } : {}))
  }
  if (resumeData.languages?.length) {
    sec.languages.push(heading('LANGUAGES'))
    sec.languages.push(plain(resumeData.languages.map(stripBullet).filter(x => String(x).trim()).join(', '), {}, { noProof: true }))
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
    // What a recruiter sees in the file's properties: the applicant, not a tool name or a marketing line.
    lastModifiedBy: resumeData.name || 'Passthrough',
    styles: buildStyles(d, color, headFont, bodyColor, langOf(paper)),
    sections: [{
      // A running footer on every page AFTER the first ("Jane Doe · Page 2 of 2"): printed pages of a two-page resume can
      // separate, and a recruiter should be able to tell whose page 2 it is. The first page has an empty footer so a
      // one-page resume carries nothing extra. The footer sits close to the page edge (400) so it never eats into the
      // bottom margin the fit calibration was measured with.
      properties: { titlePage: true, page: { size, margin: { top: d.marginTB, bottom: d.marginTB, left: d.marginLR, right: d.marginLR, footer: 400, header: 400 } } },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ children: [resumeData.name ? `${resumeData.name}  ·  Page ` : 'Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: MUTED, noProof: true })],
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
async function generateCoverLetterDocx(text, name, { contact = null, date = null, paper, accent, serif = false, text: bodyText, density } = {}) {
  const color = accentHex(accent)
  const bodyColor = textHex(bodyText)
  const linkInk = bodyColor || LINK_BLUE
  const headFont = headingFontOf(serif)
  const body = xmlSafe(String(text || ''))
  const blocks = body.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const who = xmlSafe(name || '')
  const d = DENSITY.normal
  const size = pageSize(paper)
  const head = []
  const c = xmlSafe(contact || {})
  const rows = contactRows(contactItems(c))
  const rule = { bottom: { style: BorderStyle.SINGLE, size: 6, color, space: 6 } }
  // The rule closes the letterhead: under the contact line, or under the name when there is no contact line.
  if (who) head.push(new Paragraph({ spacing: { after: rows.length ? 40 : 280 }, border: rows.length ? undefined : rule, children: [new TextRun({ text: who, bold: true, size: d.name, color, font: headFont, noProof: true })] }))
  rows.forEach((row, ri) => {
    const last = ri === rows.length - 1
    head.push(new Paragraph({ spacing: { after: last ? 280 : 20 }, border: last ? rule : undefined, children: contactRuns(row, d.small, linkInk) }))
  })
  if (date) head.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: xmlSafe(String(date)) })] }))
  // Just over a page -> a little tighter (lib/docFit.js); a clearly longer letter is left alone.
  const compact = (density === 'compact' || density === 'normal' ? density : letterDensityFor(body, paper === 'a4' ? 'a4' : 'letter', 'docx')) === 'compact'
  const children = [...head, ...blocks.map(b => new Paragraph({
    spacing: { after: compact ? 130 : 180 },
    children: b.split('\n').flatMap((line, i) => [new TextRun({ text: line, break: i > 0 ? 1 : 0 })]),
  }))]
  if (!children.length) children.push(new Paragraph({ text: '' }))
  const doc = new Document({
    title: who ? `${who} — Cover letter` : 'Cover letter',
    creator: who || 'Passthrough',
    lastModifiedBy: who || 'Passthrough',
    styles: buildStyles({ ...d, body: compact ? 21 : 22 }, color, headFont, bodyColor, langOf(paper)),
    sections: [{ properties: { page: { size, margin: compact ? { top: 1000, bottom: 1000, left: 1150, right: 1150 } : { top: 1200, bottom: 1200, left: 1300, right: 1300 } } }, children }],
  })
  return Packer.toBuffer(doc)
}

module.exports = { generateAtsDocx, generateCoverLetterDocx, xmlSafe, accentHex, textHex }
