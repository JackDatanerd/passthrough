import { describe, it, expect, vi } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { isSessionId, createSession, tokenLifetimeSeconds, loadSession, sessionProblem, touchSession, SESSION_COLUMNS } from '../src/lib/sessions.js'

const SID = '11111111-2222-4333-8444-555555555555'
const c = (over = {}) => ({
  req: { header: n => (n === 'User-Agent' ? (over.ua ?? 'TestUA') : n === 'cf-connecting-ip' ? (over.ip ?? '1.2.3.4') : undefined) },
  executionCtx: over.executionCtx ?? { waitUntil: p => p },
  env: { NODE_ENV: 'production' },
})

describe('isSessionId', () => {
  it('accepts a real UUID and rejects everything else', () => {
    expect(isSessionId(SID)).toBe(true)
    for (const bad of [null, undefined, '', 'not-a-uuid', 123, SID + 'x', SID.slice(0, -1)])
      expect(isSessionId(bad), String(bad)).toBe(false)
  })
})

describe('createSession', () => {
  it('calls create_user_session with the request IP, user-agent, and the constants-configured lifetime/cap', async () => {
    const db = createFakeSupabase(q => q.op === 'rpc' ? { data: [{ session_id: SID, session_expires_at: new Date(Date.now() + 86400000).toISOString() }], error: null } : undefined)
    const session = await createSession(c({ ip: '9.9.9.9', ua: 'MyBrowser' }), db, 'u1')
    expect(session).toMatchObject({ id: SID })
    const call = db.calls[0]
    expect(call.args).toMatchObject({ p_user_id: 'u1', p_ip: '9.9.9.9', p_user_agent: 'MyBrowser', p_lifetime_days: 30, p_max_active: 20 })
  })
  it('returns null (never throws) when the RPC errors — sign-in must degrade, not fail', async () => {
    const realErr = console.error; console.error = () => {}
    const db = createFakeSupabase(() => ({ data: null, error: { message: 'no such function' } }))
    const session = await createSession(c(), db, 'u1')
    console.error = realErr
    expect(session).toBeNull()
  })
  it('returns null on a malformed/missing row from the RPC', async () => {
    const realErr = console.error; console.error = () => {}
    for (const data of [null, [], [{ session_id: 'not-a-uuid', session_expires_at: 'x' }], [{ session_id: SID, session_expires_at: 'not-a-date' }]]) {
      const db = createFakeSupabase(() => ({ data, error: null }))
      expect(await createSession(c(), db, 'u1'), JSON.stringify(data)).toBeNull()
    }
    console.error = realErr
  })
})

describe('tokenLifetimeSeconds', () => {
  const env = { JWT_EXPIRES_IN_SECONDS: '604800' }
  it('returns the configured default with no session', () => {
    expect(tokenLifetimeSeconds(env, null)).toBe(604800)
  })
  it('caps at the session\'s remaining absolute lifetime when shorter than the default', () => {
    const session = { expiresAtMs: Date.now() + 3600 * 1000 } // 1h left
    const secs = tokenLifetimeSeconds(env, session)
    expect(secs).toBeLessThanOrEqual(3600)
    expect(secs).toBeGreaterThan(3600 - 5)
  })
  it('never returns less than 1, even for an already-expired session', () => {
    expect(tokenLifetimeSeconds(env, { expiresAtMs: Date.now() - 1000 })).toBe(1)
  })
  it('uses the default when the session has more time left than the default', () => {
    expect(tokenLifetimeSeconds(env, { expiresAtMs: Date.now() + 90 * 86400 * 1000 })).toBe(604800)
  })
})

describe('loadSession', () => {
  it('short-circuits to no-row for a malformed id — never asks the database', async () => {
    const db = createFakeSupabase(() => { throw new Error('should not be called') })
    const { data, error } = await loadSession(db, 'not-a-uuid')
    expect(data).toBeNull(); expect(error).toBeNull()
    expect(db.calls).toHaveLength(0)
  })
  it('queries by id with the fixed column list', async () => {
    const db = createFakeSupabase(() => ({ data: { id: SID }, error: null }))
    await loadSession(db, SID)
    expect(db.calls[0].cols).toBe(SESSION_COLUMNS)
    expect(eqValue(db.calls[0], 'id')).toBe(SID)
    expect(db.calls[0].maybe).toBe(true)
  })
})

describe('sessionProblem', () => {
  const row = (over = {}) => ({ id: SID, user_id: 'u1', revoked_at: null, absolute_expires_at: new Date(Date.now() + 86400000).toISOString(), ...over })
  it('null row -> revoked', () => expect(sessionProblem(null, 'u1')).toBe('revoked'))
  it('a session belonging to someone else -> revoked', () => expect(sessionProblem(row({ user_id: 'someone-else' }), 'u1')).toBe('revoked'))
  it('a revoked session -> revoked, regardless of expiry', () => expect(sessionProblem(row({ revoked_at: new Date().toISOString() }), 'u1')).toBe('revoked'))
  it('past its absolute expiry -> expired', () => expect(sessionProblem(row({ absolute_expires_at: new Date(Date.now() - 1000).toISOString() }), 'u1')).toBe('expired'))
  it('a live, un-revoked, unexpired session -> null (no problem)', () => expect(sessionProblem(row(), 'u1')).toBeNull())
})

describe('touchSession', () => {
  it('refreshes last_seen_at/ip/user-agent when the session has been quiet past the interval', async () => {
    const db = createFakeSupabase(q => q.op === 'update' ? { error: null } : undefined)
    const row = { id: SID, last_seen_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }
    touchSession(c({ ip: '5.5.5.5' }), db, row)
    await new Promise(r => setTimeout(r, 0))
    const upd = db.calls.find(q => q.op === 'update')
    expect(upd).toBeDefined()
    expect(eqValue(upd, 'id')).toBe(SID)
    expect(upd.patch.ip).toBe('5.5.5.5')
  })
  it('does NOT write when the session was seen recently (bounded write frequency)', async () => {
    const db = createFakeSupabase(q => q.op === 'update' ? { error: null } : undefined)
    touchSession(c(), db, { id: SID, last_seen_at: new Date().toISOString() })
    await new Promise(r => setTimeout(r, 0))
    expect(db.calls.filter(q => q.op === 'update')).toHaveLength(0)
  })
  it('never throws when there is no executionCtx.waitUntil (the promise still runs, unguarded)', async () => {
    const db = createFakeSupabase(q => q.op === 'update' ? { error: null } : undefined)
    const bad = c({ executionCtx: undefined })
    expect(() => touchSession(bad, db, { id: SID, last_seen_at: new Date(Date.now() - 3600000).toISOString() })).not.toThrow()
  })
})
