// Deterministic HTML for the designed PDF — no AI involved.
//
// The designed PDF used to depend entirely on a Claude call that had to emit a
// whole HTML document inside a 6,000-token budget. A long resume, a transient
// API error or a malformed answer meant NO PDF at all — the file candidates
// actually e-mail to employers — and the customer was left with only the DOCX
// and a "regenerate" button that would call the same fragile generator again.
//
// This renders the same structured resume with the same design tokens (palette
// and font mood) from a fixed template. It is the fallback when the AI layout
// fails, and it never fails: it is a pure function of the data. Everything
// interpolated is escaped; there are no scripts, no images and no remote
// resources (system fonts only), so it also needs no sanitizing and cannot make
// the headless browser fetch anything.

const { hrefFor, displayUrl } = require('../lib/links')
const { densityFor, letterDensityFor } = require('../lib/docFit')
const { stripBullet } = require('../lib/bulletText')
const { contactRows, contactItems } = require('../lib/contactLayout')
const { isSerifHeading } = require('../lib/typeface')
const { FONT_FACE_CSS } = require('../lib/embeddedFonts')
const { unligature } = require('../lib/textClean')

// The credential's check mark is DRAWN, not typed: U+2713 is in neither Arial nor Liberation Sans, so on a container with only
// the usual sans fonts it printed as an empty box in front of "Passthrough Verified" on every delivered PDF. (It also keeps a
// stray symbol out of the text layer ATS software reads.)
const CHECK_SVG = '<svg class="ck" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M1.6 5.4l2.4 2.4 4.4-5.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

