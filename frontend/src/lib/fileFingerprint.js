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
//
// ROUND-2 AUDIT FIX (bug): `kind` (optional — 'docx' | 'pdf', what the reader's
// file actually is) stops a false "edited" verdict. Scans delivered before the
// PDF was fingerprinted have a docx hash but NO pdf hash, so a genuine PDF
// matched nothing and read "doesn't match anything on file — this file has been
// edited". When we hold no fingerprint at all for that TYPE of file, the honest
// answer is 'unavailable' (scope: 'type'), not 'mismatch'.
export function classifyFingerprint(hash, fingerprints, kind = null) {
  if (!fingerprints || (!fingerprints.docx && !fingerprints.pdf)) return { status: 'unavailable', at: null, kind: null }
  if (hash === fingerprints.docx || hash === fingerprints.pdf) return { status: 'current', at: null, kind: null }
  const match = (fingerprints.previous || []).find(p => p.hash === hash)
  if (match) return { status: 'previous', at: match.at || null, kind: match.kind || null }
  if (kind === 'pdf'  && !fingerprints.pdf  && !(fingerprints.previous || []).some(p => p.kind === 'pdf'))
    return { status: 'unavailable', at: null, kind: null, scope: 'type' }
  if (kind === 'docx' && !fingerprints.docx && !(fingerprints.previous || []).some(p => p.kind === 'docx'))
    return { status: 'unavailable', at: null, kind: null, scope: 'type' }
  return { status: 'mismatch', at: null, kind: null }
}

// Which fingerprint a reader's file should be compared as. Name first (a .pdf
// dragged from an email has a reliable extension), MIME type as the fallback.
export function fileKindOf(file) {
  const name = String((file && file.name) || '').toLowerCase()
  const type = String((file && file.type) || '').toLowerCase()
  if (name.endsWith('.pdf') || type === 'application/pdf') return 'pdf'
  if (name.endsWith('.docx') || type.includes('wordprocessingml')) return 'docx'
  return null
}

// Hashing reads the whole file into memory in the reader's browser; a resume is
// a few hundred KB, so anything huge is not one and would only freeze the tab.
export const MAX_CHECK_BYTES = 25 * 1024 * 1024

// ROUND-9 (feature gap, Section 7): the page tells a reader who won't put a file into a browser to run
// `shasum -a 256` or `certutil -hashfile` and compare by eye — 64 hex characters, and no way to notice that the
// file matches an EARLIER version. Pasting the result into the page runs it through classifyFingerprint like
// a file. Accepts what those tools actually print: a bare hash, `<hash>  filename`, `SHA256:<hash>`, a whole
// certutil block ("SHA256 hash of …:\n<hash>\nCertUtil: …"), and the older certutil form with spaces
// between the byte pairs. Returns the lowercase hash, or null when no single SHA-256 can be found.
export function extractSha256(text) {
  const raw = String(text || '')
  const bare = raw.match(/(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/gi)
  if (bare) {
    const uniq = [...new Set(bare.map(h => h.toLowerCase()))]
    return uniq.length === 1 ? uniq[0] : null     // two different hashes pasted: do not guess which one
  }
  const spaced = raw.match(/(?<![a-f0-9])(?:[a-f0-9]{2}[ :]){31}[a-f0-9]{2}(?![a-f0-9])/gi)
  if (spaced) {
    const uniq = [...new Set(spaced.map(h => h.replace(/[ :]/g, '').toLowerCase()))]
    return uniq.length === 1 ? uniq[0] : null
  }
  return null
}

// How many files one selection checks (each is read into memory to be hashed).
export const MAX_CHECK_FILES = 6
