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
