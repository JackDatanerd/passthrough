// Session-expiry policy, kept out of api.js so it can be unit-tested.
//
// The old interceptor logged the user out and hard-redirected on EVERY 401.
// But this backend returns 401 for things that are not an expired session:
//   - POST /auth/login with a wrong password  ("Invalid credentials", 401)
//   - any request that simply carried no token ("Authentication required")
// So a wrong password reloaded the page to /login?expired=true, wiping the
// typed input and showing "Your session expired" instead of the real error.
// And because AuthProvider calls /auth/me on every app load, a merely STALE
// token bounced visitors off public pages (home, /v/:code, /verify-email,
// /reset-password) and swallowed the first click on an emailed link.

export const TOKEN_KEY = 'passthrough_token'
export const USER_KEY = 'passthrough_user'
export const SESSION_ENDED_EVENT = 'passthrough:session-ended'

const SESSION_CODES = new Set(['SESSION_INVALID', 'TOKEN_EXPIRED', 'USER_NOT_FOUND'])
// Endpoints where a 401/403 is about the credentials just submitted, never about a stored session.
const CREDENTIAL_PATHS = ['/auth/login', '/auth/register', '/auth/forgot-password', '/auth/reset-password']

export function isCredentialEndpoint(url) {
  const path = String(url || '').split('?')[0]
  return CREDENTIAL_PATHS.some(p => path.endsWith(p))
}

// -> 'banned' | 'expired' | null
export function classifyAuthFailure({ status, code, hadToken, url }) {
  if (isCredentialEndpoint(url)) return null
  if (!hadToken) return null               // nothing was presented, so nothing can have "expired"
  if (code === 'BANNED') return 'banned'
  if (status === 401 || SESSION_CODES.has(code)) return 'expired'
  return null
}

// Pages that require a session — only these get a forced redirect to /login.
export function isProtectedPath(pathname) {
  return /^\/(dashboard|admin)(\/|$)/.test(pathname || '')
}

// Where a tab should go when ANOTHER tab signed the browser out (the shared token was removed
// from localStorage). Only pages that require a session move; public pages just carry on
// logged-out. Without this the tab stayed on /dashboard with no token: every call answered
// 401 "Authentication required", which classifyAuthFailure rightly ignores (nothing was
// presented, so nothing "expired") — so nothing ever sent the person to the sign-in page.
export function signedOutElsewhereTarget(pathname, search) {
  if (!isProtectedPath(pathname)) return null
  return `/login?next=${encodeURIComponent(`${pathname}${search || ''}`)}`
}

// `?next=` must be a same-site relative path; anything else (absolute URLs,
// protocol-relative "//evil.com", backslash tricks) would be an open redirect.
export function safeNext(next) {
  if (typeof next !== 'string') return null
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null
  if (/^\/login(\/|\?|$)/.test(next)) return null   // never bounce back into the login page
  // AUDIT FIX (Auth section round 1, bug B1): only \r and \n were blocked, but
  // a tab (and other control/whitespace characters) survives here and is then
  // stripped by the URL parser that later resolves this value — so
  // "/\t/evil.com" passed this check but resolved to "https://evil.com/".
  // Blocking every ASCII control character and space closes the same class of
  // gap for any other whitespace a parser might trim, not just tab.
  if (/[\x00-\x20\x7f]/.test(next)) return null
  return next
}

// The `sid` claim of a JWT (the server-side session it is bound to), or null for
// anything that isn't a decodable token. Read-only: the signature is NOT checked
// here — the server does that; this only tells two tokens' sessions apart.
export function tokenSessionId(token) {
  try {
    const part = String(token || '').split('.')[1]
    if (!part) return null
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = typeof atob === 'function'
      ? atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))
      : Buffer.from(b64, 'base64').toString('utf8')
    const sid = JSON.parse(json)?.sid
    return typeof sid === 'string' && sid ? sid : null
  } catch (_) {
    return null
  }
}

// Should a session-ending response (401 expired / 403 banned) still end the
// session the browser holds NOW? A request fires with token A; by the time it
// fails the person may have signed out and in as someone else (any tab shares
// localStorage). That late failure describes A's session, so acting on it would
// wipe the new, perfectly good one. Same session = same token, or two tokens
// bound to the same `sid` (a sliding renewal swaps the token, not the session).
export function failureAppliesToCurrentSession(usedToken, currentToken) {
  return failureScope(usedToken, currentToken) !== 'stale'
}

// AUDIT FIX (Auth round 4, B3): how a session-ending failure relates to the session held NOW.
//   'current' — the very token held now was refused: it describes this session.
//   'probe'   — an OLDER token of the same session (`sid`) was refused while a newer one is held. That is
//               either a late straggler from before a token swap (sign-out-other-sessions bumps the
//               account's token_version but keeps this session and hands back a fresh token, so a request
//               still in flight under the old one answers SESSION_INVALID) or a genuinely revoked
//               session. The response cannot tell the two apart; the CURRENT token can — ask the server.
//   'stale'   — nothing held now, or a different session: says nothing about the current one.
export function failureScope(usedToken, currentToken) {
  if (!usedToken || !currentToken) return 'stale'
  if (usedToken === currentToken) return 'current'
  const used = tokenSessionId(usedToken)
  return used !== null && used === tokenSessionId(currentToken) ? 'probe' : 'stale'
}
