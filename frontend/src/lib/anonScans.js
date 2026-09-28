// AUDIT FIX (feature gap): localStorage held exactly one anon scan token
// under 'passthrough_anon_token' — an anonymous visitor who scanned more
// than once before registering (anonScan's rate limit allows 1/hour, so a
// full day gives up to ~24) could only ever claim the LAST one on signup;
// every earlier one just aged out at its 24h TTL, unclaimed. Storing an
// array of {scanId, token} pairs instead means postRegisterActions
// (AuthContext.jsx) can claim all of them, AND ScanResult.jsx can look up
// the right token for whichever scan the user is currently viewing (not
// just "whatever the last one was", which broke as soon as there was more
// than one pending anon scan in the same browser). Capped well above
// anything a real single-day session would produce, purely so this can't
// grow unbounded if something calls add() repeatedly without registering.
const KEY = 'passthrough_anon_tokens'
const MAX_TRACKED = 30

// BUG FIX (Scan/ATS pass): addAnonScanToken called localStorage.setItem
// unguarded. Where storage is unavailable or full (Safari private mode
// historically, a quota-exhausted profile, storage disabled by policy) it
// threw AFTER the scan had already been created server-side — ScanForm
// showed a generic error and never navigated, the raw token (returned once,
// never stored anywhere else) was lost, and the 1-scan-per-hour anonymous
// limit then blocked a retry. The token is now also kept in memory for the
// life of the page, so the person is taken to their result and can view/edit
// it in this tab even when persistence fails.
const memoryTokens = new Map()

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw)
      ? raw.filter(e => e && typeof e.token === 'string' && typeof e.scanId === 'string')
      : []
  } catch (_) {
    return []
  }
}

export function addAnonScanToken(scanId, token) {
  if (!scanId || !token) return
  memoryTokens.set(scanId, token)
  try {
    const tokens = readAll().filter(e => e.scanId !== scanId)
    tokens.push({ scanId, token })
    if (tokens.length > MAX_TRACKED) tokens.splice(0, tokens.length - MAX_TRACKED)
    localStorage.setItem(KEY, JSON.stringify(tokens))
  } catch (_) { /* storage unavailable/full — the in-memory copy above still works for this page */ }
}

export function getAnonScanTokens() {
  const stored = readAll()
  const seen = new Set(stored.map(e => e.scanId))
  return [...stored, ...[...memoryTokens].filter(([scanId]) => !seen.has(scanId)).map(([scanId, token]) => ({ scanId, token }))]
}

export function getAnonScanToken(scanId) {
  return readAll().find(e => e.scanId === scanId)?.token || memoryTokens.get(scanId) || null
}

export function clearAnonScanTokens() {
  memoryTokens.clear()
  try { localStorage.removeItem(KEY) } catch (_) {}
}

// Drops just one entry. Used by the claim loop so that a claim that failed for
// a TRANSIENT reason (network blip, 5xx) keeps its token for a later attempt
// instead of being wiped along with the ones that were actually consumed.
export function removeAnonScanToken(scanId) {
  memoryTokens.delete(scanId)
  try {
    const remaining = readAll().filter(e => e.scanId !== scanId)
    if (remaining.length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(remaining))
  } catch (_) {}
}
