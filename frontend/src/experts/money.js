// A11: reading a dollar amount typed into a money form. Strict on purpose: the old read (parseFloat) turned "10,50" into $10.00, "1,000" into $1,
// "12abc" into $12 and "1e3" into $1,000 and sent it. Digits, an optional dot with one or two decimals, an optional leading $; nothing else.
// Whole cents are computed from the digits (no floating point), so "0.29" is 29 and "1.1" is 110.
export function parseDollars(text) {
  const m = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(String(text == null ? '' : text))
  if (!m) return null
  const cents = Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0)
  return cents > 0 ? cents : null
}
export const formatDollars = cents => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`
