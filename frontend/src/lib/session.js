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

// `?next=` must be a same-site relative path; anything else (absolute URLs,
// protocol-relative "//evil.com", backslash tricks) would be an open redirect.
export function safeNext(next) {
  if (typeof next !== 'string') return null
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null
  if (/^\/login(\/|\?|$)/.test(next)) return null   // never bounce back into the login page
  if (/[\r\n]/.test(next)) return null
  return next
}
