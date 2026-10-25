// Facts DERIVED from a resume's own dates, so the writing prompts can state them and the fabrication
// guards can accept them. An elite summary opens with career length ("Operations analyst with 8+ years
// ..."), and that figure is never typed anywhere in the source - it is arithmetic on the job dates. The
// guards used to count it as an invented number, so the strongest sentence of a resume could not be written.
//
// Pure functions only. Years only (month names are ignored): the answer is "about N years", and the
// guards accept anything up to it, so a claim can understate but never overstate.

const ONGOING = /\b(?:present|current|currently|now|ongoing|today|date)\b/i
const YEAR = /\b(?:19|20)\d{2}\b/g

function yearsIn(text) {
  const s = String(text || '')
  const out = (s.match(YEAR) || []).map(Number)
  // "'19 - '21" and "2019-21"
  for (const m of s.matchAll(/['’](\d{2})\b/g)) out.push((+m[1] <= 49 ? 2000 : 1900) + +m[1])
  for (const m of s.matchAll(/\b((?:19|20)\d{2})\s*[-–—]\s*(\d{2})\b(?!\d)/g)) out.push(+(m[1].slice(0, 2) + m[2]))
  return out
}

const isOngoing = text => ONGOING.test(String(text || '')) || /(?:19|20)\d{2}\s*[-–—]\s*$/.test(String(text || '').trim())


// ── Month precision ──────────────────────────────────────────────────────────────────────────────────────────────
// Years used to be counted as last year - first year, so "Jan 2020 - Dec 2022" read as 2 years (it is three) and "Jan 2022 -
// Dec 2022" as 0. When a range names its months on both ends (or on its start and runs to Present) it is now measured in
// months, end month included, and the total is floored to whole years - still never an overstatement. A range that names only
// years keeps the year arithmetic it always had. Numeric months (06/2019, 2019-06) are read as the month names they stand for.
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
const monthOf = s => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(s || '').slice(0, 3).toLowerCase())
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// 06/2019 -> "Jun 2019". The ISO form 2019-06 is read as a month only as an end of a range whose other end is also a month (2019-06 to
// 2022-08, or 2019-06 - Present): alone, "2008-09" or "2010-11" is a school year (2008 to 2009), not September 2008.
const ISO = '((?:19|20)\\d{2})\\s*[/-]\\s*(0[1-9]|1[0-2])(?!\\d)'
const ISO_PAIR = new RegExp(`\\b${ISO}\\s*(?:-|–|—|to|until|till)\\s*(?:${ISO}|(?=present|current|now|today|ongoing|date))`, 'gi')
const numericMonthsToNames = t => String(t || '')
  .replace(/\b(0?[1-9]|1[0-2])\s*[/.]\s*((?:19|20)\d{2})\b/g, (_, mm, y) => `${MONTH_ABBR[+mm - 1]} ${y}`)
  .replace(ISO_PAIR, (all, y1, m1, y2, m2) => {
    const sep = all.slice(all.search(/\s*(?:-|–|—|to|until|till)\s*(?:(?:19|20)\d{2}|present|current|now|today|ongoing|date)/i)).replace(/(?:(?:19|20)\d{2})\s*[/-]\s*(?:0[1-9]|1[0-2]).*$/, '')
    return `${MONTH_ABBR[+m1 - 1]} ${y1} to ` + (y2 ? `${MONTH_ABBR[+m2 - 1]} ${y2}` : '')
  })
const POINT = `(?:${MONTH_RE}\\s+)?((?:19|20)\\d{2})`
const SPAN_RE = new RegExp(`\\b${POINT}\\s*(?:-|–|—|to|until|till)\\s*(?:(?:${MONTH_RE})\\s+)?((?:19|20)\\d{2}(?!\\d)|\\d{2}(?!\\d)|present|current|currently|now|today|ongoing|date)`, 'gi')

// Every range in a text as { startYear, endYear, months: [from, to) | null }. `months` is set only when it is month-precise.
function spansIn(text, now = new Date()) {
  const thisYear = now.getUTCFullYear(), thisMonth = now.getUTCMonth()
  const out = []
  const t = numericMonthsToNames(text)
  SPAN_RE.lastIndex = 0
  for (const m of t.matchAll(SPAN_RE)) {
    const sm = m[1] ? monthOf(m[1]) : null, sy = +m[2]
    const em = m[3] ? monthOf(m[3]) : null
    const tail = String(m[4]).toLowerCase()
    const open = !/^\d/.test(tail)
    let ey
    if (/^\d{4}$/.test(tail)) ey = +tail
    else if (/^\d{2}$/.test(tail)) ey = +(m[2].slice(0, 2) + tail)
    else ey = thisYear
    if (sy > thisYear || ey < sy) continue
    ey = Math.min(ey, thisYear)
    let months = null
    if (sm !== null && sm >= 0 && ((em !== null && em >= 0) || open)) {
      const from = sy * 12 + sm
      // End month included; an open range runs to the current month; a month in the future is capped at now.
      const to = open ? thisYear * 12 + thisMonth + 1 : Math.min(ey * 12 + em + 1, thisYear * 12 + thisMonth + 1)
      if (to > from) months = [from, to]
    }
    out.push({ startYear: sy, endYear: ey, months })
  }
  return out
}

// Union of spans (overlaps counted once, gaps not at all), in months, floored to whole years.
function workedYears(spans) {
  const iv = spans.map(s => (s.months ? s.months : [s.startYear * 12, s.endYear * 12])).filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0])
  if (!iv.length) return null
  let total = 0, [cs, ce] = iv[0]
  for (const [a, b] of iv.slice(1)) { if (a <= ce) ce = Math.max(ce, b); else { total += ce - cs; cs = a; ce = b } }
  total += ce - cs
  return Math.floor(total / 12)
}

