import { ATS_PASS_THRESHOLD } from './scoreThresholds'

// ── Dates ────────────────────────────────────────────────────────────────────
// Date-only strings ("2026-09-01") are parsed as LOCAL dates. `new Date("2026-09-01")`
// is UTC midnight, so in any timezone behind UTC (the whole Americas) it rendered
// as the previous day. Timestamps (with a time / offset) are unaffected.
// The Date constructor accepts almost any string: new Date('0') is the year 2000 and new Date('12') is December 2001, so a stray
// "0" or "12" from a bad field printed a confident, wrong date where "—" is promised. A real date string always carries a four-digit year.
function looksLikeDate(input) {
  return typeof input !== 'string' || /\d{4}/.test(input)
}

function parseDate(input, utc = false) {
  if (input instanceof Date) return input
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input))
  if (!m) return looksLikeDate(input) ? new Date(input) : new Date(NaN)
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const date = utc ? new Date(Date.UTC(y, mo, d)) : new Date(y, mo, d)
  // SHARED FRONTEND (section 11, round 19, bug): the Date constructor rolls an impossible calendar day over instead of
  // refusing it — "2026-02-30" printed "Mar 2, 2026" and "2026-13-01" printed "Jan 1, 2027", a confident wrong date where
  // formatDate promises "—". A date-only value must read back as the same year, month and day it was built from.
  const same = utc
    ? date.getUTCFullYear() === y && date.getUTCMonth() === mo && date.getUTCDate() === d
    : date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d
  return same ? date : new Date(NaN)
}

// `{ utc: true }` for a value that stands for a CALENDAR DAY stored as a UTC instant, not for a moment: a partner code's "expires on"
// date is saved as `YYYY-MM-DDT23:59:59.999Z`. Shown in the viewer's own zone that read as the NEXT day anywhere east of UTC
// ("Dec 31" typed, "Jan 1" listed, in Nairobi), while the date field that edits it (which slices the UTC string) said Dec 31.
// A true moment (a created-at, a paid-at) keeps the default: the viewer's local day.
export function formatDate(dateStr, opts) {
  if (!dateStr) return '—'
  const utc = !!(opts && opts.utc)
  const d = parseDate(dateStr, utc)
  if (Number.isNaN(d.getTime())) return '—'      // was: the literal text "Invalid Date"
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', ...(utc ? { timeZone: 'UTC' } : {}) })
}

// Round 20: partner payout cycles, the earnings trend and the CSV exports are all UTC, but a bare formatDate renders in the viewer's own
// timezone — so for a partner east of UTC (Nairobi, UTC+3) a sale at 22:00 UTC on the 15th was listed as the 16th while being counted in
// the 1st-15th cycle. Used wherever a partner sees a moment that belongs to a cycle.
export function formatDateUtc(dateStr) { return formatDate(dateStr, { utc: true }) }

