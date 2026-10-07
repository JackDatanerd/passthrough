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

const esc = v => String(v ?? '')
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
  const serifHeading = /Merriweather|Playfair|Baskerville|Cormorant|Crimson/i.test(heading)
  return {
    heading: serifHeading ? 'Georgia, "Times New Roman", serif' : '"Helvetica Neue", Arial, sans-serif',
    body:    '"Helvetica Neue", Arial, "Segoe UI", sans-serif',
  }
}

function buildResumeHTML(data, designTokens, verificationUrl, { verified = true } = {}) {
  const d = data || {}
  const palette = designTokens?.palette || { bg: '#FFFFFF', primary: '#1E40AF', accent: '#E2E8F0', text: '#1F2937' }
  const fonts   = designTokens?.fonts || {}
  const stack   = fontStacks(fonts)
  const hPt = Number(fonts.hPt) || 23
  const bPt = Number(fonts.bPt) || 10.5

  const contact = [d.email, d.phone, d.location, d.linkedin, d.portfolio].map(str).filter(Boolean).map(esc)
  const href = safeHref(verificationUrl)
  const credential = href
    ? `<a class="cred" href="${esc(href)}">${verified ? '&#10003; Passthrough Verified' : 'Passthrough Scan Report'}</a>`
    : ''

  const section = (title, inner) => inner ? `<section><h2>${esc(title)}</h2>${inner}</section>` : ''

  const summary = str(d.summary) ? `<p class="summary">${esc(d.summary)}</p>` : ''

  const experience = list(d.experience).map(job => {
    const head = [str(job?.title), str(job?.company), str(job?.location)].filter(Boolean).map(esc).join(' &mdash; ')
    const dates = str(job?.dates)
    const bullets = list(job?.bullets).map(str).filter(Boolean)
    if (!head && !dates && !bullets.length) return ''
    return `<div class="entry"><div class="row"><span class="strong">${head}</span>${dates ? `<span class="dates">${esc(dates)}</span>` : ''}</div>` +
      (bullets.length ? `<ul>${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '') + `</div>`
  }).join('')

  const education = list(d.education).map(e => {
    const head = [str(e?.degree), str(e?.institution)].filter(Boolean).map(esc).join(' &mdash; ')
    const dates = str(e?.dates)
    const details = str(e?.details)
    if (!head && !dates) return ''
    return `<div class="entry"><div class="row"><span class="strong">${head}</span>${dates ? `<span class="dates">${esc(dates)}</span>` : ''}</div>` +
      (details ? `<p>${esc(details)}</p>` : '') + `</div>`
  }).join('')

  const skills = list(d.skills).map(str).filter(Boolean)
  const skillsHtml = skills.length ? `<p class="skills">${skills.map(esc).join(' &middot; ')}</p>` : ''

  const certs = list(d.certifications).map(str).filter(Boolean)
  const certsHtml = certs.length ? `<ul>${certs.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''

  const projects = list(d.projects).map(p => {
    const name = str(p?.name)
    const tech = list(p?.technologies).map(str).filter(Boolean)
    const desc = str(p?.description)
    const link = str(p?.link)
    if (!name && !desc) return ''
    const l = safeHref(link)
    return `<div class="entry"><div class="row"><span class="strong">${esc(name)}</span>${tech.length ? `<span class="dates">${tech.map(esc).join(', ')}</span>` : ''}</div>` +
      (desc ? `<ul><li>${esc(desc)}</li></ul>` : '') +
      (link ? `<p class="link">${l ? `<a href="${esc(l)}">${esc(link)}</a>` : esc(link)}</p>` : '') + `</div>`
  }).join('')

  const volunteer = list(d.volunteer).map(v => {
    const head = [str(v?.role), str(v?.organization)].filter(Boolean).map(esc).join(' &mdash; ')
    const dates = str(v?.dates)
    const bullets = list(v?.bullets).map(str).filter(Boolean)
    if (!head && !dates && !bullets.length) return ''
    return `<div class="entry"><div class="row"><span class="strong">${head}</span>${dates ? `<span class="dates">${esc(dates)}</span>` : ''}</div>` +
      (bullets.length ? `<ul>${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '') + `</div>`
  }).join('')
  const plainList = v => { const items = list(v).map(str).filter(Boolean); return items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '' }
  const languages = list(d.languages).map(str).filter(Boolean)
  const languagesHtml = languages.length ? `<p class="skills">${languages.map(esc).join(' &middot; ')}</p>` : ''

  // Projects lead for candidates with no formal experience — the same rule the AI layout is given.
  const projectsSection = section('Projects', projects)
  const experienceSection = section('Experience', experience)
  const body = (experience ? [experienceSection, projectsSection] : [projectsSection, experienceSection]).join('') +
    section('Education', education) + section('Skills', skillsHtml) + section('Certifications', certsHtml) +
    section('Volunteer Experience', volunteer) + section('Awards', plainList(d.awards)) +
    section('Publications', plainList(d.publications)) + section('Languages', languagesHtml)

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(d.name || 'Resume')}</title>
<style>
/* Top/bottom page margins belong to the PRINT ENGINE (pdf.service.js passes the same 14mm), not to
   the container: padding on one tall box only pads its first top and last bottom edge, so on a
   2-page resume page 1 ran to the bottom edge and page 2 started at the top edge. */
@page { size: A4; margin: 14mm 0 }
* { box-sizing: border-box }
html, body { margin: 0; padding: 0 }
html { background: ${esc(palette.bg)} }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: ${esc(palette.bg)}; color: ${esc(palette.text)};
  font-family: ${stack.body}; font-size: ${bPt}pt; line-height: 1.45 }
.page { width: 210mm; min-height: 269mm; padding: 0 16mm 0 18mm; border-left: 4px solid ${esc(palette.primary)} }
h1 { font-family: ${stack.heading}; font-size: ${hPt}pt; margin: 0 0 2pt; color: ${esc(palette.primary)}; letter-spacing: .2pt }
.contact { font-size: ${Math.max(bPt - 1.5, 8)}pt; margin: 0 0 3pt }
.cred { font-size: 8pt; font-variant: small-caps; color: ${esc(palette.primary)}; text-decoration: none }
h2 { font-family: ${stack.heading}; font-size: ${bPt + 1.5}pt; text-transform: uppercase; letter-spacing: 1pt; color: ${esc(palette.primary)};
  border-bottom: 1px solid ${esc(palette.accent)}; padding-bottom: 2pt; margin: 14pt 0 6pt }
section { page-break-inside: auto }
.entry { margin-bottom: 7pt; page-break-inside: avoid }
.row { display: flex; justify-content: space-between; gap: 12pt }
.strong { font-weight: 700 }
.dates { color: ${esc(palette.primary)}; white-space: nowrap; font-size: ${Math.max(bPt - 1, 8)}pt }
ul { margin: 3pt 0 0; padding-left: 14pt }
li { margin-bottom: 2pt }
p { margin: 0 }
.summary, .skills { margin-top: 2pt }
.link { font-size: ${Math.max(bPt - 1.5, 8)}pt; margin-top: 2pt }
a { color: inherit }
</style></head><body><div class="page">
<h1>${esc(d.name || '')}</h1>
${contact.length ? `<p class="contact">${contact.join(' &nbsp;|&nbsp; ')}</p>` : ''}
${credential ? `<p>${credential}</p>` : ''}
${summary ? section('Summary', summary) : ''}${body}
</div></body></html>`
}

module.exports = { buildResumeHTML }
