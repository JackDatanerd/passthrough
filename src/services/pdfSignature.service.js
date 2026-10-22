// The signature skeleton (document look 3, migration 0102): the resume and cover letter PDFs people actually email.
//
// pdfTemplate.service.js still renders looks 1 and 2 byte-for-byte as they were delivered; this file is only reached when a scan's
// look is 3 or later, so it can be designed freely without moving a document that already left. Same promises as that file: a pure
// function of the data, everything interpolated escaped, no scripts, no images, no remote resources, real text in reading order
// (single column, no tables, nothing the text layer would scramble).
//
// What "signature" means here
//   - One skeleton for everyone: the same hierarchy, rhythm and credential, so a Passthrough document is recognisable and its
//     structure is the thing ATS software and a recruiter's eye are both used to.
//   - Four presets that differ in the header and the section headings - not only in colour - so Traditional, Professional, Modern
//     and Creative are four distinct designs on one skeleton (the preset comes from design.service.js).
//   - The credential is a designed mark in the header, large enough to be seen and carrying the address a printed copy needs.
//   - Role / company / dates are three levels, not one bold run: the role leads, the employer is set in the ink colour beneath it,
//     the dates sit at the right edge in muted figures.
//   - A short resume is given room (spacing scales up as the page gets emptier), a resume just over a page is tightened a little
//     (lib/docFit.js), so a page never looks half-finished or has two stray lines on a second page.

const { hrefFor, displayUrl } = require('../lib/links')
const { densityFor, letterDensityFor, estimateLoad, capacityFor, airinessFor } = require('../lib/docFit')
const { stripBullet } = require('../lib/bulletText')
const { contactRows, contactItems } = require('../lib/contactLayout')
const { FONT_FACE_CSS } = require('../lib/embeddedFonts')
const { canonDates } = require('../lib/dateFormat')

