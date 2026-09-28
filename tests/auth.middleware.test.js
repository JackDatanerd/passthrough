import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sign } from '../src/lib/jwt.js'
import { TERMS_VERSION } from '../src/config/constants.js'

const SECRET = 'test-jwt-secret'

const userRow = (over = {}) => ({
  id: 'u1', email: 'a@b.co', name: 'A', role: 'USER', status: 'ACTIVE', token_version: 3, deleted_at: null,
  password_hash: 'hash', ...over,
})

function setup(dbResult) {
  const db = createFakeSupabase(q => (q.table === 'users' ? dbResult(q) : undefined))
  const { mod, restore } = loadWithStubs('middleware/auth.js', { 'config/supabase.js': { getSupabase: () => db } })
  return { auth: mod, db, restore }
}

async function run(auth, { header, secret = SECRET } = {}) {
  const store = {}
  let nextCalled = false
  const c = {
    env: { JWT_SECRET: secret },
    req: { header: n => (n === 'Authorization' ? header : undefined) },
    json: (body, status) => ({ body, status }),
    set: (k, v) => { store[k] = v },
    get: k => store[k],
  }
  const res = await auth(c, async () => { nextCalled = true })
  return { res, store, nextCalled }
}

let ctx
afterEach(() => ctx?.restore())

