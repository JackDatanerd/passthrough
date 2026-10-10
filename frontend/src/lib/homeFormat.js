// "25,123 scans" -> "25,000+": a claim like this should round DOWN (never overstate) and say so with a plus.
// `atLeast` forces the plus: the editable fallback figure (homeContent.js) is a claim of "at least this many",
// not an exact count, so it always reads "25,000+".
export function formatScanCount(n, { atLeast = false } = {}) {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return `${Math.floor(n)}${atLeast ? '+' : ''}`
  const step = n >= 100000 ? 10000 : n >= 10000 ? 1000 : 100
  const floored = Math.floor(n / step) * step
  return `${floored.toLocaleString('en-US')}${atLeast || floored !== n ? '+' : ''}`
}

// The numeric part and whether a "+" follows, for the count-up animation to end exactly on the shown text.
export function splitScanCount(n, opts) {
  const text = formatScanCount(n, opts)
  if (text === null) return null
  const plus = text.endsWith('+')
  return { value: Number(text.replace(/[^\d]/g, '')), plus, text }
}

export function monthYear(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

// A stable accent per person so the same story keeps the same avatar colour on every visit.
const AVATAR_COLOURS = ['bg-blue-600', 'bg-teal-600', 'bg-purple-600', 'bg-rose-600', 'bg-amber-600', 'bg-emerald-600']
export function avatarColour(name) {
  let h = 0
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length]
}
export const initialOf = (name) => (String(name || '').trim().match(/\p{L}|\p{N}/u) || ['?'])[0].toUpperCase()

// Story body text -> paragraphs (blank-line separated; single newlines kept as part of a paragraph).
export const paragraphs = (text) => String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
