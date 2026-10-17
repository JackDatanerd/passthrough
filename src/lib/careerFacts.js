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
  const periods = []
  for (const job of jobs) {
    const ys = yearsIn(job?.dates).filter(y => y <= thisYear)
    const open = isOngoing(job?.dates)
    if (open) ongoing = true
    if (!ys.length) continue
    const start = Math.min(...ys)
    const end = open ? thisYear : Math.max(...ys)
    if (first === null || start < first) first = start
    if (last === null || end > last) last = end
    if (end >= start) { roleYears.push(end - start); periods.push([start, end]) }
  }
  if (first === null) return { years: null, firstYear: null, lastYear: null, ongoing, roleYears, span: null }
  periods.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let worked = 0, curStart = null, curEnd = null
  for (const [a, b] of periods) {
    if (curEnd === null || a > curEnd) { if (curEnd !== null) worked += curEnd - curStart; curStart = a; curEnd = b }
    else if (b > curEnd) curEnd = b
  }
  if (curEnd !== null) worked += curEnd - curStart
  return { years: Math.max(0, worked), firstYear: first, lastYear: last, ongoing, roleYears, span: Math.max(0, last - first) }
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
function tenureClaims(text, { posting = null } = {}) {
  const src = String(text || '')
  const out = []
  for (const m of src.matchAll(TENURE_RE)) {
    const ns = []
    for (const g of [m[1], m[2]]) {
      if (!g) continue
      const n = /^\d/.test(g) ? parseInt(g, 10) : WORD_NUM[g.toLowerCase()]
      if (Number.isFinite(n)) ns.push(n)
    }
    if (posting && ns.length && ns.every(n => posting.has(n))
        && (REQ_BEFORE.test(src.slice(Math.max(0, m.index - 90), m.index)) || REQ_AFTER.test(src.slice(m.index + m[0].length, m.index + m[0].length + 70)))) continue
    out.push(...ns)
  }
  return out
}
// The text with its tenure phrases blanked, so the generic "no invented figure" check does not see them twice.
function withoutTenureClaims(text) {
  return String(text || '').replace(TENURE_RE, ' ')
}

// A claim is honest when it does not exceed the span the dates support (or the person wrote it themselves).
function tenureClaimOk(n, facts, sourceNumbers) {
  if (sourceNumbers && sourceNumbers.has(n)) return true
  return facts && typeof facts.years === 'number' && n >= 0 && n <= facts.years
}

module.exports = { careerFacts, tenureClaims, withoutTenureClaims, tenureClaimOk, yearsIn }