describe('auth middleware', () => {
  it('401s with no Authorization header (no code)', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const { res } = await run(ctx.auth, {})
    expect(res.status).toBe(401)
    expect(res.body.code).toBeUndefined()
  })

  it('401s on a malformed / wrongly-signed token', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const bad = await sign({ userId: 'u1', tokenVersion: 3 }, 'some-other-secret', 60)
    const { res } = await run(ctx.auth, { header: `Bearer ${bad}` })
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Invalid token')
  })

  it('answers TOKEN_EXPIRED for an expired token', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const expired = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, -10)
    const { res } = await run(ctx.auth, { header: `Bearer ${expired}` })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('TOKEN_EXPIRED')
  })

  it('accepts a valid token, looks the user up BY ID from the token, and strips secrets', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    const { res, store, nextCalled } = await run(ctx.auth, { header: `Bearer ${token}` })
    expect(res).toBeUndefined()
    expect(nextCalled).toBe(true)
    expect(eqValue(ctx.db.calls[0], 'id')).toBe('u1')
    expect(store.user.email).toBe('a@b.co')
    expect(store.user.passwordHash).toBeUndefined()
  })

  // getMe() returns c.get('user') verbatim, so every internal-only column must be
  // stripped HERE — lastLoginAlertAt (throttle bookkeeping) used to slip through.
  it('strips every internal-only column, including lastLoginAlertAt, from the user it exposes', async () => {
    ctx = setup(() => ({ data: userRow({ last_login_alert_at: '2026-01-01T00:00:00Z', reset_token: 'h', email_verify_token: 'h', pending_email_token: 'h' }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    const { store } = await run(ctx.auth, { header: `Bearer ${token}` })
    for (const f of ['passwordHash', 'lastLoginAlertAt', 'resetToken', 'emailVerifyToken', 'pendingEmailToken', 'paystackAuthCode', 'savedProfile'])
      expect(store.user).not.toHaveProperty(f)
  })

  // FEATURE GAP CLOSED (Auth section, second independent pass): termsCurrent
  // has to be computed here (and identically in optionalAuth.js), not just in
  // auth.controller.js's safeUser() — getMe() reads c.get('user') straight
  // from this middleware, it never goes through safeUser().
  it('termsCurrent is true for an account with no terms_version on record (grandfathered)', async () => {
    ctx = setup(() => ({ data: userRow({ terms_version: null }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    const { store } = await run(ctx.auth, { header: `Bearer ${token}` })
    expect(store.user.termsCurrent).toBe(true)
  })
  it('termsCurrent is false for an account that accepted a since-superseded version', async () => {
    ctx = setup(() => ({ data: userRow({ terms_version: '2020-01' }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    const { store } = await run(ctx.auth, { header: `Bearer ${token}` })
    expect(store.user.termsCurrent).toBe(false)
  })
  it('termsCurrent is true for an account on the current terms version', async () => {
    ctx = setup(() => ({ data: userRow({ terms_version: TERMS_VERSION }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    const { store } = await run(ctx.auth, { header: `Bearer ${token}` })
    expect(store.user.termsCurrent).toBe(true)
  })

  it('SESSION_INVALID when tokenVersion no longer matches (password changed elsewhere)', async () => {
    ctx = setup(() => ({ data: userRow({ token_version: 4 }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    const { res, nextCalled } = await run(ctx.auth, { header: `Bearer ${token}` })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_INVALID')
    expect(nextCalled).toBe(false)
  })

  it('403 BANNED for a banned account', async () => {
    ctx = setup(() => ({ data: userRow({ status: 'BANNED' }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    const { res } = await run(ctx.auth, { header: `Bearer ${token}` })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('BANNED')
  })

  it('USER_NOT_FOUND for a deleted (soft-deleted) account', async () => {
    ctx = setup(() => ({ data: userRow({ deleted_at: '2026-01-01T00:00:00Z' }) }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    const { res } = await run(ctx.auth, { header: `Bearer ${token}` })
    expect(res.body.code).toBe('USER_NOT_FOUND')
  })

  // AUDIT FIX (bug — redundant double auth check): when optionalAuth
  // (mounted app-wide, ahead of this middleware on every real request) has
  // already verified the token and set both c.get('user') and
  // c.get('tokenExp'), this middleware must reuse that result instead of
  // re-verifying the JWT and re-querying Supabase a second time. Simulates
  // that by pre-seeding the store the same way optionalAuth's own
  // `c.set('user', ...)` / `c.set('tokenExp', ...)` would.
  it('reuses optionalAuth\'s result instead of re-verifying/re-fetching when both are already set', async () => {
    ctx = setup(() => { throw new Error('DB should not be queried on the fast path') })
    const store = { user: { id: 'u1', email: 'a@b.co' }, tokenExp: 9999999999 }
    let nextCalled = false
    const c = {
      env: { JWT_SECRET: SECRET },
      req: { header: () => 'Bearer irrelevant-on-the-fast-path' },
      json: (body, status) => ({ body, status }),
      set: (k, v) => { store[k] = v },
      get: k => store[k],
    }
    const res = await ctx.auth(c, async () => { nextCalled = true })
    expect(res).toBeUndefined()
    expect(nextCalled).toBe(true)
    expect(store.user.id).toBe('u1')  // untouched — reused, not re-derived
  })

  // Converse of the above: if optionalAuth did NOT set both (no token, a
  // banned/deleted account, a stale tokenVersion, an expired/invalid
  // token — every case it deliberately swallows into a silent
  // fall-through), this middleware must still fall through to the full
  // verify+fetch path and produce the correct specific error, not treat
  // the absence as an automatic pass.
  it('falls through to the full path (and still 401s) when optionalAuth did not set a user', async () => {
    ctx = setup(() => ({ data: userRow() }))
    const { res } = await run(ctx.auth, {})  // no Authorization header, no pre-seeded store
    expect(res.status).toBe(401)
  })

  // REGRESSION: a database hiccup used to be reported as 401 "Invalid token".
  // Clients treat 401-with-a-token as "your session is dead" and sign the user
  // out — so a transient Supabase error logged people out. An infrastructure
  // failure must surface as a server error, never as an auth verdict.
  it('does NOT answer 401 when the user lookup fails (database error)', async () => {
    ctx = setup(() => ({ data: null, error: { message: 'connection reset', code: '08006' } }))
    const token = await sign({ userId: 'u1', tokenVersion: 3 }, SECRET, 60)
    let outcome
    try { outcome = (await run(ctx.auth, { header: `Bearer ${token}` })).res } catch (err) { outcome = { thrown: err } }
    const is401 = outcome && outcome.status === 401
    expect(is401).toBe(false)
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
  const { mod, restore } = loadWithStubs('middleware/auth.js', { 'config/supabase.js': { getSupabase: () => db } })
  return { auth: mod, db, restore }
}
const sessQueries = ctx => ctx.db.calls.filter(q => q.table === 'user_sessions')
const bearer = async (payload, ttl = 60) => `Bearer ${await sign(payload, SECRET, ttl)}`

describe('auth middleware — explicit column list (bug B5)', () => {
  it('never selects * — and never asks the database for password_hash, saved_profile or any token column', async () => {
    ctx = setupS()
    await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3 }) })
    const cols = ctx.db.calls.find(q => q.table === 'users').cols
    expect(cols).not.toBe('*')
    for (const secret of ['password_hash', 'saved_profile', 'reset_token', 'email_verify_token', 'pending_email_token', 'paystack_auth_code', 'paystack_customer_code', 'last_login_alert_at'])
      expect(cols, secret).not.toContain(secret)
    // ...but everything the checks and the request user need is there
    for (const needed of ['id', 'email', 'name', 'role', 'status', 'token_version', 'deleted_at', 'email_verified'])
      expect(cols, needed).toContain(needed)
  })
  it('still strips secrets from the request user even if a column list were ever widened (defence in depth)', async () => {
    ctx = setupS({ user: () => ({ data: userRow({ saved_profile: { x: 1 }, reset_token: 'h', paystack_auth_code: 'AUTH' }) }) })
    const { store } = await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3 }) })
    for (const k of ['passwordHash', 'savedProfile', 'resetToken', 'paystackAuthCode']) expect(store.user[k], k).toBeUndefined()
  })
})

describe('auth middleware — server-side sessions (sid)', () => {
  it('a token WITHOUT a sid never touches user_sessions (pre-0047 tokens keep working)', async () => {
    ctx = setupS()
    const { res, nextCalled, store } = await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3 }) })
    expect(res).toBeUndefined()
    expect(nextCalled).toBe(true)
    expect(sessQueries(ctx)).toHaveLength(0)
    expect(store.sessionId).toBeUndefined()
  })
  it('a token with a live session passes, looks the session up BY sid, and exposes sessionId + its absolute expiry', async () => {
    ctx = setupS()
    const { res, nextCalled, store } = await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }) })
    expect(res).toBeUndefined()
    expect(nextCalled).toBe(true)
    expect(eqValue(sessQueries(ctx)[0], 'id')).toBe(SID)
    expect(store.sessionId).toBe(SID)
    expect(store.sessionExpiresAtMs).toBeGreaterThan(Date.now() + 19 * 86400000)
  })
  it('a REVOKED session is SESSION_INVALID even though the JWT signature, expiry and tokenVersion are all fine', async () => {
    ctx = setupS({ sess: () => ({ data: session({ revoked_at: new Date().toISOString() }) }) })
    const { res, nextCalled } = await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }) })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_INVALID')
    expect(nextCalled).toBe(false)
  })
  it('a session past its ABSOLUTE expiry is TOKEN_EXPIRED even with a fresh, unexpired JWT — renewal cannot outrun it', async () => {
    ctx = setupS({ sess: () => ({ data: session({ absolute_expires_at: new Date(Date.now() - 1000).toISOString() }) }) })
    const { res, nextCalled } = await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }, 3600) })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('TOKEN_EXPIRED')
    expect(nextCalled).toBe(false)
  })
  it('a sid that points at ANOTHER user\'s session, or at no row, is SESSION_INVALID', async () => {
    for (const data of [session({ user_id: 'someone-else' }), null]) {
      ctx = setupS({ sess: () => ({ data }) })
      const { res } = await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }) })
      expect(res.status).toBe(401)
      expect(res.body.code).toBe('SESSION_INVALID')
      ctx.restore()
    }
  })
  it('a malformed sid is SESSION_INVALID without a database round trip for it', async () => {
    ctx = setupS()
    const { res } = await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: 'not-a-uuid' }) })
    expect(res.body.code).toBe('SESSION_INVALID')
    expect(sessQueries(ctx)).toHaveLength(0)
  })
  it('a database failure on the session lookup is a 5xx (thrown), never a 401 that would sign the user out', async () => {
    ctx = setupS({ sess: () => ({ data: null, error: { message: 'connection reset' } }) })
    await expect(run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }) })).rejects.toBeTruthy()
  })
  it('checks tokenVersion before the session: a bulk-revoked token is SESSION_INVALID whatever the session row says', async () => {
    ctx = setupS()
    const { res } = await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 2, sid: SID }) })
    expect(res.body.code).toBe('SESSION_INVALID')
  })
  it('refreshes last_seen_at when the session has been quiet, but not on every request', async () => {
    ctx = setupS({ sess: () => ({ data: session({ last_seen_at: new Date(Date.now() - 60 * 60000).toISOString() }) }) })
    await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }) })
    await tick()
    const upd = sessQueries(ctx).find(q => q.op === 'update')
    expect(upd.patch.last_seen_at).toBeTypeOf('string')
    expect(eqValue(upd, 'id')).toBe(SID)
    ctx.restore()

    ctx = setupS() // seen "just now"
    await run(ctx.auth, { header: await bearer({ userId: 'u1', tokenVersion: 3, sid: SID }) })
    await tick()
    expect(sessQueries(ctx).filter(q => q.op === 'update')).toHaveLength(0)
  })
})
