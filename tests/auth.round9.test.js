import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const rl = require('../src/middleware/rateLimiter.js')
const jwt = require('../src/lib/jwt.js')
const sessions = require('../src/lib/sessions.js')

describe('Auth round 9 — idleCutoffIso (B2)', () => {
  it('is lifetime + touch interval before now, default 7 days', () => {
    const now = Date.UTC(2026, 9, 12, 12, 0, 0)
    expect(Date.parse(sessions.idleCutoffIso({}, now))).toBe(now - (604800 + 600) * 1000)
    expect(Date.parse(sessions.idleCutoffIso({ JWT_EXPIRES_IN_SECONDS: '3600' }, now))).toBe(now - (3600 + 600) * 1000)
  })
})

describe('Auth round 9 — general limiter key is per account AND network (B5)', () => {
  const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) }, m } }
  const ctx = (env, token, ip) => ({
    env, req: { method: 'GET', path: '/api/auth/me', header: h => (h === 'cf-connecting-ip' ? ip : h === 'Authorization' ? `Bearer ${token}` : undefined) },
    get() {}, set() {}, json: (b, s) => ({ body: b, status: s }),
  })
  it('a token used from another network cannot spend the owner\'s budget', async () => {
    const env = { JWT_SECRET: 'unit-test-secret-long-enough', RATE_LIMIT_KV: kv() }
    const token = await jwt.sign({ userId: 'victim', tokenVersion: 1 }, env.JWT_SECRET, 3600)
    for (let i = 0; i < 100; i++) await rl.general(ctx(env, token, '9.9.9.9'), async () => {})
    const attacker = await rl.general(ctx(env, token, '9.9.9.9'), async () => {})
    expect(attacker.status).toBe(429)                       // the attacker's own bucket is empty
    let passed = false
    await rl.general(ctx(env, token, '5.5.5.5'), async () => { passed = true })
    expect(passed).toBe(true)                               // the owner, elsewhere, is untouched
    expect([...env.RATE_LIMIT_KV.m.keys()].some(k => k.startsWith('rl:general:u:victim@'))).toBe(true)
  })
})
