import { ATS_PASS_THRESHOLD } from './scoreThresholds'

// ── Dates ────────────────────────────────────────────────────────────────────
// Date-only strings ("2026-09-01") are parsed as LOCAL dates. `new Date("2026-09-01")`
// is UTC midnight, so in any timezone behind UTC (the whole Americas) it rendered
// as the previous day. Timestamps (with a time / offset) are unaffected.
function parseDate(input) {
  if (input instanceof Date) return input
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(input)
}

export function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = parseDate(dateStr)
  if (Number.isNaN(d.getTime())) return '—'      // was: the literal text "Invalid Date"
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// ── Money ────────────────────────────────────────────────────────────────────
// null / undefined / NaN used to render "$NaN" (or "$0.00" for null). A missing
// amount is "unknown", not zero dollars.
export function formatMoney(cents, { decimals = 2, currency = 'USD' } = {}) {
  if (cents === null || cents === undefined || cents === '' || !Number.isFinite(Number(cents))) return '—'
  const value = Number(cents) / 100
  const abs = Math.abs(value).toFixed(decimals)
  const symbol = currency === 'USD' ? '$' : ''
  const suffix = currency === 'USD' ? '' : ` ${currency}`
  return `${value < 0 ? '-' : ''}${symbol}${abs}${suffix}`
}
// Currency-aware (upstream's Admin-panel requirement): non-USD amounts render as
// "12.00 KES" rather than being mislabelled with a dollar sign.
export const formatCents = (cents, currency = 'USD') => formatMoney(cents, { currency })

// ── Scores ───────────────────────────────────────────────────────────────────
// Pass mark comes from the single shared module (mirrors backend
// ATS_PASS_THRESHOLD); only the marginal band is defined here.
export const SCORE_PASS = ATS_PASS_THRESHOLD
export const SCORE_MARGINAL = 50

export function scoreTier(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return 'unknown'
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
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return !!ok
  } catch (_) {
    return false
  }
}

// Saves a Blob as a file. The anchor is attached to the DOM (older Firefox
// ignores clicks on detached anchors) and the object URL is revoked LATER —
// revoking it synchronously after click() cancels the download in Safari and
// some Firefox versions.
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
