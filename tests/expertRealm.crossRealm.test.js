// Experts Phase 2A: (1) cross-realm rejection over EVERY route of the real app, both directions; (2) flag off = the existing app is unchanged
// (every route answers exactly as it did at the base commit; the snapshot in tests/fixtures was cut from that commit).
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')
const { enumerateApp } = require_('./helpers/enumerateRoutes.cjs')
const jwt = require_('../src/lib/jwt.js')
const bcrypt = require_('bcryptjs')

const EXP_ORIGIN = 'https://experts.example.test', API_ORIGIN = 'https://api.example.test'
const SNAP = new URL('./fixtures/expert-realm-flag-off-snapshot.json', import.meta.url)
const ENV = { EXPERT_REALM_ENABLED: 'true', EXPERT_REALM_SECRET: 'r'.repeat(40), JWT_SECRET: 'm'.repeat(40), EXPERT_JWT_SECRET: 'e'.repeat(40), EXPERT_SITE_URL: EXP_ORIGIN,
  EXPERTS_ENABLED: 'true', HUMAN_DEMAND_ENABLED: 'true', FRONTEND_URL: 'https://app.example.test' }
const OFF_ENV = { JWT_SECRET: 'm'.repeat(40), FRONTEND_URL: 'https://app.example.test' }     // what the app had before: no realm variables at all

let worker, w, routes
const state = { db: null }

beforeAll(async () => {
  w = createWorld({}); state.db = w.db
  const sbPath = require_.resolve('../src/config/supabase.js'); const real = require_('../src/config/supabase.js'); require_.cache[sbPath].exports = { ...real, getSupabase: () => state.db }
  const ecPath = require_.resolve('../src/middleware/envCheck.js'); require_('../src/middleware/envCheck.js'); const ec = async (c, next) => next(); ec.status = () => ({ configured: true, warnings: 0 }); ec.normalizeEnv = () => {}; ec._reset = () => {}; require_.cache[ecPath].exports = ec
  const rlPath = require_.resolve('../src/middleware/rateLimiter.js'); const rl = require_('../src/middleware/rateLimiter.js'); require_.cache[rlPath].exports = { ...rl, general: async (c, next) => next(), runOp: async () => ({ allowed: true, retryAfter: 1 }) }
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
  worker = (await import('../src/index.js')).default
  routes = enumerateApp()
}, 120000)

