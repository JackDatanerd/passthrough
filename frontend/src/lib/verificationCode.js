// ROUND-5 AUDIT (feature gap, Section 7): turn whatever a reader pasted — a full verification link,
// a link with tracking junk on it, or just the code copied off a printed resume — into the code, or
// null when it cannot be one. The alphabet and lengths mirror the Worker (config/constants.js:
// SHORT_CODE_CHARS, SHORT_CODE_LENGTH 6 for pages issued long ago, VERIFY_CODE_LENGTH 10 now), so a
// typo is caught here instead of costing a lookup (a miss counts against the reader's own budget).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_RE = new RegExp(`^(?:[${CODE_CHARS}]{6}|[${CODE_CHARS}]{10})$`)

export function extractVerificationCode(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  // A link: take the segment after /v/ (any host — staging, a custom domain, a pasted markdown link).
  const fromLink = /\/v\/([^/?#\s)]+)/i.exec(raw)
  let candidate = fromLink ? fromLink[1] : raw
  try { candidate = decodeURIComponent(candidate) } catch (_) { /* keep as typed */ }
  // Printed codes get spaces or hyphens added for legibility.
  candidate = candidate.replace(/[\s-]+/g, '').toUpperCase()
  return CODE_RE.test(candidate) ? candidate : null
}
