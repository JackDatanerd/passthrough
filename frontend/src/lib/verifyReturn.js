// A buyer stopped at "verify your email first" leaves for their inbox. The verification link opens a new tab with no memory of the
// scan they were buying, so the page that confirms the address used to offer only the dashboard. This remembers the scan page they
// came from, for as long as the verification link itself can work, so the confirmation can bring them back to it.
const KEY = 'passthrough_verify_return'
const TTL_MS = 48 * 3600 * 1000
const SCAN = /^\/scan\/[0-9a-zA-Z-]{8,}(?:\/(?:why|resume|apply|score))?\/?$/

export function rememberVerifyReturn(pathname) {
  if (!SCAN.test(String(pathname || ''))) return
  try { window.localStorage.setItem(KEY, JSON.stringify({ path: pathname, at: Date.now() })) } catch (_) { /* storage blocked */ }
}
export function peekVerifyReturn() {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) || 'null')
    if (v && SCAN.test(v.path) && Date.now() - v.at < TTL_MS) return v.path
  } catch (_) { /* ignore */ }
  return null
}
export function clearVerifyReturn() { try { window.localStorage.removeItem(KEY) } catch (_) { /* ignore */ } }