// -> { years, firstYear, lastYear, ongoing, roleYears, span } ; years is null when the jobs carry no usable dates.
// `years` is the time actually WORKED: the job periods are merged (overlapping or touching periods count once, a gap
// counts for nothing). It used to be last end - first start, so 2005-2007 plus 2020-Present read as 21 years of
// experience (about 8 worked) and the summary was allowed to say "21+ years" - an overstatement the guard then accepted.
// `span` keeps the old first-to-last number for anything that wants the length of the whole career window.
function careerFacts(resumeData, now = new Date()) {
  const thisYear = now.getUTCFullYear()
  const jobs = Array.isArray(resumeData?.experience) ? resumeData.experience : []
  let first = null, last = null, ongoing = false
  const roleYears = []
  const spans = []
  for (const job of jobs) {
    const ys = yearsIn(job?.dates).filter(y => y <= thisYear)
    const open = isOngoing(job?.dates)
    if (open) ongoing = true
    if (!ys.length) continue
    const start = Math.min(...ys)
    const end = open ? thisYear : Math.max(...ys)
    if (first === null || start < first) first = start
    if (last === null || end > last) last = end
    if (end >= start) {
      roleYears.push(end - start)
      // Every range the entry names counts (a role listed as "2019-2020; 2021-Present" is two stints); a month-precise one is measured
      // in months, anything else keeps the year arithmetic.
      const found = spansIn(job?.dates, now)
      if (found.length > 1) spans.push(...found)
      else spans.push(found[0] || { startYear: start, endYear: end, months: null })
    }
  }
  if (first === null) return { years: null, firstYear: null, lastYear: null, ongoing, roleYears, span: null }
  return { years: Math.max(0, workedYears(spans) ?? 0), firstYear: first, lastYear: last, ongoing, roleYears, span: Math.max(0, last - first) }
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30 }
// "8+ years", "eight years", "10 or more years", "5-7 years" -> [8], [8], [10], [5, 7]. Role-length claims
// ("3 years at Acme") are caught too: they are only ever checked against the career span, which is generous.
const TENURE_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty)\s*(?:\+|-plus|\s+plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*\+?\s*)?(?:or\s+more\s+)?-?\s*years?\b/gi
// "Your posting asks for five years of experience" / "the 5 years you require" restate the POSTING, not the candidate:
// they are not a claim about the applicant. Scan/ATS round 12: the cover-letter guard treated them as the applicant's own claim
// and rejected an honest letter (three attempts, then a 502) whenever the posting asked for more years than the dates show.
// A phrase is skipped only when BOTH hold: the number is one the posting itself states (`posting` = those numbers) and the
// words around it say it is the posting's requirement.
const REQ_BEFORE = /(?:posting|description|advert|advertisement|listing|role|position|job|you|your\s+(?:team|company|organi[sz]ation)|employer)\s+(?:\w+\s+){0,3}?(?:asks?|requires?|required|requiring|seeks?|seeking|wants?|lists?|calls?\s+for|looking\s+for|expects?|needs?|specifi(?:es|ed))\s+(?:for\s+)?(?:at\s+least\s+|a\s+minimum\s+of\s+|minimum\s+of\s+)?$/i
const REQ_AFTER  = /^\s*(?:of\s+)?(?:\w+\s+){0,3}?(?:that\s+)?(?:you|your\s+(?:posting|team))\s+(?:ask|require|list|seek|specif)/i
// SCAN/ATS ROUND 23 (bug, reproduced): a tenure claim written without a digit or a "N years" phrase was invisible. "Analyst with over a
// decade of experience" on a 3-year career passed the summary guard and the cover-letter guard alike ("two decades" was only
// stopped by accident, as a stray "2"). A decade claim is read as the years it stands for: a / one decade 10, half a decade 5, two
// decades 20, "3 decades" 30, a quarter-century 25, "several / multiple / many decades" at least 20, "decade-long" 10. A decade
// that is not a claim about the person ("over the past decade", "a decade ago", "this decade") is left alone.
const DECADE_N = { a: 10, one: 10, two: 20, three: 30, four: 40, five: 50, several: 20, multiple: 20, many: 20 }
const DECADE_RE = /\b(?:(half\s+a|a|one|two|three|four|five|several|multiple|many|\d{1,2})[\s-]+decades?(?:[\s-]+long)?|(quarter[\s-]century)|(decade[\s-]long)|(decades(?=\s+of\s+(?:experience|expertise|leadership|service))))\b(?!\s+(?:ago|earlier|later|from now|of\s+(?:growth|change|decline|progress|innovation|history|war|peace)))/gi
const DECADE_NOT_ABOUT_PERSON = /\b(?:past|last|this|previous|next|coming|every|each|that|the|those|these)\s*$/i
function decadeMatches(src) {
  const out = []
  for (const m of src.matchAll(DECADE_RE)) {
    if (DECADE_NOT_ABOUT_PERSON.test(src.slice(Math.max(0, m.index - 12), m.index))) continue
    let n
    if (m[2]) n = 25
    else if (m[3]) n = 10
    else if (m[4]) n = 20
    else {
      const w = m[1].toLowerCase().replace(/\s+/g, ' ')
      n = w === 'half a' ? 5 : /^\d/.test(w) ? parseInt(w, 10) * 10 : DECADE_N[w]
    }
    if (Number.isFinite(n)) out.push({ index: m.index, length: m[0].length, ns: [n] })
  }
  return out
}
function tenureClaims(text, { posting = null } = {}) {
  const src = String(text || '')
  const found = []
  for (const m of src.matchAll(TENURE_RE)) {
    const ns = []
    for (const g of [m[1], m[2]]) {
      if (!g) continue
      const n = /^\d/.test(g) ? parseInt(g, 10) : WORD_NUM[g.toLowerCase()]
      if (Number.isFinite(n)) ns.push(n)
    }
    found.push({ index: m.index, length: m[0].length, ns })
  }
  found.push(...decadeMatches(src))
  const out = []
  for (const m of found) {
    const { ns } = m
    if (posting && ns.length && ns.every(n => posting.has(n))
        && (REQ_BEFORE.test(src.slice(Math.max(0, m.index - 90), m.index)) || REQ_AFTER.test(src.slice(m.index + m.length, m.index + m.length + 70)))) continue
    out.push(...ns)
  }
  return out
}
// The text with its tenure phrases blanked, so the generic "no invented figure" check does not see them twice.
function withoutTenureClaims(text) {
  return String(text || '').replace(TENURE_RE, ' ').replace(DECADE_RE, (all, ...rest) => {
    const idx = rest[rest.length - 2], src = rest[rest.length - 1]
    return DECADE_NOT_ABOUT_PERSON.test(String(src).slice(Math.max(0, idx - 12), idx)) ? all : ' '
  })
}

