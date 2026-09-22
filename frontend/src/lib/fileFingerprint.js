// SECTION 7 AUDIT (feature gap G7-1): the server-side integrity check can only
// ever compare our own R2 copy against a hash we wrote ourselves — it can
// never see a candidate's edited copy of the file they were actually sent.
// This is the other half: hash the file a hiring manager actually has, in
// their browser, and compare it against the fingerprints the API returned.
// Nothing is uploaded anywhere — the file never leaves the browser.
export async function sha256Hex(file) {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// data: the `data` object returned by GET /api/verify/:code (needs
// `fingerprints: { docx, pdf, previous }`).
// Returns one of:
//   'current'  — matches the current docx or pdf hash exactly
//   'previous' — matches an earlier, superseded version (a stale copy, not tampering)
//   'mismatch' — matches nothing on file — either edited, or not from Passthrough
//   'unavailable' — no fingerprints to check against (feature disabled for this scan)
export function classifyFingerprint(hash, fingerprints) {
  if (!fingerprints || (!fingerprints.docx && !fingerprints.pdf)) return 'unavailable'
  if (hash === fingerprints.docx || hash === fingerprints.pdf) return 'current'
  if ((fingerprints.previous || []).some(p => p.hash === hash)) return 'previous'
  return 'mismatch'
}
