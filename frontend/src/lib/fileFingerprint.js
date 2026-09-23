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
// `fingerprints: { docx, pdf, previous }`, where each `previous` entry is
// `{ kind: 'docx'|'pdf', hash, at }` — `at` is when THAT version was current).
//
// Returns { status, at, kind }:
//   status: 'current'     — matches the current docx or pdf hash exactly
//           'previous'    — matches an earlier, superseded version (a stale copy, not tampering)
//           'mismatch'    — matches nothing on file — either edited, or not from Passthrough
//           'unavailable' — no fingerprints to check against (feature disabled for this scan)
//   at:   for 'previous' only — the timestamp that version was superseded (null if not recorded)
//   kind: for 'previous' only — which file type matched ('docx' | 'pdf')
//
// FEATURE GAP CLOSED: this used to collapse a 'previous' match down to the
// bare status string, discarding the matched entry's `at`/`kind` — the
// backend carries `at` through resume_hash_history specifically so a reader
// can be told WHEN the file they have was superseded, not just that it was.
export function classifyFingerprint(hash, fingerprints) {
  if (!fingerprints || (!fingerprints.docx && !fingerprints.pdf)) return { status: 'unavailable', at: null, kind: null }
  if (hash === fingerprints.docx || hash === fingerprints.pdf) return { status: 'current', at: null, kind: null }
  const match = (fingerprints.previous || []).find(p => p.hash === hash)
  if (match) return { status: 'previous', at: match.at || null, kind: match.kind || null }
  return { status: 'mismatch', at: null, kind: null }
}
