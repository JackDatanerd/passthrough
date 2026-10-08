import { describe, it, expect } from 'vitest'
import { classifyAuthFailure, isCredentialEndpoint, isProtectedPath, safeNext, tokenSessionId, failureAppliesToCurrentSession, failureScope, signedOutElsewhereTarget } from '../src/lib/session.js'

describe('classifyAuthFailure', () => {
  // REGRESSION: a wrong password (401 "Invalid credentials") used to be treated as
  // an expired session -> forced reload to /login?expired=true, real error never shown.
  it('a failed LOGIN is never a session expiry, even with a stale token attached', () => {
    expect(classifyAuthFailure({ status: 401, hadToken: true, url: '/auth/login' })).toBeNull()
    expect(classifyAuthFailure({ status: 401, hadToken: false, url: '/auth/login' })).toBeNull()
    expect(classifyAuthFailure({ status: 403, code: 'BANNED', hadToken: true, url: '/auth/login' })).toBeNull()
  })
  it('credential endpoints never end a session', () => {
    for (const url of ['/auth/register', '/auth/forgot-password', '/auth/reset-password?x=1'])
      expect(classifyAuthFailure({ status: 401, hadToken: true, url })).toBeNull()
  })
  it('a 401 on a request that carried NO token is not an "expiry"', () => {
    expect(classifyAuthFailure({ status: 401, hadToken: false, url: '/scan/history' })).toBeNull()
  })
  it('a 401 on a token-bearing request means the session ended', () => {
    expect(classifyAuthFailure({ status: 401, hadToken: true, url: '/auth/me' })).toBe('expired')
    expect(classifyAuthFailure({ status: 401, code: 'SESSION_INVALID', hadToken: true, url: '/x' })).toBe('expired')
    expect(classifyAuthFailure({ status: 401, code: 'TOKEN_EXPIRED', hadToken: true, url: '/x' })).toBe('expired')
    expect(classifyAuthFailure({ status: 401, code: 'USER_NOT_FOUND', hadToken: true, url: '/x' })).toBe('expired')
  })
  it('BANNED on a token-bearing request is reported as banned', () => {
    expect(classifyAuthFailure({ status: 403, code: 'BANNED', hadToken: true, url: '/scan' })).toBe('banned')
  })
  // Auth round 2 (B1): confirming an email change from the wrong/no session answers 403
  // SIGN_IN_REQUIRED. It must never be read as "your session died" — that would sign out a
  // visitor who is simply signed in as a different account than the link's.
  it('SIGN_IN_REQUIRED (confirm-email-change from another account) does not end the session', () => {
    expect(classifyAuthFailure({ status: 403, code: 'SIGN_IN_REQUIRED', hadToken: true, url: '/auth/email/confirm' })).toBeNull()
    expect(classifyAuthFailure({ status: 403, code: 'SIGN_IN_REQUIRED', hadToken: false, url: '/auth/email/confirm' })).toBeNull()
  })
  it('a confirm-email-change link survives as a post-login destination', () => {
    const next = '/confirm-email-change?token=' + 'ab12'.repeat(16)
    expect(safeNext(next)).toBe(next)
  })
  it('ordinary errors are not auth failures (403 forbidden, 404, 429, 500)', () => {
    for (const status of [400, 403, 404, 409, 429, 500, 502])
      expect(classifyAuthFailure({ status, hadToken: true, url: '/scan/1' })).toBeNull()
  })
  it('a network error (no status) is not an auth failure', () => {
    expect(classifyAuthFailure({ status: undefined, hadToken: true, url: '/scan/1' })).toBeNull()
  })
})

describe('isCredentialEndpoint / isProtectedPath', () => {
  it('matches credential endpoints regardless of query string', () => {
    expect(isCredentialEndpoint('/auth/login')).toBe(true)
    expect(isCredentialEndpoint('/auth/login?x=1')).toBe(true)
    expect(isCredentialEndpoint('/auth/me')).toBe(false)
    expect(isCredentialEndpoint(undefined)).toBe(false)
  })
  it('only dashboard and admin pages force a redirect; public pages do not', () => {
    for (const p of ['/dashboard', '/dashboard/settings', '/admin/partners']) expect(isProtectedPath(p)).toBe(true)
    for (const p of ['/', '/pricing', '/v/ABC', '/scan/1', '/verify-email', '/reset-password', '/login', '/dashboardx'])
      expect(isProtectedPath(p)).toBe(false)
  })
})

