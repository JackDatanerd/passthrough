import { describe, it, expect } from 'vitest'
import { AUTH_USER_COLUMNS, SECRET_USER_FIELDS, toRequestUser } from '../src/lib/authUser.js'
import { userRowToCamel } from '../src/lib/mappers.js'

// AUDIT FIX (Auth section round 1, bug B5): auth.js/optionalAuth.js used to
// select('*') on every authenticated request, dragging password_hash and the
// full saved_profile resume JSON through the Worker on every call just to
// strip them a line later — and each middleware kept its OWN copy of the strip
// list. authUser.js is now the one place both facts live; this test exists so
// a future column added to either list can't silently drift from the other.

// Every camelCase field userRowToCamel() currently produces from a users row.
const camelFields = Object.keys(userRowToCamel({
  id: 'x', email: 'x', password_hash: 'x', name: 'x', role: 'x', status: 'x',
  token_version: 1, email_verified: true, email_verify_token: 'x', email_verify_expiry: 'x',
  reset_token: 'x', reset_token_expiry: 'x', pending_email: 'x', pending_email_token: 'x',
  pending_email_expiry: 'x', deleted_at: null, scans_today: 0, free_fix_credits: 0,
  scans_day_reset: null, paystack_customer_code: 'x', paystack_auth_code: 'x', saved_profile: {},
  terms_accepted_at: null, terms_version: null, last_login_at: null, last_login_ip: null,
  previous_login_at: null, previous_login_ip: null, last_login_alert_at: null,
  created_at: 'x', updated_at: 'x', notify_scan_results: true,
}))

// snake_case -> the exact camelCase key userRowToCamel() maps it to.
const toCamel = snake => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

describe('authUser.js — AUTH_USER_COLUMNS / SECRET_USER_FIELDS cannot silently drift', () => {
  it('every fetched column maps to a real mapper field, and every mapper field is either fetched or explicitly secret', () => {
    const fetched = new Set(AUTH_USER_COLUMNS.split(',').map(s => toCamel(s.trim())))
    for (const snake of AUTH_USER_COLUMNS.split(',').map(s => s.trim())) {
      const camel = toCamel(snake)
      expect(camelFields, `AUTH_USER_COLUMNS has "${snake}" but userRowToCamel has no "${camel}"`).toContain(camel)
    }
    for (const camel of camelFields) {
      expect(fetched.has(camel) || SECRET_USER_FIELDS.includes(camel),
        `"${camel}" is neither fetched by AUTH_USER_COLUMNS nor listed in SECRET_USER_FIELDS — it will silently ` +
        `never appear on the request user. If it's meant to be visible, add its column; if not, add it to SECRET_USER_FIELDS explicitly.`
      ).toBe(true)
    }
  })
  it('no secret field is ever fetched — a secret cannot leak by being added to both lists', () => {
    const fetched = new Set(AUTH_USER_COLUMNS.split(',').map(s => toCamel(s.trim())))
    for (const secret of SECRET_USER_FIELDS) expect(fetched.has(secret), secret).toBe(false)
  })
  it('every SECRET_USER_FIELDS entry is a real mapper field (no dead / misspelled entries)', () => {
    for (const secret of SECRET_USER_FIELDS) expect(camelFields, secret).toContain(secret)
  })
})

describe('authUser.js — toRequestUser()', () => {
  const row = { id: 'u1', email: 'a@b.co', name: 'A', role: 'USER', status: 'ACTIVE', token_version: 3, deleted_at: null,
    password_hash: 'h', saved_profile: { x: 1 }, reset_token: 'rt', paystack_auth_code: 'AUTH', terms_version: null }

  it('null row -> null user and null requestUser', () => {
    expect(toRequestUser(null)).toEqual({ user: null, requestUser: null })
  })
  it('strips every secret field from requestUser but keeps them on the full user', () => {
    const { user, requestUser } = toRequestUser(row)
    expect(user.passwordHash).toBe('h')
    for (const k of SECRET_USER_FIELDS) expect(requestUser[k], k).toBeUndefined()
  })
  it('sets termsCurrent, grandfathering a null terms_version as current', () => {
    expect(toRequestUser(row).requestUser.termsCurrent).toBe(true)
  })
  it('tokenVersion stays on requestUser (server-side use) — callers serializing to a client must strip it themselves', () => {
    expect(toRequestUser(row).requestUser.tokenVersion).toBe(3)
  })
})

describe('authUser.js — a pending email change whose link has expired is not "pending" any more', () => {
  const base = { id: 'u1', email: 'a@b.co', name: 'A', role: 'USER', status: 'ACTIVE', token_version: 1, deleted_at: null, pending_email: 'new@b.co' }
  const inMs = ms => new Date(Date.now() + ms).toISOString()
  it('a live staged change is reported, with its expiry for a countdown', () => {
    const { requestUser } = toRequestUser({ ...base, pending_email_expiry: inMs(30 * 60_000) })
    expect(requestUser.pendingEmail).toBe('new@b.co')
    expect(requestUser.pendingEmailExpiry).toBeTruthy()
  })
  it('an expired one reads as none (the confirmation endpoint refuses it), but the full user row is untouched', () => {
    const { user, requestUser } = toRequestUser({ ...base, pending_email_expiry: inMs(-60_000) })
    expect(requestUser.pendingEmail).toBe(null)
    expect(user.pendingEmail).toBe('new@b.co')
  })
  it('a staged address with no expiry cannot be confirmed either, so it is not shown', () => {
    expect(toRequestUser({ ...base, pending_email_expiry: null }).requestUser.pendingEmail).toBe(null)
  })
  it('no staged change stays null; the confirmation token is never exposed', () => {
    const { requestUser } = toRequestUser({ ...base, pending_email: null, pending_email_expiry: null, pending_email_token: 'secret' })
    expect(requestUser.pendingEmail).toBe(null)
    expect(requestUser.pendingEmailToken).toBeUndefined()
  })
  it('exposes the notification preference, defaulting to on for a row from before the column', () => {
    expect(toRequestUser({ ...base, notify_scan_results: false }).requestUser.notifyScanResults).toBe(false)
    expect(toRequestUser(base).requestUser.notifyScanResults).toBe(true)
  })
})
