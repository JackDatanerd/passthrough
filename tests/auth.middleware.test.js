import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sign } from '../src/lib/jwt.js'

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