// The divider under each heading is drawn from the palette's PRIMARY, lightened: the palette's `accent` is a pale tint
// (contrast 1.1-1.4 against white on most palettes) and as a 1px rule it all but vanished on screen and on paper.
const ruleColor = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return '#9CA3AF'
  const n = parseInt(m[1], 16)
  const mix = c => Math.round(c * 0.45 + 255 * 0.55).toString(16).padStart(2, '0')
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`
}
// A CSS string literal from arbitrary text (the name in the page footer).
const cssStr = v => String(v ?? '').replace(/[\\"\n\r\f<>&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

const esc = v => unligature(String(v ?? ''))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// Only ever a link we built ourselves or a link the person typed — still
// restricted to web/mail schemes so nothing like javascript: can be printed
// into an href.
const safeHref = url => {
  const u = String(url || '').trim()
  return /^(?:https?:\/\/|mailto:)/i.test(u) ? u : null
}

const list = v => (Array.isArray(v) ? v : [])
const str  = v => (typeof v === 'string' ? v.trim() : '')

// Font moods, as system stacks. The AI layout loads webfonts; this template
// deliberately does not (see header), so it keeps the serif/sans character of
// the chosen pairing instead.
function fontStacks(fonts) {
  const heading = String(fonts?.heading || '')
  const serifHeading = isSerifHeading(heading)
  return {
    // The embedded faces (lib/embeddedFonts.js) lead; the system fonts that follow only ever supply glyphs the Latin subset lacks.
    heading: serifHeading ? '"DocSerif", Georgia, "Times New Roman", serif' : '"DocSans", "Helvetica Neue", Arial, sans-serif',
    body:    '"DocSans", "Helvetica Neue", Arial, "Segoe UI", sans-serif',
  }
}

// An address, a profile URL or a phone number is a real link where it plainly is one (lib/links.js, the same rule the
// DOCX uses). Chromium does not linkify text, so these used to be dead text in the file applicants actually email.
const contactItem = (raw, link = true) => {
  const t = typeof raw === 'string' ? raw.trim() : ''
  if (!t) return ''
  const h = link ? hrefFor(t, { phone: true }) : null   // the location is never a link ("St.Louis" is a place, not a host)
  return h ? `<a href="${esc(h)}">${esc(t)}</a>` : esc(t)
}

// The contact details as one or two rows (lib/contactLayout.js). Each item is unbreakable and carries its separator, so a row
// only ever wraps BETWEEN items - never inside a link, and never with a "|" stranded at the start of a line.
function contactBlock(d) {
  const rows = contactRows(contactItems(d))
  return rows.map((row, ri) => `<p class="contact${ri < rows.length - 1 ? ' more' : ''}">` +
    row.map((it, i) => `<span class="nw">${contactItem(it.text, it.link)}${i < row.length - 1 ? ' &nbsp;|' : ''}</span>`).join(' ') + '</p>').join('')
}

function buildResumeHTML(data, designTokens, verificationUrl, { verified = true } = {}) {
  const d = data || {}
  const palette = designTokens?.palette || { bg: '#FFFFFF', primary: '#1E40AF', accent: '#E2E8F0', text: '#1F2937' }
  const fonts   = designTokens?.fonts || {}
  const stack   = fontStacks(fonts)
  const hPt = Number(fonts.hPt) || 23
  const bPtBase = Number(fonts.bPt) || 10.5
  // US Letter unless the tokens say A4 (see design.service.js detectPaper) - the customers apply to US and UK employers.
  // min-height stays a hair UNDER the printable height (page minus the 14mm top and bottom margins): a box exactly as tall as the
  // page area can tip a few sub-pixels over it and print a blank trailing page.
  const paper = designTokens?.paper === 'a4' ? { key: 'a4', css: 'A4', width: '210mm', minHeight: '268mm' } : { key: 'letter', css: 'Letter', width: '8.5in', minHeight: '9.85in' }
  // A resume that is only just over one page gets a slightly denser layout instead of a nearly empty second page (lib/docFit.js
  // estimates the length from the data; a clearly longer resume is left alone). designTokens.density forces either.
  const density = designTokens?.density === 'compact' || designTokens?.density === 'normal' ? designTokens.density : densityFor(d, paper.key)
  const compact = density === 'compact'
  const bPt = bPtBase - (compact ? 0.5 : 0)

  // Contact details are links where they plainly are one (see contactItem above).
  const contact = contactBlock(d)
  const href = safeHref(verificationUrl)
  // The address is printed next to the credential: a printed or flattened PDF has no clickable link, and the point of the
  // credential is that a reader can check it. (The DOCX has always shown the full URL.)
  const credential = href
    ? `<a class="cred" href="${esc(href)}">${verified ? CHECK_SVG + 'Passthrough Verified' : 'Passthrough Scan Report'}</a> <a class="credurl" href="${esc(href)}">${esc(displayUrl(href))}</a>`
    : ''

  const section = (title, inner) => inner ? `<section><h2>${esc(title)}</h2>${inner}</section>` : ''

  const summary = str(d.summary) ? `<p class="summary">${esc(d.summary)}</p>` : ''

  const experience = list(d.experience).map(job => {
    const head = [str(job?.title), str(job?.company), str(job?.location)].filter(Boolean).map(esc).join(' &mdash; ')
    const dates = str(job?.dates)
    const bullets = list(job?.bullets).map(str).filter(Boolean)
    if (!head && !dates && !bullets.length) return ''
    return `<div class="entry"><div class="row"><span class="strong">${head}</span>${dates ? `<span class="dates">${esc(dates)}</span>` : ''}</div>` +
      (bullets.length ? `<ul>${bullets.map(b => `<li dir="auto">${esc(stripBullet(b))}</li>`).join('')}</ul>` : '') + `</div>`
  }).join('')

  const education = list(d.education).map(e => {
    const head = [str(e?.degree), str(e?.institution)].filter(Boolean).map(esc).join(' &mdash; ')
    const dates = str(e?.dates)
    const details = str(e?.details)
    if (!head && !dates) return ''
    return `<div class="entry"><div class="row"><span class="strong">${head}</span>${dates ? `<span class="dates">${esc(dates)}</span>` : ''}</div>` +
      (details ? `<p>${esc(details)}</p>` : '') + `</div>`
  }).join('')

  const skills = list(d.skills).map(str).map(stripBullet).map(str).filter(Boolean)
  const skillsHtml = skills.length ? `<p class="skills">${skills.map(esc).join(' &middot; ')}</p>` : ''

  const certs = list(d.certifications).map(str).filter(Boolean)
  const certsHtml = certs.length ? `<ul>${certs.map(c => `<li dir="auto">${esc(stripBullet(c))}</li>`).join('')}</ul>` : ''

  const projects = list(d.projects).map(p => {
    const name = str(p?.name)
    const tech = list(p?.technologies).map(str).filter(Boolean)
    const desc = str(p?.description)
    const link = str(p?.link)
    if (!name && !desc) return ''
    const l = hrefFor(link)
    return `<div class="entry"><div class="row"><span class="strong">${esc(name)}</span>${tech.length ? `<span class="dates">${tech.map(esc).join(', ')}</span>` : ''}</div>` +
      (desc ? `<ul><li dir="auto">${esc(stripBullet(desc))}</li></ul>` : '') +
      (link ? `<p class="link">${l ? `<a href="${esc(l)}">${esc(link)}</a>` : esc(link)}</p>` : '') + `</div>`
  }).join('')

  const volunteer = list(d.volunteer).map(v => {
    const head = [str(v?.role), str(v?.organization)].filter(Boolean).map(esc).join(' &mdash; ')
    const dates = str(v?.dates)
    const bullets = list(v?.bullets).map(str).filter(Boolean)
    if (!head && !dates && !bullets.length) return ''
    return `<div class="entry"><div class="row"><span class="strong">${head}</span>${dates ? `<span class="dates">${esc(dates)}</span>` : ''}</div>` +
      (bullets.length ? `<ul>${bullets.map(b => `<li dir="auto">${esc(stripBullet(b))}</li>`).join('')}</ul>` : '') + `</div>`
  }).join('')
  const plainList = v => { const items = list(v).map(str).filter(Boolean); return items.length ? `<ul>${items.map(i => `<li dir="auto">${esc(stripBullet(i))}</li>`).join('')}</ul>` : '' }
  const languages = list(d.languages).map(str).map(stripBullet).map(str).filter(Boolean)
  const languagesHtml = languages.length ? `<p class="skills">${languages.map(esc).join(' &middot; ')}</p>` : ''

  // No job history (a student, a career changer, a from-scratch resume): Education then Projects lead, because that is
  // the strongest evidence they have and what a US/UK reader looks for first. With job history the order is the usual
  // Experience > Projects > Education. The DOCX uses the same order (docx.service.js).
  const projectsSection = section('Projects', projects)
  const experienceSection = section('Experience', experience)
  const educationSection = section('Education', education)
  const head = experience ? [experienceSection, projectsSection, educationSection] : [educationSection, projectsSection, section('Volunteer Experience', volunteer)]
  const body = head.join('') +
    section('Skills', skillsHtml) + section('Certifications', certsHtml) +
    (experience ? section('Volunteer Experience', volunteer) : '') + section('Awards', plainList(d.awards)) +
    section('Publications', plainList(d.publications)) + section('Languages', languagesHtml)

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(d.name || 'Resume')}</title>
<style>
${FONT_FACE_CSS}
/* Top/bottom page margins belong to the PRINT ENGINE (pdf.service.js passes the same 14mm), not to
   the container: padding on one tall box only pads its first top and last bottom edge, so on a
   2-page resume page 1 ran to the bottom edge and page 2 started at the top edge. */
@page { size: ${paper.css}; margin: 14mm 0;
  @bottom-center { content: "${cssStr(d.name) ? cssStr(d.name) + '  \\00B7  ' : ''}Page " counter(page) " of " counter(pages); font: 8pt ${stack.body}; color: #6B7280 } }
@page :first { @bottom-center { content: none } }
* { box-sizing: border-box }
html, body { margin: 0; padding: 0 }
html { background: ${esc(palette.bg)} }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; overflow-wrap: anywhere; background: ${esc(palette.bg)}; color: ${esc(palette.text)};
  font-family: ${stack.body}; font-size: ${bPt}pt; line-height: ${compact ? 1.36 : 1.45} }
.page { width: ${paper.width}; min-height: ${paper.minHeight}; padding: 0 16mm 0 18mm; border-left: 4px solid ${esc(palette.primary)} }
h1 { font-family: ${stack.heading}; font-size: ${hPt}pt; margin: 0 0 2pt; color: ${esc(palette.primary)}; letter-spacing: .2pt }
.contact { font-size: ${Math.max(bPt - 1.5, 8)}pt; margin: 0 0 3pt }
.cred { font-size: 8pt; font-variant: small-caps; color: ${esc(palette.primary)}; text-decoration: none }
h2 { font-family: ${stack.heading}; font-size: ${bPt + 1.5}pt; text-transform: uppercase; letter-spacing: 1pt; color: ${esc(palette.primary)};
  border-bottom: 1px solid ${ruleColor(palette.primary)}; padding-bottom: 2pt; margin: ${compact ? '10pt 0 4pt' : '14pt 0 6pt'};
  break-after: avoid; page-break-after: avoid }
section { page-break-inside: auto }
.entry { margin-bottom: ${compact ? 5 : 7}pt; break-inside: avoid; page-break-inside: avoid }
.row { display: flex; justify-content: space-between; gap: 12pt }
.strong { font-weight: 700 }
.dates { color: ${esc(palette.primary)}; white-space: nowrap; font-size: ${Math.max(bPt - 1, 8)}pt }
ul { margin: 3pt 0 0; padding-left: 14pt }
li { margin-bottom: 2pt }
p { margin: 0 }
.summary, .skills { margin-top: 2pt }
.link { font-size: ${Math.max(bPt - 1.5, 8)}pt; margin-top: 2pt }
a { color: inherit; text-decoration: none }
.credurl { font-size: 7.5pt; opacity: .75 }
.ck { width: 8pt; height: 8pt; vertical-align: -0.5pt; margin-right: 2.5pt }
.nw { white-space: nowrap }
.contact.more { margin-bottom: 1pt }
/* Right-to-left text (Arabic, Hebrew) takes its own direction block by block: aligned and indented from the right, bullets on the right. */
p, li, h1, .row > *, .summary, .skills { unicode-bidi: plaintext }
</style></head><body><div class="page">
<h1>${esc(d.name || '')}</h1>
${contact}
${credential ? `<p>${credential}</p>` : ''}
${summary ? section('Summary', summary) : ''}${body}
</div></body></html>`
}