// The credential's check is DRAWN (U+2713 is in neither Arial nor Liberation Sans and printed as an empty box, and it keeps a stray
// symbol out of the text layer).
const CHECK_SVG = '<svg class="ck" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M1.6 5.4l2.4 2.4 4.4-5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const PRESET_IDS = ['traditional', 'professional', 'modern', 'creative']
const hex6 = v => { const m = /^#?([0-9a-f]{6})$/i.exec(String(v || '')); return m ? parseInt(m[1], 16) : null }
// `amount` of white mixed into a colour: .9 is a pale tint, .55 a soft rule.
const mixWhite = (hex, amount, fallback) => {
  const n = hex6(hex)
  if (n === null) return fallback
  const c = v => Math.round(v * (1 - amount) + 255 * amount).toString(16).padStart(2, '0')
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`
}
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p

function paperOf(designTokens) {
  return designTokens?.paper === 'a4' ? { key: 'a4', css: 'A4', width: '210mm' } : { key: 'letter', css: 'Letter', width: '8.5in' }
}

// The contact details as one or two rows (lib/contactLayout.js). Each item is unbreakable and carries its separator, so a row only
// ever wraps BETWEEN items - never inside a link, never with a separator stranded at the start of a line.
function contactBlock(d, h) {
  const rows = contactRows(contactItems(d))
  return rows.map((row, ri) => `<p class="contact">` +
    row.map((it, i) => `<span class="nw">${h.contactItem(it.text, it.link)}${i < row.length - 1 ? '<span class="sep">&nbsp;&middot;&nbsp;</span>' : ''}</span>`).join('') + '</p>').join('')
}

// ── the skin: everything that differs between the four presets, as CSS ──────────────────────────────────────────────
function skin(preset, c) {
  const P = c.primary, rule = c.rule
  switch (preset) {
    case 'traditional': return `
.top { flex-direction: column; align-items: center; text-align: center; padding-bottom: 9pt; border-bottom: 3px double ${rule}; margin-bottom: 2pt }
h1 { flex: none }
.contact { order: 2; flex: none; justify-content: center }
.seal { order: 3; margin: 6pt 0 0; text-align: center }
h2 { font-size: ${c.h2}pt; letter-spacing: 1.6pt; text-transform: uppercase; border-bottom: .75pt solid ${rule}; padding-bottom: 2.5pt }`
    case 'modern': return `
.top { border-top: 4px solid ${P}; padding-top: 11pt; padding-bottom: 3pt }
h1 { letter-spacing: -.2pt }
.seal { border-radius: 3pt }
h2 { font-size: ${c.h2}pt; letter-spacing: 1.4pt; text-transform: uppercase; display: flex; align-items: center; gap: 6pt }
h2::before { content: ""; width: 6pt; height: 6pt; background: ${P}; flex: none }
h2::after { content: ""; height: .75pt; background: ${rule}; flex: 1 1 auto }`
    case 'creative': return `
.top { padding-bottom: 4pt }
h1 { line-height: 1.05; letter-spacing: -.3pt }
h1::after { content: ""; display: block; width: 38pt; height: 3.5pt; background: ${P}; margin-top: 7pt; border-radius: 2pt }
.seal { background: ${c.tint}; border: 0; border-radius: 99pt; padding: 5pt 11pt }
h2 { font-size: ${c.h2 + 3}pt; letter-spacing: .1pt; text-transform: none; padding-bottom: 0 }
`
    default: return `
.top { padding-bottom: 8pt; border-bottom: .75pt solid ${rule} }
.seal { border-radius: 4pt }
h2 { position: relative; font-size: ${c.h2}pt; letter-spacing: 1.3pt; text-transform: uppercase; padding-bottom: 3pt; border-bottom: .75pt solid ${rule} }
h2::after { content: ""; position: absolute; left: 0; bottom: -1.4pt; width: 30pt; height: 2.6pt; background: ${P} }`
  }
}

// One stylesheet for the resume and the cover letter, parameterised by the tokens and a spacing scale `f` (1 = the base rhythm).
function styles({ palette, fonts, stack, paper, preset, bPt, f, compact, margin, lineHeight, foot }) {
  const P = palette.primary
  const rule = mixWhite(P, 0.55, '#9CA3AF')
  const tint = mixWhite(P, 0.9, '#EEF2F7')
  const hPt = num(fonts.hPt, 23)
  const namePt = round(hPt + (preset === 'creative' ? 10 : 5), 1)
  const c = { primary: P, rule, tint, h2: round(bPt + 1.4, 1) }
  const sp = n => round(n * f, 1)
  return `${FONT_FACE_CSS}
/* Top/bottom page margins belong to the PRINT ENGINE (pdf.service.js passes the same 14mm), not to the container. */
@page { size: ${paper.css}; margin: 14mm 0;
  @bottom-center { content: ${foot}; font: 8pt ${stack.body}; color: #6B7280 } }
@page :first { @bottom-center { content: none } }
* { box-sizing: border-box }
html, body { margin: 0; padding: 0 }
html { background: ${palette.bg} }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; overflow-wrap: anywhere; background: ${palette.bg}; color: ${palette.text};
  font-family: ${stack.body}; font-size: ${bPt}pt; line-height: ${lineHeight}; font-kerning: normal }
.page { width: ${paper.width}; padding: 0 ${margin} }
a { color: inherit; text-decoration: none }
p { margin: 0 }
.nw { white-space: nowrap }
.sep { color: ${rule} }

/* header: the name and the credential seal share the first line, the contact rows take the full width beneath (DOM order stays
   name, contact, credential - the order a parser reads) */
.top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; column-gap: 16pt }
h1 { order: 1; flex: 1 1 auto; min-width: 0; font-family: ${stack.heading}; font-size: ${namePt}pt; font-weight: 700; margin: 0 0 ${sp(4)}pt; color: ${P}; line-height: 1.12 }
.seal { order: 2; flex: none; display: flex; flex-direction: column; gap: 1.5pt; text-align: right; padding: 5pt 9pt 5pt; border: .9pt solid ${P}; color: ${P}; max-width: 62mm; margin-bottom: ${sp(4)}pt }
.contact { order: 3; flex: 0 0 100%; display: flex; flex-wrap: wrap; font-size: ${Math.max(round(bPt - 1.2, 1), 8.5)}pt; color: ${palette.text}; margin: 0 0 1.5pt }
.seal .t { font-size: 8.5pt; font-weight: 700; letter-spacing: .7pt; text-transform: uppercase; white-space: nowrap }
.seal .u { font-size: 7.5pt; color: #4B5563; letter-spacing: .1pt; white-space: nowrap }
.seal.plain { border-color: #9CA3AF; color: #4B5563; background: none }
.ck { width: 9pt; height: 9pt; vertical-align: -1pt; margin-right: 3pt }

/* sections */
section { page-break-inside: auto }
h2 { font-family: ${stack.heading}; font-weight: 700; color: ${P}; margin: ${sp(compact ? 12 : 17)}pt 0 ${sp(compact ? 5 : 7)}pt; break-after: avoid; page-break-after: avoid }
.summary { margin-top: 1pt; font-size: ${round(bPt + 0.3, 1)}pt }
.entry { margin-bottom: ${sp(compact ? 6 : 9)}pt; break-inside: avoid; page-break-inside: avoid }
.eh { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 12pt }
.role { font-weight: 700; font-size: ${round(bPt + 0.4, 1)}pt; flex: 1 1 55%; min-width: 0; color: #111827 }
.dates { order: 1; margin-left: auto; white-space: nowrap; font-size: ${Math.max(round(bPt - 1, 1), 8.5)}pt; color: #4B5563; font-variant-numeric: tabular-nums }
.org { order: 2; flex: 0 0 100%; color: ${P}; font-weight: 600; margin-top: .5pt }
.org .loc { color: #4B5563; font-weight: 400 }
ul { margin: ${sp(3.5)}pt 0 0; padding-left: 13pt; list-style: disc }
li { margin-bottom: ${sp(2.2)}pt; padding-left: 1pt }
li::marker { color: ${P}; font-size: .9em }
.skills { margin-top: 1pt; line-height: ${round(lineHeight + 0.08, 2)} }
.skills .dot { color: ${P}; padding: 0 3pt }
.detail { margin-top: 1.5pt; color: #374151 }
.link { font-size: ${Math.max(round(bPt - 1, 1), 8.5)}pt; margin-top: 1.5pt }
p, li, h1, .role, .org, .dates, .summary, .skills, .detail { unicode-bidi: plaintext }
${skin(preset, c)}`
}

// The continuation-page footer as a CSS content value: the name (sanitised into a string literal), then "Page n of m".
const footerOf = (h, name) => {
  const n = h.cssStr(name)
  return `"${n ? n + '  \\00B7  ' : ''}Page " counter(page) " of " counter(pages)`
}

function safePreset(designTokens) {
  return PRESET_IDS.includes(designTokens?.preset) ? designTokens.preset : 'professional'
}

// ── the resume ───────────────────────────────────────────────────────────────────────────────────────────────────────
function buildSignatureResumeHTML(data, designTokens, verificationUrl, { verified = true } = {}, h) {
  const { esc, safeHref, list, str } = h
  const d = data || {}
  const palette = { bg: '#FFFFFF', primary: '#1E40AF', accent: '#E2E8F0', text: '#1F2937', ...(designTokens?.palette || {}) }
  const fonts = designTokens?.fonts || {}
  const stack = h.fontStacks(fonts)
  const preset = safePreset(designTokens)
  const paper = paperOf(designTokens)
  // The load of the page decides its rhythm: just over a page is tightened, a sparse page is given room (never both).
  const forced = designTokens?.density === 'compact' || designTokens?.density === 'normal' ? designTokens.density : null
  const density = forced || densityFor(d, paper.key, 'pdf', 3)
  const compact = density === 'compact'
  const f = forced ? 1 : airinessFor(estimateLoad(d, 3), capacityFor(paper.key, 'pdf', 3))
  const bPt = round(num(fonts.bPt, 10.5) - (compact ? 0.5 : 0), 1)
  const lineHeight = compact ? 1.38 : round(1.46 + (f - 1) * 0.12, 2)

  const href = safeHref(verificationUrl)
  const seal = href
    ? `<a class="seal${verified ? '' : ' plain'}" href="${esc(href)}"><span class="t">${verified ? CHECK_SVG + 'Passthrough Verified' : 'Passthrough Scan Report'}</span><span class="u">${esc(displayUrl(href))}</span></a>`
    : ''

  const section = (title, inner) => inner ? `<section><h2>${esc(title)}</h2>${inner}</section>` : ''
  const bullets = items => { const b = list(items).map(str).filter(Boolean); return b.length ? `<ul>${b.map(x => `<li dir="auto">${esc(stripBullet(x))}</li>`).join('')}</ul>` : '' }

  // role (bold) / organisation (ink colour) · location (muted) / dates (right). DOM order is role, organisation, dates - the order
  // a parser reads "Title, Company, dates" in - and CSS moves the dates up beside the role.
  const entryHead = (role, org, loc, dates) => {
    const a = str(role), b = str(org), l = str(loc), t = canonDates(str(dates))
    const lead = a || b, sub = a ? b : ''
    const second = [sub && esc(sub), l && `<span class="loc">${sub ? ' &middot; ' : ''}${esc(l)}</span>`].filter(Boolean).join('')
    if (!lead && !t) return ''
    return `<div class="eh"><span class="role">${esc(lead)}</span>${second ? `<span class="org">${second}</span>` : ''}${t ? `<span class="dates">${esc(t)}</span>` : ''}</div>`
  }

  const summary = str(d.summary) ? `<p class="summary">${esc(d.summary)}</p>` : ''

  const experience = list(d.experience).map(job => {
    const head = entryHead(job?.title, job?.company, job?.location, job?.dates)
    const b = bullets(job?.bullets)
    return head || b ? `<div class="entry">${head}${b}</div>` : ''
  }).join('')

  const education = list(d.education).map(e => {
    const head = entryHead(e?.degree, e?.institution, '', e?.dates)
    const details = str(e?.details)
    return head ? `<div class="entry">${head}${details ? `<p class="detail">${esc(details)}</p>` : ''}</div>` : ''
  }).join('')

  const skills = list(d.skills).map(str).map(stripBullet).map(str).filter(Boolean)
  const skillsHtml = skills.length ? `<p class="skills">${skills.map(esc).join(', ')}</p>` : ''

  const projects = list(d.projects).map(p => {
    const name = str(p?.name), desc = str(p?.description), link = str(p?.link)
    const tech = list(p?.technologies).map(str).filter(Boolean)
    if (!name && !desc) return ''
    const l = hrefFor(link)
    return `<div class="entry"><div class="eh"><span class="role">${esc(name)}</span>${tech.length ? `<span class="org"><span class="loc">${tech.map(esc).join(', ')}</span></span>` : ''}</div>` +
      (desc ? `<ul><li dir="auto">${esc(stripBullet(desc))}</li></ul>` : '') +
      (link ? `<p class="link">${l ? `<a href="${esc(l)}">${esc(link)}</a>` : esc(link)}</p>` : '') + '</div>'
  }).join('')

  const volunteer = list(d.volunteer).map(v => {
    const head = entryHead(v?.role, v?.organization, '', v?.dates)
    const b = bullets(v?.bullets)
    return head || b ? `<div class="entry">${head}${b}</div>` : ''
  }).join('')

  const languages = list(d.languages).map(str).map(stripBullet).map(str).filter(Boolean)
  const languagesHtml = languages.length ? `<p class="skills">${languages.map(esc).join(', ')}</p>` : ''
  const certs = bullets(list(d.certifications).map(c => stripBullet(str(c))))

  // No job history (a student, a career changer, a from-scratch resume): Education then Projects lead. Same rule as the DOCX.
  const projectsSection = section('Projects', projects)
  const experienceSection = section('Experience', experience)
  const educationSection = section('Education', education)
  const head = experience ? [experienceSection, projectsSection, educationSection] : [educationSection, projectsSection, section('Volunteer Experience', volunteer)]
  const body = head.join('') + section('Skills', skillsHtml) + section('Certifications', certs) +
    (experience ? section('Volunteer Experience', volunteer) : '') + section('Awards', bullets(d.awards)) +
    section('Publications', bullets(d.publications)) + section('Languages', languagesHtml)

  const css = styles({ palette, fonts, stack, paper, preset, bPt, f, compact, margin: '17mm', lineHeight, foot: footerOf(h, d.name) })
  return `<!DOCTYPE html>
<html lang="${paper.key === 'a4' ? 'en-GB' : 'en-US'}"><head><meta charset="utf-8"><title>${esc(d.name || 'Resume')}</title>
<style>
${css}
</style></head><body><div class="page">
<header class="top"><h1>${esc(d.name || '')}</h1>${contactBlock(d, h)}${seal}</header>
${summary ? section('Summary', summary) : ''}${body}
</div></body></html>`
}

// ── the cover letter: the same letterhead, palette and type, so the two files read as a set ────────────────────────────
function buildSignatureCoverLetterHTML(text, data, designTokens, { date = null } = {}, h) {
  const { esc } = h
  const d = data || {}
  const palette = { bg: '#FFFFFF', primary: '#1E40AF', accent: '#E2E8F0', text: '#1F2937', ...(designTokens?.palette || {}) }
  const fonts = designTokens?.fonts || {}
  const stack = h.fontStacks(fonts)
  const preset = safePreset(designTokens)
  const paper = paperOf(designTokens)
  const forced = designTokens?.density === 'compact' || designTokens?.density === 'normal' ? designTokens.density : null
  const compact = (forced || letterDensityFor(text, paper.key, 'pdf')) === 'compact'
  const bPt = round(Math.max(num(fonts.bPt, 10.5), 10.5) + (compact ? 0 : 0.5), 1)
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const body = blocks.map(b => `<p class="block">${b.split('\n').map(l => esc(l.trim())).join('<br>')}</p>`).join('')
  const css = styles({ palette, fonts, stack, paper, preset, bPt, f: 1, compact, margin: '22mm', lineHeight: compact ? 1.45 : 1.58, foot: footerOf(h, '') })
  return `<!DOCTYPE html>
<html lang="${paper.key === 'a4' ? 'en-GB' : 'en-US'}"><head><meta charset="utf-8"><title>${esc(d.name ? `${d.name} - Cover letter` : 'Cover letter')}</title>
<style>
${css}
@page :first { @bottom-center { content: none } }
.top { margin-bottom: 20pt }
.date { margin: 0 0 14pt; color: #374151 }
.block { margin: 0 0 ${compact ? 8 : 11}pt; orphans: 3; widows: 3 }
</style></head><body><div class="page">
<header class="top">${d.name ? `<h1>${esc(d.name)}</h1>` : ''}${contactBlock(d, h)}</header>
${date ? `<p class="date">${esc(date)}</p>` : ''}
${body}
</div></body></html>`
}

module.exports = { buildSignatureResumeHTML, buildSignatureCoverLetterHTML, PRESET_IDS }
