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

  it('never exposes lastLoginAlertAt (internal throttle bookkeeping)', async () => {
    ctx = setup(() => ({ data: userRow({ last_login_alert_at: '2026-01-01T00:00:00Z' }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(store.user).not.toHaveProperty('lastLoginAlertAt')
  })

  // FEATURE GAP CLOSED (Auth section, second independent pass): must match
  // auth.js's own version of this exactly — auth.js's fast path just reuses
  // whatever this middleware already set on c.get('user').
  it('sets termsCurrent on a valid token, grandfathering a null terms_version', async () => {
    ctx = setup(() => ({ data: userRow({ terms_version: null }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(store.user.termsCurrent).toBe(true)
  })
  it('sets termsCurrent: false for a stale accepted terms version', async () => {
    ctx = setup(() => ({ data: userRow({ terms_version: '2020-01' }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 3600)
    const { store } = await run(ctx.optionalAuth, { header: `Bearer ${token}` })
    expect(store.user.termsCurrent).toBe(false)
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

const SID = '11111111-2222-4333-8444-555555555555'
const session = (over = {}) => ({
  id: SID, user_id: 'u1', created_at: new Date(Date.now() - 86400000).toISOString(),
  last_seen_at: new Date().toISOString(), absolute_expires_at: new Date(Date.now() + 20 * 86400000).toISOString(),
  revoked_at: null, ip: '1.2.3.4', user_agent: 'UA', ...over,
})
const tick = () => new Promise(r => setTimeout(r, 0))

function setupS({ user = () => ({ data: userRow() }), sess = () => ({ data: session() }) } = {}) {
  const db = createFakeSupabase(q => (q.table === 'users' ? user(q) : q.table === 'user_sessions' ? sess(q) : undefined))
  const { mod, restore } = loadWithStubs('middleware/optionalAuth.js', { 'config/supabase.js': { getSupabase: () => db } })
  return { optionalAuth: mod, db, restore }
}
const bearer = async payload => `Bearer ${await sign(payload, SECRET, 60)}`

describe('optionalAuth — explicit column list (bug B5) and server-side sessions', () => {
  it('never selects * from users', async () => {
    ctx = setupS()
    await run(ctx.optionalAuth, { header: await bearer({ userId: 'u1', tokenVersion: 3 }) })
    const cols = ctx.db.calls.find(q => q.table === 'users').cols
    expect(cols).not.toBe('*')
    expect(cols).not.toContain('password_hash')
    expect(cols).not.toContain('saved_profile')
  })
  it('a token without a sid never touches user_sessions', async () => {
    ctx = setupS()
    const { store } = await run(ctx.optionalAuth, { header: await bearer({ userId: 'u1', tokenVersion: 3 }) })
    expect(store.user.id).toBe('u1')
    expect(ctx.db.calls.filter(q => q.table === 'user_sessions')).toHaveLength(0)
  })
  it('a live session sets user, tokenExp, sessionId and the absolute expiry', async () => {
    ctx = setupS()
    const { store } = await run(ctx.optionalAuth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }) })
    expect(store.user.id).toBe('u1')
    expect(store.tokenExp).toBeTypeOf('number')
    expect(store.sessionId).toBe(SID)
    expect(store.sessionExpiresAtMs).toBeGreaterThan(Date.now())
  })
  it('a revoked / expired / foreign / missing / malformed session → no user, authError "inactive"', async () => {
    const bads = [
      [session({ revoked_at: new Date().toISOString() }), SID],
      [session({ absolute_expires_at: new Date(Date.now() - 1000).toISOString() }), SID],
      [session({ user_id: 'someone-else' }), SID],
      [null, SID],
      [session(), 'not-a-uuid'],
    ]
    for (const [row, sid] of bads) {
      ctx = setupS({ sess: () => ({ data: row }) })
      const { store, nextCalled } = await run(ctx.optionalAuth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid }) })
      expect(store.user).toBeUndefined()
      expect(store.tokenExp).toBeUndefined() // so auth.js's fast path can't be fooled
      expect(store.authError).toBe('inactive')
      expect(nextCalled).toBe(true) // optionalAuth never blocks
      ctx.restore()
    }
  })
  it('a database failure on the session lookup is "unavailable" (our fault), not "inactive" (theirs)', async () => {
    const realErr = console.error; console.error = () => {}
    ctx = setupS({ sess: () => ({ data: null, error: { message: 'boom' } }) })
    const { store } = await run(ctx.optionalAuth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }) })
    console.error = realErr
    expect(store.authError).toBe('unavailable')
    expect(store.user).toBeUndefined()
  })
})
