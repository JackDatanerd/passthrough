// Format-only canonicalisation of the date strings on a delivered resume. An ATS date parser (and the recruiter's eye) wants one
// shape - "Jan 2020 – Present" - and the data holds whatever the person typed: "January 2020 - current", "01/2020 to now",
// "2020-01 – 2022-06". Only the FORMAT changes, never a value: the same months and years come out as went in. Anything that is not
// a plain date or a plain date range (a season, "Summer 2019", a two-digit year, free text) is returned exactly as written, so
// nothing is ever guessed. Render-time only: the stored data (and every guard that compares dates) is untouched.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_NAME = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const monthIndex = s => MONTHS.findIndex(m => String(s).toLowerCase().startsWith(m.toLowerCase()))
const OPEN = /^(?:present|current|currently|now|ongoing|today|to date|till date|until now|date)$/i

// One date point -> { y, m } (m is 0-11 or null) or null when it is not a plain date.
function parsePoint(raw) {
  const s = String(raw).trim().replace(/\s+/g, ' ')
  let m
  if ((m = new RegExp(`^(${MONTH_NAME})\\.?,?\\s+((?:19|20)\\d{2})$`, 'i').exec(s))) return { y: +m[2], m: monthIndex(m[1]) }
  if ((m = /^(0?[1-9]|1[0-2])\s*[/.]\s*((?:19|20)\d{2})$/.exec(s))) return { y: +m[2], m: +m[1] - 1 }
  if ((m = /^((?:19|20)\d{2})\s*[/-]\s*(0[1-9]|1[0-2])$/.exec(s))) return { y: +m[1], m: +m[2] - 1 }
  if ((m = /^((?:19|20)\d{2})$/.exec(s))) return { y: +m[1], m: null }
  return null
}
const show = p => (p.m == null ? String(p.y) : `${MONTHS[p.m]} ${p.y}`)

// Every place the string could be cut into "start / end": a dash or a word separator. A hyphen is ambiguous ("2020-01" is one
// date, "2019-2021" is two), so each cut is tried and the first whose left side is a plain date and whose right side is a plain
// date, an open marker or a two-digit year wins.
function splits(s) {
  const out = []
  for (const m of s.matchAll(/\s*(?:–|—|-|\bto\b|\buntil\b|\btill\b)\s*/gi)) out.push([s.slice(0, m.index), s.slice(m.index + m[0].length)])
  return out
}

function canonDates(value) {
  if (typeof value !== 'string') return value
  const s = value.trim()
  if (!s) return value
  const whole = parsePoint(s)
  if (whole) return show(whole)
  for (const [l, r] of splits(s)) {
    const a = parsePoint(l)
    if (!a) continue
    const right = r.trim()
    if (OPEN.test(right)) return `${show(a)} – Present`
    // "2019-21": a two-digit end year is the same century as the start (never when it would end before it starts).
    if (/^\d{2}$/.test(right) && a.m == null) {
      const y = +(String(a.y).slice(0, 2) + right)
      if (y >= a.y) return `${a.y} – ${y}`
      continue
    }
    const b = parsePoint(right)
    if (b) return `${show(a)} – ${show(b)}`
  }
  return value
}

module.exports = { canonDates, parsePoint }