// A claim is honest when it does not exceed the span the dates support (or the person wrote it themselves).
function tenureClaimOk(n, facts, sourceNumbers) {
  if (sourceNumbers && sourceNumbers.has(n)) return true
  return facts && typeof facts.years === 'number' && n >= 0 && n <= facts.years
}

// ── Years of experience from PLAIN TEXT (the scorer sees text, not the structured resume) ────────────────────────
// The scorer model used to be asked whether "5+ years" was met, with no date to count "Present" against, and an
// empty quote was accepted as proof. This counts it instead: every date range in the text that is not on an
// education line, merged into a union of year intervals (overlapping jobs count once, gaps are not counted), with an
// open range ending at the current year. Year granularity only; null when the text carries no usable range.
// Which lines are EDUCATION, not work. A line used to be skipped on any education word, which also dropped real jobs: "Scrum Master",
// "Graduate Trainee", "Lecturer - University of Leeds", "Teacher - ... High School", "Degree Controls Ltd". Now: everything under an
// EDUCATION heading, plus any line with a degree word only an education entry has (BSc, MBA, diploma, "Bachelor's", GPA). With no
// section headings at all (a pasted block), a school-name line counts as education unless it also names a job title.
const EDU_HEADING = /^\s*(?:education(?:\s*(?:and|&)\s*(?:training|certifications?|qualifications))?|academic(?:\s+(?:background|qualifications|history))?|qualifications|education\s+history)\s*:?\s*$/i
const OTHER_HEADING = /^\s*(?:(?:professional\s+)?summary|profile|(?:work|professional|relevant|employment|career)\s+(?:experience|history)|experience|employment|projects?|(?:technical\s+)?skills|certifications?|licen[sc]es|volunteer(?:ing)?(?:\s+experience)?|awards?|publications?|languages?|interests|references|additional\s+information)\s*:?\s*$/i
// "Industry Experience", "Clinical Background", "Career Highlights", "Employment Record": a short line that is only a work-section noun phrase.
const WORK_HEADING = /^\s*(?:[A-Za-z&/'’-]+\s+){0,3}(?:experience|history|background|highlights|record|appointments|employment|positions|internships?|career)\s*:?\s*$/i
// SCAN/ATS ROUND 23: the common Commonwealth / UK abbreviations (BCom, BBA, LLB, MPhil, HND ...) are education lines too - a "BCom 2011 - 2015"
// line with no school word was counted as 4 years of WORK. Ordinary English words ("bed", "med", "dba") are left out on purpose.
const DEGREE_WORDS = /\b(?:bachelor(?:['’]s)?|b\.?sc|bsc|b\.?a\.?\b|m\.?sc|msc|mba|phd|ph\.d|bcom|b\.com|mcom|m\.com|bba|llb|ll\.b|llm|ll\.m|mphil|m\.phil|mfa|hnd|bpharm|b\.pharm|bsn|bca|barch|msw|edd|diploma|gpa|a-levels?|gcses?|coursework|dissertation|thesis|master['’]s|masters?\s+(?:of|degree|in)|graduated|graduation|undergraduate|postgraduate)\b/i
const SCHOOL_WORDS = /\b(?:universit(?:y|é|à)|college|school|academy|institute|degree|graduate)\b/i
// A job-title word: a line with a school word AND one of these is a post held at (or about) a school, not a place studied at.
const TITLE_WORDS = /\b(?:teacher|lecturer|professor|tutor|instructor|trainee|engineer|analyst|manager|officer|assistant|developer|coordinator|administrator|consultant|director|specialist|associate|intern|supervisor|principal|head|dean|librarian|counsell?or|nurse|clerk|technician|accountant|designer|researcher|fellow)\b/i

// Any other ALL-CAPS heading-like line also ends an education block ("PROFESSIONAL BACKGROUND", "TEACHING EXPERIENCE", "INTERNSHIPS"):
// a heading list can never be complete, and a block that never ended dropped every job under an unlisted heading. An all-caps school
// or degree line ("UNIVERSITY OF LEEDS") is an entry, not a heading.
const CAPS_HEADING = line => {
  const t = String(line || '').trim()
  return t.length >= 4 && t.length <= 48 && !/\d/.test(t) && !/[.,;:()@|]/.test(t.replace(/:\s*$/, '')) && /^[A-Z][A-Z &/'’-]+$/.test(t) && !SCHOOL_WORDS.test(t) && !DEGREE_WORDS.test(t)
}

function yearsFromText(text, now = new Date()) {
  const lines = String(text || '').split(/\r?\n/)
  const sectioned = lines.some(l => EDU_HEADING.test(l) || OTHER_HEADING.test(l) || WORK_HEADING.test(l) || CAPS_HEADING(l))
  const spans = []
  let inEdu = false
  // An all-caps line is a heading only when what follows it is a job entry (a title word and a date range): an all-caps subject, honours
  // line or school name inside an education entry ("STATISTICS", "FIRST CLASS HONOURS") is followed by its dates, not by a job.
  const nextEntryIsJob = i => {
    for (let k = i + 1; k < lines.length; k++) if (lines[k].trim()) return TITLE_WORDS.test(lines[k]) && spansIn(lines[k], now).length > 0
    return false
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (EDU_HEADING.test(line)) { inEdu = true; continue }
    if (OTHER_HEADING.test(line) || WORK_HEADING.test(line) || (CAPS_HEADING(line) && nextEntryIsJob(i))) { inEdu = false; continue }
    if (inEdu || DEGREE_WORDS.test(line) || (!sectioned && SCHOOL_WORDS.test(line) && !TITLE_WORDS.test(line))) continue
    spans.push(...spansIn(line, now))
  }
  return workedYears(spans)
}

module.exports = { careerFacts, tenureClaims, withoutTenureClaims, tenureClaimOk, yearsIn, yearsFromText }
