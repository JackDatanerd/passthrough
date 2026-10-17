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
const str = v => (typeof v === 'string' ? v.trim() : '')
const arr = v => (Array.isArray(v) ? v : [])
const wrapLines = (s, cpl) => { const t = str(s); return t ? Math.max(1, Math.ceil(t.length / cpl)) : 0 }

function estimateLoad(d) {
  d = d && typeof d === 'object' ? d : {}
  let n = 3.2                                                       // name, contact line, credential line
  const section = rows => (rows > 0 ? 2.5 + rows : 0)               // heading + its rule and margins
  n += section(wrapLines(d.summary, CPL_FULL))
  const entries = (items, headKeys, bulletKey = 'bullets') => {
    let rows = 0
    for (const it of arr(items)) {
      if (!it || typeof it !== 'object') continue
      rows += (headKeys.some(k => str(it[k])) ? 1.4 : 0)
      for (const b of arr(it[bulletKey])) rows += wrapLines(b, CPL_BULLET)
      if (str(it.details)) rows += wrapLines(it.details, CPL_FULL)
      rows += 0.5
    }
    return rows
  }
  n += section(entries(d.experience, ['title', 'company']))
  n += section(arr(d.projects).reduce((s, p) => s + (p && typeof p === 'object' ? 1.4 + wrapLines(p.description, CPL_BULLET) + (str(p.link) ? 1 : 0) + 0.5 : 0), 0))
  n += section(entries(d.education, ['degree', 'institution']))
  n += section(wrapLines(arr(d.skills).map(str).filter(Boolean).join(' · '), CPL_FULL))
  n += section(arr(d.certifications).reduce((s, c) => s + wrapLines(c, CPL_BULLET), 0))
  n += section(entries(d.volunteer, ['role', 'organization']))
  n += section(arr(d.awards).reduce((s, c) => s + wrapLines(c, CPL_BULLET), 0))
  n += section(arr(d.publications).reduce((s, c) => s + wrapLines(c, CPL_BULLET), 0))
  n += section(wrapLines(arr(d.languages).map(str).filter(Boolean).join(' · '), CPL_FULL))
  return n
}

// The printable height of Letter is 94% of A4's, so its capacity is too.
const capacityFor = (paper, target = 'pdf') => (CAPACITY_A4[target] || CAPACITY_A4.pdf) * (paper === 'letter' ? 0.935 : 1)

/** densityFor(data, 'a4'|'letter', 'pdf'|'docx') -> 'normal' | 'compact' (paper uses design.service.js's lower-case keys) */
function densityFor(data, paper = 'letter', target = 'pdf') {
  const t = target === 'docx' ? 'docx' : 'pdf'
  const load = estimateLoad(data), cap = capacityFor(paper, t)
  return load > cap && load <= cap * SQUEEZE_LIMIT[t] ? 'compact' : 'normal'
}

module.exports = { estimateLoad, densityFor, capacityFor, CAPACITY_A4, SQUEEZE_LIMIT }
