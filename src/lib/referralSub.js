// Section 4 round 16 (feature gap): a partner can tag a share link with a short channel label —
// `?ref=CODE&sub=newsletter` — and see which channel earned the sale. The label is chosen by the partner (a
// campaign / placement name, not personal data), so it is kept deliberately small: lower-case letters, digits,
// `_` and `-`, 1–32 characters. Anything else is DROPPED, never an error — a malformed tag must not break a checkout.
// The same rule is mirrored by the CHECK constraints of migration 0093 and by useReferralCapture on the SPA.
const SUB_ID_MAX = 32
const SUB_ID_RE = /^[a-z0-9_-]{1,32}$/

function normalizeSub(value) {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return SUB_ID_RE.test(v) ? v : null
}

module.exports = { SUB_ID_MAX, SUB_ID_RE, normalizeSub }