// Today's date as YYYY-MM-DD in the VIEWER's zone, for file names. `new Date().toISOString().slice(0, 10)` is the UTC day, so a file
// exported at 02:00 in Nairobi (or at 8 pm in New York) was named for the wrong day.
export function dateStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Auth section, feature-gap-closing pass: formatDate() above drops the time
// of day, which is the one piece that actually matters for "does that match
// what you did?" (Settings.jsx's previous-sign-in display). Always a real
// timestamp (never a date-only string), so no parseDate() local-midnight
// handling is needed here.
export function formatDateTime(dateStr) {
  if (!dateStr) return '—'
  // A date-only value carries no time of day; showing it as "12:00 AM" would invent one.
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return formatDate(dateStr.trim())
  if (!looksLikeDate(dateStr)) return '—'
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

// ── Money ────────────────────────────────────────────────────────────────────
// null / undefined / NaN used to render "$NaN" (or "$0.00" for null). A missing
// amount is "unknown", not zero dollars.
export function formatMoney(cents, { decimals = 2, currency = 'USD' } = {}) {
  if (cents === null || cents === undefined || typeof cents === 'boolean' || (typeof cents === 'string' && cents.trim() === '') || !Number.isFinite(Number(cents))) return '—'
  const value = Number(cents) / 100
  // A currency code is compared in upper case: a lower-case 'usd' (Stripe-style) used to lose its "$" and read "12.34 usd".
  currency = String(currency || 'USD').trim().toUpperCase() || 'USD'
  // Grouped ("12,345.67"): bare "12345.67" is hard to read on admin revenue and
  // partner payout totals. Fixed 'en-US' so the separators match the rest of
  // the UI's en-US dates regardless of the browser's locale.
  const abs = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const symbol = currency === 'USD' ? '$' : ''
  const suffix = currency === 'USD' ? '' : ` ${currency}`
  // A negative amount that rounds to zero at this precision ("-$0.00") is just zero.
  const negative = value < 0 && /[1-9]/.test(abs)
  return `${negative ? '-' : ''}${symbol}${abs}${suffix}`
}
// Currency-aware (upstream's Admin-panel requirement): non-USD amounts render as
// "12.00 KES" rather than being mislabelled with a dollar sign.
export const formatCents = (cents, currency = 'USD') => formatMoney(cents, { currency })

// A USD amount already in DOLLARS (a cost estimate kept as a float, not cents): grouped like formatMoney, and a missing / non-numeric
// value is "unknown" ('—'), never "$NaN". `decimals` for amounts that are fractions of a cent per call.
export function formatUsd(dollars, { decimals = 2 } = {}) {
  if (dollars === null || dollars === undefined || typeof dollars === 'boolean' || (typeof dollars === 'string' && dollars.trim() === '') || !Number.isFinite(Number(dollars))) return '—'
  const value = Number(dollars)
  const abs = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return `${value < 0 && /[1-9]/.test(abs) ? '-' : ''}$${abs}`
}

// ── Scores ───────────────────────────────────────────────────────────────────
// Pass mark comes from the single shared module (mirrors backend
// ATS_PASS_THRESHOLD); only the marginal band is defined here.
export const SCORE_PASS = ATS_PASS_THRESHOLD
export const SCORE_MARGINAL = 50

export function scoreTier(score) {
  if (score === null || score === undefined || typeof score === 'boolean' || (typeof score === 'string' && score.trim() === '') || Number.isNaN(Number(score))) return 'unknown'
  const n = Number(score)
  if (n >= SCORE_PASS) return 'pass'
  if (n >= SCORE_MARGINAL) return 'marginal'
  return 'fail'
}

// A missing score is "unknown" (gray) — it used to fall through to the FAIL colour.
export function scoreColor(score) {
  return { pass: 'text-green-600', marginal: 'text-amber-500', fail: 'text-red-600', unknown: 'text-gray-400' }[scoreTier(score)]
}

export function scoreBg(score) {
  return {
    pass: 'bg-green-50 border-green-200', marginal: 'bg-amber-50 border-amber-200',
    fail: 'bg-red-50 border-red-200', unknown: 'bg-gray-50 border-gray-200',
  }[scoreTier(score)]
}

export function statusLabel(status) {
  const map = {
    PENDING:         'Pending',
    SCANNING:        'Scanning…',
    COMPLETE_PASS:   'Passed',
    COMPLETE_FAIL:   'Failed',
    FIX_PURCHASED:   'Fix purchased',
    FIX_GENERATING:  'Generating…',
    FIX_DELIVERED:   'Delivered',
    ERROR:           'Error'
  }
  return map[status] || status
}

// Joins class names. NOTE: this does not resolve Tailwind conflicts — passing
// `px-6` to a component that already sets `px-4` leaves BOTH classes, and which
// wins depends on stylesheet order, not argument order. Don't rely on
// `className` to override a component's own spacing/colour utilities.
export function cn(...classes) {
  return classes.filter(Boolean).join(' ')
}

// ── Browser helpers ──────────────────────────────────────────────────────────
// Clipboard writes fail in insecure contexts, without permission, and in some
// embedded webviews. Callers previously fired `navigator.clipboard.writeText()`
// with no catch and showed "Link copied." regardless. Returns whether it worked.
export async function copyToClipboard(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (_) { /* fall through to the legacy path */ }
  let ta = null
  try {
    // The fallback focuses a scratch textarea; hand focus back afterwards so a keyboard user isn't dropped on <body>.
    const prev = document.activeElement
    ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    ta.select()
    try { ta.setSelectionRange(0, text.length) } catch (_) { /* iOS Safari ignores select() alone */ }
    const ok = document.execCommand('copy')
    if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus({ preventScroll: true })
    return !!ok
  } catch (_) {
    return false
  } finally {
    // Removed even when select()/execCommand threw — the scratch box used to be left in the page.
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta)
  }
}

// Saves a Blob as a file. The anchor is attached to the DOM (older Firefox
// ignores clicks on detached anchors) and the object URL is revoked LATER —
// revoking it synchronously after click() cancels the download in Safari and
// some Firefox versions.
// The filename the server chose in Content-Disposition (it is exposed through CORS), or `fallback`.
// Only a plain, path-free name is accepted; a header that is missing, malformed or tries a path
// falls back rather than naming a download something odd.
export function filenameFromDisposition(headers, fallback) {
  try {
    const raw = typeof headers?.get === 'function' ? headers.get('content-disposition') : (headers?.['content-disposition'] ?? headers?.['Content-Disposition'])
    if (!raw) return fallback
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(raw)
    const plain = /filename\s*=\s*"([^"]+)"/i.exec(raw) || /filename\s*=\s*([^;\s]+)/i.exec(raw)
    // A malformed filename* (bad %-escape) must not throw away a perfectly good plain filename beside it.
    let name = ''
    if (star) { try { name = decodeURIComponent(star[1].trim()) } catch (_) { name = '' } }
    if (!name && plain) name = plain[1].trim()
    return name && !/[\\/]/.test(name) && name.length <= 120 ? name : fallback
  } catch (_) { return fallback }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url) }, 1500)
}