const send = (env, origin, r, { cookie, bearer } = {}) => worker.fetch(new Request(origin + r.path, { method: r.method, headers: { 'content-type': 'application/json', ...(r.method === 'GET' ? {} : { origin }),
  ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: r.method === 'GET' || r.method === 'HEAD' ? undefined : '{}' }), env, { waitUntil() {}, passThroughOnException() {} })
const statusOf = async (...a) => { try { return (await send(...a)).status } catch (_) { return 599 } }

async function realmCookies() {
  const sessions = require_('../src/services/expertSession.service.js'); const hash = bcrypt.hashSync('x', 4); const out = {}
  for (const [id, role] of [['exp', 'expert'], ['gra', 'grader'], ['adm', 'expert_admin'], ['sup', 'expert_support']]) {
    const acct = { id, email: `${id}@x.co`, password_hash: hash, display_first_name: id, display_initial: 'X', roles: [role], status: 'active', enabled: true, token_version: 0, totp_enabled_at: new Date().toISOString() }
    w.t.expert_accounts = [...(w.t.expert_accounts || []), acct]
    const { sessionId } = await sessions.createSession(ENV, w.db, acct, {}); out[role] = (await sessions.promote(ENV, w.db, acct, sessionId)).split(';')[0]
  }
  return out
}

describe('the route list is the whole app', () => {
  it('finds every mounted router (a new unparsable mount fails here) and is not vacuous', () => {
    expect(routes.length).toBeGreaterThan(200)
    for (const p of ['/api/auth', '/api/admin', '/api/payments', '/api/human', '/api/expert', '/api/expert-realm', '/api/expert-admin']) expect(routes.some(r => r.prefix === p), p).toBe(true)
  })
})

describe('cross-realm: a credential from one realm is worth nothing in the other', () => {
  it('every client and main-admin route: no expert, grader, expert_admin, expert_support or Phase 1 expert credential changes the answer', async () => {
    const cookies = await realmCookies(); const realmToken = Object.values(cookies)[0].split('=')[1]
    const phase1 = await jwt.sign({ sub: 'exp', aud: 'passthrough-experts', typ: 'expert', stage: 'full', tv: 0 }, ENV.EXPERT_JWT_SECRET, 3600)
    const creds = [...Object.entries(cookies).flatMap(([role, cookie]) => [[`${role} cookie`, { cookie }], [`${role} bearer`, { bearer: cookie.split('=')[1] }]]), ['phase1 expert bearer', { bearer: phase1 }], ['realm token as bearer', { bearer: realmToken }]]
    const main = routes.filter(r => !r.prefix.startsWith('/api/expert-')); const bad = []; let n = 0
    for (const r of main) {
      const anon = await statusOf(ENV, API_ORIGIN, r)
      for (const [label, c] of creds) { if (label === 'phase1 expert bearer' && r.prefix === '/api/expert') continue      // that IS the Phase 1 realm; the next test covers it
        const s = await statusOf(ENV, API_ORIGIN, r, c); n++
        if (!(s === anon || s === 401 || s === 403)) bad.push(`${r.method} ${r.path} anon=${anon} ${label}=${s}`) }
    }
    expect(bad).toEqual([]); expect(n).toBeGreaterThan(main.length * 8)
  }, 280000)

  it('every realm route: no main-user, main-admin, Phase 1 expert or forged credential changes the answer', async () => {
    const mainToken = await jwt.sign({ userId: 'u1', tokenVersion: 0 }, ENV.JWT_SECRET, 3600)
    const phase1 = await jwt.sign({ sub: 'exp', aud: 'passthrough-experts', typ: 'expert', stage: 'full', tv: 0 }, ENV.EXPERT_JWT_SECRET, 3600)
    const forged = await jwt.sign({ sub: 'adm', sid: 'x', tv: 0, aud: 'expert-realm' }, ENV.JWT_SECRET, 3600)         // right audience, the MAIN app's secret
    const forged2 = await jwt.sign({ sub: 'adm', sid: 'x', tv: 0, aud: 'expert-realm' }, ENV.EXPERT_JWT_SECRET, 3600)  // right audience, the Phase 1 secret
    w.t.users = [{ id: 'u1', email: 'a@b.co', is_admin: true, role: 'admin', token_version: 0 }]
    const creds = [['main bearer', { bearer: mainToken }], ['main token as realm cookie', { cookie: `__Host-pt_xr=${mainToken}` }], ['phase1 bearer', { bearer: phase1 }], ['phase1 token as cookie', { cookie: `__Host-pt_xr=${phase1}` }],
      ['forged with main secret', { cookie: `__Host-pt_xr=${forged}` }], ['forged with phase1 secret', { cookie: `__Host-pt_xr=${forged2}` }], ['forged as bearer', { bearer: forged }]]
    const realm = routes.filter(r => r.prefix.startsWith('/api/expert-')); const bad = []
    expect(realm.length).toBeGreaterThanOrEqual(23)
    for (const r of realm) {
      const anon = await statusOf(ENV, EXP_ORIGIN, r)
      for (const [label, c] of creds) { const s = await statusOf(ENV, EXP_ORIGIN, r, c); if (s !== anon) bad.push(`${r.method} ${r.path} anon=${anon} ${label}=${s}`) }
    }
    expect(bad).toEqual([])
  }, 280000)

  it('the Phase 1 expert routes reject every realm credential too', async () => {
    const cookies = await realmCookies(); const bad = []
    for (const r of routes.filter(r => r.prefix === '/api/expert')) for (const [role, cookie] of Object.entries(cookies)) {
      const anon = await statusOf(ENV, API_ORIGIN, r); const s = await statusOf(ENV, API_ORIGIN, r, { bearer: cookie.split('=')[1] }); if (s !== anon && ![401, 403].includes(s)) bad.push(`${r.path} ${role}`) }
    expect(bad).toEqual([])
  }, 120000)
})

describe('flag off: nothing in the existing app behaves differently', () => {
  it('every route answers as it did at the base commit (status and response shape), and the realm paths are the ordinary 404', async () => {
    const got = {}
    for (const r of routes) {
      const res = await send(OFF_ENV, API_ORIGIN, r).catch(() => null); const key = `${r.method} ${r.path}`
      if (!res) { got[key] = { status: 599 }; continue }
      let shape = null; try { const j = await res.clone().json(); shape = j && typeof j === 'object' ? Object.keys(j).sort() : typeof j } catch (_) { shape = 'non-json' }
      got[key] = { status: res.status, shape }
    }
    if (process.env.SNAPSHOT_OUT) { fs.writeFileSync(process.env.SNAPSHOT_OUT, JSON.stringify(got, null, 1)); return }
    const base = JSON.parse(fs.readFileSync(SNAP, 'utf8')); const diffs = []
    for (const k of Object.keys(base)) if (JSON.stringify(base[k]) !== JSON.stringify(got[k])) diffs.push(`${k}: base ${JSON.stringify(base[k])} now ${JSON.stringify(got[k])}`)
    for (const k of Object.keys(got)) if (!base[k] && !/\/api\/expert-(realm|admin)\//.test(k)) diffs.push(`${k}: new route`)
    expect(diffs).toEqual([]); expect(Object.keys(base).length).toBeGreaterThan(200)
    for (const k of Object.keys(got)) if (/\/api\/expert-(realm|admin)\//.test(k)) expect(got[k], k).toEqual({ status: 404, shape: ['message', 'success'] })
  }, 280000)
})
