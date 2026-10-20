// Fit control for the generated resume. A resume that overflows its page by two lines (a lone Awards heading and one
// bullet on page 2) reads as careless, and neither renderer can measure a laid-out page here (the Worker has no layout
// engine). So the length is ESTIMATED from the data, as a pure function, and a resume that is just over one page gets a
// slightly denser layout (a little less font size, margin and spacing) — the same decision in the DOCX and the PDF.
// A resume that is clearly longer than a page is left at normal density: squeezing a genuinely two-page document only
// makes it harder to read.

const CPL_FULL   = 108   // characters per full-width line at normal density
const CPL_BULLET = 98    // ...and per indented bullet line
// Line units one A4 page holds at normal density, and how much overflow a denser layout can absorb, PER RENDERER -
// measured, not guessed (applicant docs pass 2): resumes of 20 sizes were rendered and their real page counts compared with
// the estimate. The DOCX (Calibri, 0.75in margins) holds about 58.5 and compact absorbs ~8% more; the PDF template holds
// about 48-50 (bigger type, 14mm page margins) and compact absorbs ~17%. The PDF figures come from WeasyPrint, not Chromium, so
// the PDF capacity is set at the low, safe end: compacting a little early costs nothing, compacting too late leaves a spill.
const CAPACITY_A4 = { docx: 58.5, pdf: 48 }
const SQUEEZE_LIMIT = { docx: 1.08, pdf: 1.17 } // beyond this much overflow a second page is the honest answer
// Look 3 (the signature PDF skeleton). Measured like the figures above: resumes of many sizes rendered, real page counts against the estimate.
const SIG = { header: 4.4, section: 3.0, entryHead: 2.3, entryGap: 0.9, projectHead: 1.7 }
const CAPACITY_A4_SIG = { pdf: 48 }
const SQUEEZE_LIMIT_SIG = { pdf: 1.12 }
const str = v => (typeof v === 'string' ? v.trim() : '')
const arr = v => (Array.isArray(v) ? v : [])
const wrapLines = (s, cpl) => { const t = str(s); return t ? Math.max(1, Math.ceil(t.length / cpl)) : 0 }

// `look` 3 is the signature skeleton (pdfSignature.service.js): a taller header (name, contact, credential seal), roomier section headings
// and an entry head of TWO lines (role and dates, then employer) where looks 1 and 2 print one. Anything else is the original estimate.
function estimateLoad(d, look = 1) {
  d = d && typeof d === 'object' ? d : {}
  const sig = Number(look) >= 3
  let n = sig ? SIG.header : 3.2                                    // name, contact line, credential line
  const section = rows => (rows > 0 ? (sig ? SIG.section : 2.5) + rows : 0)   // heading + its rule and margins
  n += section(wrapLines(d.summary, CPL_FULL))
  const entries = (items, headKeys, bulletKey = 'bullets') => {
    let rows = 0
    for (const it of arr(items)) {
      if (!it || typeof it !== 'object') continue
      rows += (headKeys.some(k => str(it[k])) ? (sig ? SIG.entryHead : 1.4) : 0)
      for (const b of arr(it[bulletKey])) rows += wrapLines(b, CPL_BULLET)
      if (str(it.details)) rows += wrapLines(it.details, CPL_FULL)
      rows += sig ? SIG.entryGap : 0.5
    }
    return rows
  }
  n += section(entries(d.experience, ['title', 'company']))
  n += section(arr(d.projects).reduce((s, p) => s + (p && typeof p === 'object' ? (sig ? SIG.projectHead : 1.4) + wrapLines(p.description, CPL_BULLET) + (str(p.link) ? 1 : 0) + 0.5 : 0), 0))
  n += section(entries(d.education, ['degree', 'institution']))
  n += section(wrapLines(arr(d.skills).map(str).filter(Boolean).join(' · '), CPL_FULL))
  n += section(arr(d.certifications).reduce((s, c) => s + wrapLines(c, CPL_BULLET), 0))
  n += section(entries(d.volunteer, ['role', 'organization']))
  n += section(arr(d.awards).reduce((s, c) => s + wrapLines(c, CPL_BULLET), 0))
  n += section(arr(d.publications).reduce((s, c) => s + wrapLines(c, CPL_BULLET), 0))
  n += section(wrapLines(arr(d.languages).map(str).filter(Boolean).join(' · '), CPL_FULL))
  return n
}

// The printable height of Letter is 94% of A4's, so its capacity is too. `look` 3 has its own measured capacity (CAPACITY_A4_SIG).
const capacityFor = (paper, target = 'pdf', look = 1) => ((Number(look) >= 3 && target !== 'docx' ? CAPACITY_A4_SIG.pdf : (CAPACITY_A4[target] || CAPACITY_A4.pdf)) * (paper === 'letter' ? 0.935 : 1))

/** densityFor(data, 'a4'|'letter', 'pdf'|'docx', look) -> 'normal' | 'compact' (paper uses design.service.js's lower-case keys) */
function densityFor(data, paper = 'letter', target = 'pdf', look = 1) {
  const t = target === 'docx' ? 'docx' : 'pdf'
  const sig = Number(look) >= 3 && t === 'pdf'
  const load = estimateLoad(data, sig ? 3 : 1), cap = capacityFor(paper, t, sig ? 3 : 1)
  return load > cap && load <= cap * (sig ? SQUEEZE_LIMIT_SIG.pdf : SQUEEZE_LIMIT[t]) ? 'compact' : 'normal'
}

/** How much room a short page is given, as a spacing multiplier: 1 once a page is mostly full, up to 1.3 for a nearly empty one. */
function airinessFor(load, cap) {
  const r = Number(load) / Number(cap)
  if (!Number.isFinite(r) || r >= 0.85) return 1
  if (r <= 0.5) return 1.3
  return Math.round((1 + (0.85 - r) / 0.35 * 0.3) * 100) / 100
}

// ── cover letter ────────────────────────────────────────────────────────────────────────────────────────────────────────
// The same idea for a letter, by word count (a letter is plain paragraphs). Since the letter became editable (up to 4,000
// characters) a letter a few lines over one page is easy to reach: the last paragraph and the signature land alone on page 2.
// Capacities are measured against real renders (LETTER_WORDS, below); a letter clearly longer than a page is left alone.
// Measured on A4 with 7-character stand-in words (real prose averages ~6, so these are the safe end). PDF: in real Chromium with the
// embedded faces the letter holds ~370 words at normal density and ~430 compact. DOCX (LibreOffice, Calibri-metric Carlito): ~505 / ~600.
const LETTER_WORDS = { pdf: { normal: 365, limit: 1.17 }, docx: { normal: 470, limit: 1.2 } }
const wordCount = t => (String(t || '').trim().match(/\S+/g) || []).length

/** letterDensityFor(text, 'a4'|'letter', 'pdf'|'docx') -> 'normal' | 'compact' */
function letterDensityFor(text, paper = 'letter', target = 'pdf') {
  const t = LETTER_WORDS[target === 'docx' ? 'docx' : 'pdf']
  const cap = t.normal * (paper === 'letter' ? 0.94 : 1), words = wordCount(text)
  return words > cap && words <= cap * t.limit ? 'compact' : 'normal'
}

module.exports = { airinessFor, letterDensityFor, LETTER_WORDS, estimateLoad, densityFor, capacityFor, CAPACITY_A4, SQUEEZE_LIMIT }
