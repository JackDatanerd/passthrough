import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import bcrypt from 'bcryptjs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// POST /api/admin/elevate — the password confirmation behind ADMIN_STEP_UP_MINUTES (G1).
const SECRET = 'k'.repeat(40)
async function setup() {
  const hash = await bcrypt.hash('correct horse', 4)
  const db = createFakeSupabase(q => (q.table === 'users' ? { data: { password_hash: hash }, error: null } : undefined))
  const { mod, restore } = loadWithStubs('controllers/admin.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/adminAudit.js': { logAdminAction: async () => {} },
  })
  const mkCtx = (password, env = { JWT_SECRET: SECRET, ADMIN_STEP_UP_MINUTES: '10' }) => ({
    env, get: k => (k === 'user' ? { id: 'a1', role: 'ADMIN' } : k === 'sessionId' ? 's-1' : undefined),
    req: { json: async () => ({ password }) }, json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, mkCtx }
}

describe('adminElevate', () => {
  it('is off unless ADMIN_STEP_UP_MINUTES > 0', async () => {
    const t = await setup()
    try { expect((await t.mod.adminElevate(t.mkCtx('x', { JWT_SECRET: SECRET }))).status).toBe(404) } finally { t.restore() }
  })
  it('a wrong password is a 403 (never a 401, which signs the SPA out); the right one mints a token that satisfies stepUp', async () => {
    const t = await setup()
    try {
      const bad = await t.mod.adminElevate(t.mkCtx('nope'))
      expect(bad.status).toBe(403)
      expect(bad.body.code).toBe('PASSWORD_INCORRECT')
      const ok = await t.mod.adminElevate(t.mkCtx('correct horse'))
      expect(ok.status).toBe(200)
      const token = ok.body.data.elevationToken
      const req = createRequire(import.meta.url)('../src/middleware/adminOnly.js')
      let passed = false
      await req.stepUp({ env: { JWT_SECRET: SECRET, ADMIN_STEP_UP_MINUTES: '10' }, req: { header: h => (h === 'X-Admin-Elevation' ? token : undefined) },
        get: k => (k === 'user' ? { id: 'a1' } : k === 'sessionId' ? 's-1' : undefined), json: () => ({}) }, async () => { passed = true })
      expect(passed).toBe(true)
    } finally { t.restore() }
  })
  it('an empty or missing password is a 400', async () => {
    const t = await setup()
    try { expect((await t.mod.adminElevate(t.mkCtx(''))).status).toBe(400) } finally { t.restore() }
  })
})

// Cross-cutting infra round 5: a stolen admin token used to get unlimited password guesses here (the route sat on the
// generic `auth` limiter and never fed the sign-in lockout). Wrong passwords now count on the account lockout.
describe('adminElevate — brute-force protection', () => {
  const kvStore = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
  it('locks after repeated wrong passwords and then refuses even the right one; success clears the count', async () => {
    const t = await setup()
    try {
      const env = { JWT_SECRET: SECRET, ADMIN_STEP_UP_MINUTES: '10', RATE_LIMIT_KV: kvStore() }
      const ctx = pw => {
        const c = t.mkCtx(pw, env)
        c.get = k => (k === 'user' ? { id: 'a1', role: 'ADMIN', email: 'boss@example.com', lastLoginIp: '203.0.113.9' } : k === 'sessionId' ? 's-1' : undefined)
        c.req.header = h => (/^cf-connecting-ip$/i.test(h) ? '198.51.100.7' : undefined)
        return c
      }
      for (let i = 0; i < 3; i++) expect((await t.mod.adminElevate(ctx('nope'))).status).toBe(403)
      expect((await t.mod.adminElevate(ctx('correct horse'))).status).toBe(200)   // success resets the streak
      for (let i = 0; i < 8; i++) await t.mod.adminElevate(ctx('nope'))
      const locked = await t.mod.adminElevate(ctx('correct horse'))
      expect(locked.status).toBe(429)
    } finally { t.restore() }
  })
})
