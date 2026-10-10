import { describe, it, expect } from 'vitest'
import rl from '../src/middleware/rateLimiter.js'
import jwtLib from '../src/lib/jwt.js'

// Cross-cutting infra B1: the app-wide `general` limiter runs BEFORE optionalAuth, so it used to be per-IP only —
// every signed-in person behind one carrier-grade-NAT address shared a single 100-per-15-minutes budget.
const SECRET = 'test-secret-test-secret-test-secret-123'
function kvStore() { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
const mk = (env, { ip = '41.80.1.1', token, path = '/api/scan/history' } = {}) => {
  const store = {}
  return {
    env, req: { method: 'GET', path, header: h => (h === 'cf-connecting-ip' ? ip : h === 'Authorization' && token ? `Bearer ${token}` : undefined) },
    get: k => store[k], set: (k, v) => { store[k] = v }, json: (body, status) => ({ body, status }),
  }
}
const hit = async c => { let passed = false; const res = await rl.general(c, async () => { passed = true }); return passed ? 200 : res.status }

describe('general limiter — per account for signed-in traffic', () => {
  it('20 signed-in people behind one IP are never throttled by each other', async () => {
    const env = { RATE_LIMIT_KV: kvStore(), JWT_SECRET: SECRET, NODE_ENV: 'production' }
    const tokens = []
    for (let u = 1; u <= 20; u++) tokens.push(await jwtLib.sign({ userId: `user-${u}`, tokenVersion: 0 }, SECRET, 600))
    let blocked = 0
    for (let round = 0; round < 6; round++) for (const t of tokens) if (await hit(mk(env, { token: t })) === 429) blocked++
    expect(blocked).toBe(0)
  })
  it('one account is still capped at 100 per window', async () => {
    const env = { RATE_LIMIT_KV: kvStore(), JWT_SECRET: SECRET, NODE_ENV: 'production' }
    const t = await jwtLib.sign({ userId: 'solo', tokenVersion: 0 }, SECRET, 600)
    let last
    for (let i = 0; i < 101; i++) last = await hit(mk(env, { token: t }))
    expect(last).toBe(429)
  })
  it('anonymous traffic and forged/expired/garbage tokens stay on the per-IP bucket', async () => {
    const env = { RATE_LIMIT_KV: kvStore(), JWT_SECRET: SECRET, NODE_ENV: 'production' }
    const forged = await jwtLib.sign({ userId: 'x', tokenVersion: 0 }, 'some-other-secret-some-other-secret', 600)
    const bad = [undefined, forged, 'garbage', 'a.b.c']
    let last
    for (let i = 0; i < 101; i++) last = await hit(mk(env, { token: bad[i % bad.length] }))
    expect(last).toBe(429)   // a forger cannot pick a fresh bucket per request
  })
})
