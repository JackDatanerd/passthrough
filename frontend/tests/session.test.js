import { describe, it, expect } from 'vitest'
import { classifyAuthFailure, isCredentialEndpoint, isProtectedPath, safeNext } from '../src/lib/session.js'

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
