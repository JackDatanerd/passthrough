import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sign } from '../src/lib/jwt.js'

const SECRET = 'test-jwt-secret'

// optionalAuth.js had zero test coverage despite being mounted app-wide
// (every request, protected or not, runs through it) and being where the
// "strip sensitive fields before c.set('user', ...)" guarantee actually
// lives — a regression here leaks password hashes / paystack auth codes /
// reset tokens onto every request in the app, not just one route.

const userRow = (over = {}) => ({
  id: 'u1', email: 'a@b.co', name: 'A', role: 'USER', status: 'ACTIVE', token_version: 3, deleted_at: null,
  password_hash: 'secret-hash', paystack_auth_code: 'AUTH_1', paystack_customer_code: 'CUS_1',
  reset_token: 'rt', reset_token_expiry: 't', email_verify_token: 'evt', email_verify_expiry: 't',
  saved_profile: { name: 'A' },
  ...over,
})

function setup(dbResult) {
  const db = createFakeSupabase(q => (q.table === 'users' ? dbResult(q) : undefined))
  const { mod, restore } = loadWithStubs('middleware/optionalAuth.js', { 'config/supabase.js': { getSupabase: () => db } })
  return { optionalAuth: mod, db, restore }
}

async function run(optionalAuth, { header, secret = SECRET } = {}) {
  const store = {}
  let nextCalled = false
  const c = {
    env: { JWT_SECRET: secret },
    req: { header: n => (n === 'Authorization' ? header : undefined) },
    json: (body, status) => ({ body, status }),
    set: (k, v) => { store[k] = v },
    get: k => store[k],
  }
  const res = await optionalAuth(c, async () => { nextCalled = true })
  return { res, store, nextCalled }
}

let ctx
afterEach(() => ctx?.restore())

describe('optionalAuth', () => {
  it('calls next() with no user set when there is no Authorization header', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const { store, nextCalled } = await run(ctx.optionalAuth, {})
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })

  it('calls next() with no user set on a malformed/non-Bearer header', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: 'Basic abc' })
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })

  it('calls next() with no user set on an invalid/garbage token (never throws)', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: 'Bearer not-a-real-jwt' })
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })

  it('calls next() with no user set when the token was signed with a different secret', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, 'wrong-secret', 3600)
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })

  it('sets a stripped-down user (no password/paystack/reset/verify/saved-profile fields) on a valid token', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(nextCalled).toBe(true)
    expect(store.user).toMatchObject({ id: 'u1', email: 'a@b.co', role: 'USER' })
    for (const field of ['passwordHash', 'paystackAuthCode', 'paystackCustomerCode', 'resetToken', 'resetTokenExpiry', 'emailVerifyToken', 'emailVerifyExpiry', 'savedProfile'])
      expect(store.user).not.toHaveProperty(field)
  })

  it('also stashes tokenExp on success, for auth.js to reuse', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(typeof store.tokenExp).toBe('number')
  })

  it('falls through (no user) when the account is deleted', async () => {
    ctx = setup(() => ({ data: userRow({ deleted_at: '2026-01-01' }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })

  it('falls through (no user) when the account is banned', async () => {
    ctx = setup(() => ({ data: userRow({ status: 'BANNED' }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })

  it('falls through (no user) when tokenVersion has been bumped since the token was issued (logout-everywhere)', async () => {
    ctx = setup(() => ({ data: userRow({ token_version: 4 }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })

  it('falls through (no user), never throwing, on a DB error', async () => {
    ctx = setup(() => ({ data: null, error: { message: 'db down' } }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })

  it('falls through (no user) when the user row no longer exists', async () => {
    ctx = setup(() => ({ data: null }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store, nextCalled } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(nextCalled).toBe(true)
    expect(store.user).toBeUndefined()
  })
})

// ── c.get('authError') classification (Section 9) ──────────────────────────
// Every "falls through, no user" case above collapses distinct causes into
// one outcome — fine for a page that's equally happy either way, but two
// downstream consumers need to tell them apart: adminOnly.js must answer 503
// (not 401) when OUR lookup failed, not the caller's session — see
// middleware-misc.test.js's adminOnly describe — and createScan
// (scan.controller.js) must not silently create an anonymous scan for a
// signed-in user just because a database blip made them look logged out.
describe('optionalAuth — c.get(\'authError\') classification', () => {
  it('no header at all → no authError (this is a genuinely anonymous request)', async () => {
    const { store } = await run(async (c, next) => next(), {})
    expect(store.authError).toBeUndefined()
  })
  it('a valid token sets no authError', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(store.authError).toBeUndefined()
  })
  it('an expired token → "expired"', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, -10)
    const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(store.authError).toBe('expired')
  })
  it('a forged/garbage token → "invalid"', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, 'wrong-secret', 3600)
    const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(store.authError).toBe('invalid')
  })
  it('banned / deleted / stale tokenVersion → "inactive" (the caller\'s credentials, not our fault)', async () => {
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    for (const over of [{ status: 'BANNED' }, { deleted_at: '2020-01-01' }, { token_version: 9 }]) {
      ctx = setup(() => ({ data: userRow(over) }))
      const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
      expect(store.authError).toBe('inactive')
    }
  })
  it('a DATABASE failure → "unavailable" — must not be confused with a bad session', async () => {
    ctx = setup(() => ({ data: null, error: { message: 'db down' } }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(store.authError).toBe('unavailable')
  })
})
