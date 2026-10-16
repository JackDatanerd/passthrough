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

// -> { years, firstYear, lastYear, ongoing, roleYears } ; years is null when the jobs carry no usable dates.
function careerFacts(resumeData, now = new Date()) {
  const thisYear = now.getUTCFullYear()
  const jobs = Array.isArray(resumeData?.experience) ? resumeData.experience : []
  let first = null, last = null, ongoing = false
  const roleYears = []
  for (const job of jobs) {
    const ys = yearsIn(job?.dates).filter(y => y <= thisYear)
    const open = isOngoing(job?.dates)
    if (open) ongoing = true
    if (!ys.length) continue
    const start = Math.min(...ys)
    const end = open ? thisYear : Math.max(...ys)
    if (first === null || start < first) first = start
    if (last === null || end > last) last = end
    if (end >= start) roleYears.push(end - start)
  }
  if (first === null) return { years: null, firstYear: null, lastYear: null, ongoing, roleYears }
  return { years: Math.max(0, last - first), firstYear: first, lastYear: last, ongoing, roleYears }
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30 }
// "8+ years", "eight years", "10 or more years", "5-7 years" -> [8], [8], [10], [5, 7]. Role-length claims
// ("3 years at Acme") are caught too: they are only ever checked against the career span, which is generous.
const TENURE_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty)\s*(?:\+|-plus|\s+plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*\+?\s*)?(?:or\s+more\s+)?-?\s*years?\b/gi
function tenureClaims(text) {
  const out = []
  for (const m of String(text || '').matchAll(TENURE_RE)) {
    for (const g of [m[1], m[2]]) {
      if (!g) continue
      const n = /^\d/.test(g) ? parseInt(g, 10) : WORD_NUM[g.toLowerCase()]
      if (Number.isFinite(n)) out.push(n)
    }
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
