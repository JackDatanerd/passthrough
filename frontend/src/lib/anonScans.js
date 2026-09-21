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
  const tokens = readAll().filter(e => e.scanId !== scanId)
  tokens.push({ scanId, token })
  if (tokens.length > MAX_TRACKED) tokens.splice(0, tokens.length - MAX_TRACKED)
  localStorage.setItem(KEY, JSON.stringify(tokens))
}

export function getAnonScanTokens() {
  return readAll()
}

export function getAnonScanToken(scanId) {
  return readAll().find(e => e.scanId === scanId)?.token || null
}

export function clearAnonScanTokens() {
  localStorage.removeItem(KEY)
}