// Saves the body of an axios `responseType: 'blob'` response under the name the server chose (Content-Disposition), or
// `fallbackName`. Three pages used to hand-roll this: one revoked the object URL immediately after click() — which
// cancels the download in Safari and some Firefox versions — and none used the server's filename.
export function saveBlobResponse(res, fallbackName) {
  downloadBlob(res.data, filenameFromDisposition(res.headers, fallbackName))
}

// Whole/decimal numbers with thousands separators, always en-US like formatDate/formatMoney — a bare
// `.toLocaleString()` follows the browser's locale ("12.000" in de-DE) and made one screen mix styles.
export function formatNumber(n, decimals = 0) {
  const v = Number(n)
  if (n == null || typeof n === 'boolean' || (typeof n === 'string' && n.trim() === '') || !Number.isFinite(v)) return '—'
  // -0 (and a tiny negative that rounds to nothing) is just zero; it used to print "-0".
  const out = v.toLocaleString('en-US', { maximumFractionDigits: decimals })
  return /^-0(\.0*)?$/.test(out) ? out.slice(1) : out
}

// Commission rates are stored as fractions (0.125 = 12.5%). Show up to 2
// decimals, no trailing zeros — never round a fractional rate to a whole %.
export function formatRate(rate) {
  if (rate === null || rate === undefined || typeof rate === 'boolean' || (typeof rate === 'string' && rate.trim() === '')) return '—'
  const n = Number(rate)
  if (!Number.isFinite(n)) return '—'
  return `${+(n * 100).toFixed(2)}%`
}

// ── Time windows ─────────────────────────────────────────────────────────────
// True when `iso` is a valid timestamp less than `hours` ago (used for the post-payout-details-change hold).
// A timestamp AHEAD of this device's clock still counts when it is only a little ahead (the server's clock runs fast, or the
// device's slow); one further out than CLOCK_SKEW_HOURS is not a moment that has happened yet, so it is not "within" anything —
// it used to count as inside the window for as long as it stayed in the future.
const CLOCK_SKEW_HOURS = 1
export function withinHours(iso, hours) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return false
  const age = Date.now() - ms
  return age < hours * 3600000 && age > -CLOCK_SKEW_HOURS * 3600000
}

// ── CSV export ───────────────────────────────────────────────────────────────
// A cell that starts with = + - @ (or a tab/CR) is executed as a formula by
// Excel/Sheets, and partner names/codes are not trusted text — so text cells get a
// leading apostrophe. Real numbers (amounts, which may legitimately be negative)
// are written as-is.
// Round 6 (bug): that apostrophe is right for free text but wrong for the ACCOUNT / PHONE column of the payout run.
// A mobile-money number is always entered with its `+` country code, so `+254 712 345 678` was written as
// `'+254 712 345 678` (a literal apostrophe in a file whose whole purpose is paying people), and a bank account with
// a leading zero still lost the zero in Excel. csvText() marks a value that must reach the spreadsheet as TEXT: when it
// is made only of letters, digits and `+ ( ) - space` (so it can hold no quote, comma or operator that could form a
// formula) and starts like a number, it is written as ="value", which Excel and Sheets show verbatim. Anything else
// falls back to the normal rules.
// Excel refuses a string literal inside a formula past 255 characters (the cell shows #VALUE!), so a longer value takes the ordinary
// text rules instead of the ="value" form. Phone and account numbers are nowhere near the limit.
const CSV_TEXT_FORMULA_MAX = 250
export function csvText(v) { return { __csvText: v == null ? '' : String(v) } }

export function csvCell(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object' && typeof v.__csvText === 'string') {
    const raw = v.__csvText
    if (raw === '') return ''
    if (raw.length <= CSV_TEXT_FORMULA_MAX && /^[0-9A-Za-z+() -]+$/.test(raw) && /^[0-9+()-]/.test(raw)) return '"=""' + raw + '"""'
    return csvCell(raw)
  }
  // A Date used to become String(date) — "Thu Jan 01 1970 03:00:00 GMT+0300 (East Africa Time)", in the exporter's own zone.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  let s = String(v)
  // Leading line breaks are skipped over when looking for the formula character: a cell that opens with a newline and then "=" is
  // still read as a formula by some spreadsheet importers.
  if (typeof v !== 'number' && /^[\t\r\n]*[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n')
}
export function downloadCsv(filename, rows) {
  downloadBlob(new Blob([`\uFEFF${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' }), filename)
}