describe('safeNext — open-redirect protection', () => {
  it('accepts same-site relative paths (with query)', () => {
    expect(safeNext('/dashboard')).toBe('/dashboard')
    expect(safeNext('/scan/123?token=abc')).toBe('/scan/123?token=abc')
  })
  it('rejects everything that could leave the site or loop', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', 'dashboard', '', null, undefined, 42,
      '/login', '/login?expired=true', '/foo\r\nSet-Cookie: x=1'])
      expect(safeNext(bad)).toBeNull()
  })
  // AUDIT FIX (Auth section round 1, bug B1): a tab character (and other
  // whitespace/control characters) survived the old \r\n-only check, and a
  // URL parser resolving the value later strips it — so "/\t/evil.com" passed
  // this guard but resolved to https://evil.com/. Every ASCII control
  // character and space is rejected now, not just \r and \n.
  it('rejects a tab (and other control/whitespace characters) that a URL parser would strip', () => {
    for (const bad of ['/\t/evil.com', '/\t\\evil.com', '/ /evil.com', '/\x00/evil.com', '/\x7f/evil.com', '/\v/evil.com', '/\f/evil.com'])
      expect(safeNext(bad)).toBeNull()
  })
  it('still accepts an ordinary path with no control characters', () => {
    expect(safeNext('/dashboard/settings?tab=security')).toBe('/dashboard/settings?tab=security')
  })
})

// A JWT with just enough shape to read the `sid` claim from (the signature is never checked client-side).
const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

describe('tokenSessionId', () => {
  it('reads the sid claim', () => expect(tokenSessionId(jwt({ sid: 'abc-123', sub: 'u1' }))).toBe('abc-123'))
  it('is null for a token without one, and for anything that is not a token', () => {
    for (const t of [jwt({ sub: 'u1' }), 'opaque', '', null, undefined, 'a.%%%.c', 'a..c', jwt({ sid: 5 })])
      expect(tokenSessionId(t)).toBeNull()
  })
})

// A request fired under session A can fail after the person has signed out and in as someone else;
// that failure must not end session B. Same session (a renewed token) still counts.
describe('failureAppliesToCurrentSession', () => {
  it('is true for the identical token', () => expect(failureAppliesToCurrentSession('tok', 'tok')).toBe(true))
  it('is false once a different account is signed in', () => {
    expect(failureAppliesToCurrentSession(jwt({ sid: 'A' }), jwt({ sid: 'B' }))).toBe(false)
    expect(failureAppliesToCurrentSession('old-opaque', 'new-opaque')).toBe(false)
  })
  it('is true when the token was renewed but still belongs to the same session', () => {
    expect(failureAppliesToCurrentSession(jwt({ sid: 'A', iat: 1 }), jwt({ sid: 'A', iat: 2 }))).toBe(true)
  })
  it('is false when nobody is signed in now, or no token was sent', () => {
    expect(failureAppliesToCurrentSession('tok', null)).toBe(false)
    expect(failureAppliesToCurrentSession(null, 'tok')).toBe(false)
  })
})

// Auth round 4 (B3)
describe('failureScope', () => {
  it("'current' for the identical token", () => expect(failureScope('tok', 'tok')).toBe('current'))
  it("'probe' for an older token of the same session — it must be checked, not trusted", () => {
    expect(failureScope(jwt({ sid: 'A', iat: 1 }), jwt({ sid: 'A', iat: 2 }))).toBe('probe')
  })
  it("'stale' for another session, an opaque token, or nothing held", () => {
    expect(failureScope(jwt({ sid: 'A' }), jwt({ sid: 'B' }))).toBe('stale')
    expect(failureScope('old-opaque', 'new-opaque')).toBe('stale')
    expect(failureScope('tok', null)).toBe('stale')
    expect(failureScope(null, 'tok')).toBe('stale')
  })
})

// Auth round 3: another tab signed the browser out.
describe('signedOutElsewhereTarget', () => {
  it('sends a tab on a page that needs a session to sign-in, remembering where it was', () => {
    expect(signedOutElsewhereTarget('/dashboard', '')).toBe('/login?next=%2Fdashboard')
    expect(signedOutElsewhereTarget('/dashboard/settings', '?tab=x')).toBe('/login?next=%2Fdashboard%2Fsettings%3Ftab%3Dx')
    expect(signedOutElsewhereTarget('/admin/users', '')).toBe('/login?next=%2Fadmin%2Fusers')
  })
  it('leaves public pages alone', () => {
    for (const p of ['/', '/login', '/pricing', '/scan/abc', '/v/ABC123', '/reset-password', '/verify-email'])
      expect(signedOutElsewhereTarget(p, '?token=x')).toBeNull()
  })
  it('produces a destination safeNext accepts', () => {
    const to = signedOutElsewhereTarget('/dashboard/payments', '?page=2')
    expect(safeNext(decodeURIComponent(to.split('next=')[1]))).toBe('/dashboard/payments?page=2')
  })
})