// The cover letter as a designed page: the same letterhead, palette and type as the resume so the two files read as a set.
// `text` is the plain letter (blank-line-separated blocks, line breaks kept inside a block); `date` is already formatted.
// Pure and escaped like buildResumeHTML — no scripts, no images, no remote resources.
function buildCoverLetterHTML(text, data, designTokens, { date = null } = {}) {
  const d = data || {}
  const palette = designTokens?.palette || { bg: '#FFFFFF', primary: '#1E40AF', accent: '#E2E8F0', text: '#1F2937' }
  const fonts   = designTokens?.fonts || {}
  const stack   = fontStacks(fonts)
  const hPt = Number(fonts.hPt) || 23
  const paper = designTokens?.paper === 'a4' ? { key: 'a4', css: 'A4', width: '210mm', minHeight: '268mm' } : { key: 'letter', css: 'Letter', width: '8.5in', minHeight: '9.85in' }
  // A letter only just over a page gets a slightly denser layout instead of a signature alone on page 2 (lib/docFit.js).
  const compact = (designTokens?.density === 'compact' || designTokens?.density === 'normal' ? designTokens.density : letterDensityFor(text, paper.key, 'pdf')) === 'compact'
  const bPt = Math.max(Number(fonts.bPt) || 10.5, 10.5) + (compact ? 0 : 0.5)
  const contact = contactBlock(d)
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const body = blocks.map(b => `<p class="block">${b.split('\n').map(l => esc(l.trim())).join('<br>')}</p>`).join('')
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(d.name ? `${d.name} - Cover letter` : 'Cover letter')}</title>
<style>
${FONT_FACE_CSS}
@page { size: ${paper.css}; margin: 14mm 0 }
* { box-sizing: border-box }
html, body { margin: 0; padding: 0 }
html { background: ${esc(palette.bg)} }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; overflow-wrap: anywhere; background: ${esc(palette.bg)}; color: ${esc(palette.text)};
  font-family: ${stack.body}; font-size: ${bPt}pt; line-height: ${compact ? 1.42 : 1.55} }
.page { width: ${paper.width}; min-height: ${paper.minHeight}; padding: 0 20mm 0 22mm; border-left: 4px solid ${esc(palette.primary)} }
h1 { font-family: ${stack.heading}; font-size: ${hPt}pt; margin: 0 0 3pt; color: ${esc(palette.primary)}; letter-spacing: .2pt }
.contact { font-size: ${Math.max(bPt - 2, 8)}pt; margin: 0 0 18pt; padding-bottom: 8pt; border-bottom: 1px solid ${ruleColor(palette.primary)} }
.date { margin: 0 0 14pt }
.block { margin: 0 0 ${compact ? 8 : 11}pt; orphans: 3; widows: 3 }
a { color: inherit; text-decoration: none }
.nw { white-space: nowrap }
.contact.more { margin: 0 0 2pt; padding-bottom: 0; border-bottom: 0 }
</style></head><body><div class="page">
${d.name ? `<h1>${esc(d.name)}</h1>` : ''}
${contact}
${date ? `<p class="date">${esc(date)}</p>` : ''}
${body}
</div></body></html>`
}

module.exports = { buildResumeHTML, buildCoverLetterHTML }
