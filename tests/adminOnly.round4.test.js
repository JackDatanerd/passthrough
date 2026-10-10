import { describe, it, expect } from 'vitest'
import adminOnly from '../src/middleware/adminOnly.js'
import jwtLib from '../src/lib/jwt.js'
import { parseIpAllowList, ipAllowed, parseCidr } from '../src/lib/clientIp.js'
import { validateEnv } from '../src/lib/env.js'

const SECRET = 's'.repeat(40)
const mk = ({ env = {}, user = { id: 'a1', role: 'ADMIN' }, ip = '1.2.3.4', headers = {}, store = {} } = {}) => ({
  env: { JWT_SECRET: SECRET, NODE_ENV: 'production', ...env },
  req: { header: h => (h === 'cf-connecting-ip' ? ip : headers[h]) },
  get: k => (k === 'user' ? user : store[k]), set: () => {},
  json: (body, status) => ({ body, status }),
})
const run = async (mw, c) => { let passed = false; const res = await mw(c, async () => { passed = true }); return { passed, res } }

describe('ADMIN_ALLOWED_IPS — CIDR ranges (G1)', () => {
  const allowed = (list, ip) => adminOnly.adminIpAllowed({ ADMIN_ALLOWED_IPS: list }, ip)
  it('matches IPv4 ranges and single addresses', () => {
    expect(allowed('203.0.113.0/24', '203.0.113.200')).toBe(true)
    expect(allowed('203.0.113.0/24', '203.0.114.1')).toBe(false)
    expect(allowed('10.0.0.0/8, 1.2.3.4', '1.2.3.4')).toBe(true)
    expect(allowed('1.2.3.4', '1.2.3.5')).toBe(false)
    expect(allowed('1.2.3.4/32', '1.2.3.4')).toBe(true)
  })
  it('matches IPv6 ranges; a bare IPv6 address still means its /64', () => {
    expect(allowed('2001:db8:abcd::/48', '2001:db8:abcd:7::9')).toBe(true)
    expect(allowed('2001:db8:abcd::/48', '2001:db8:abce::1')).toBe(false)
    expect(allowed('2001:db8::1', '2001:db8::99')).toBe(true)
    expect(allowed('2001:db8::1', '2001:db8:0:1::1')).toBe(false)
  })
  it('an IPv4-mapped IPv6 client matches an IPv4 range', () => {
    expect(allowed('203.0.113.0/24', '::ffff:203.0.113.5')).toBe(true)
  })
  it('refuses /0, bad lengths and garbage; unusable-only list refuses everyone', () => {
    expect(parseCidr('0.0.0.0/0')).toBeNull()
    expect(parseCidr('1.2.3.4/33')).toBeNull()
    expect(parseCidr('nope/8')).toBeNull()
    expect(parseIpAllowList('1.2.3.0/24,bad').invalid).toEqual(['bad'])
    expect(allowed('bad', '1.2.3.4')).toBe(false)
    expect(allowed('', '9.9.9.9')).toBe(true)
  })
  it('env validation warns about unusable entries but not CIDR', () => {
    const base = { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', JWT_SECRET: SECRET, NODE_ENV: 'production' }
    const w = validateEnv({ ...base, ADMIN_ALLOWED_IPS: '10.0.0.0/8,oops' }).warnings.join('\n')
    expect(w).toMatch(/oops/)
    expect(w).not.toMatch(/10\.0\.0\.0\/8/)
  })
})

describe('admin session age cap (G1)', () => {
  const H = 3600 * 1000
  it('refuses an admin whose SESSION is older than the cap (default 24h) with a 401 the SPA treats as sign-out', async () => {
    const { passed, res } = await run(adminOnly, mk({ store: { sessionCreatedAtMs: Date.now() - 25 * H } }))
    expect(passed).toBe(false)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('ADMIN_SESSION_EXPIRED')
  })
  it('lets a young session, a token with no session, and a disabled cap through', async () => {
    expect((await run(adminOnly, mk({ store: { sessionCreatedAtMs: Date.now() - 2 * H } }))).passed).toBe(true)
    expect((await run(adminOnly, mk())).passed).toBe(true)
    expect((await run(adminOnly, mk({ env: { ADMIN_SESSION_MAX_HOURS: '0' }, store: { sessionCreatedAtMs: 1 } }))).passed).toBe(true)
  })
  it('honours a custom cap', async () => {
    expect((await run(adminOnly, mk({ env: { ADMIN_SESSION_MAX_HOURS: '2' }, store: { sessionCreatedAtMs: Date.now() - 3 * H } }))).passed).toBe(false)
  })
})

describe('step-up (G1)', () => {
  const env = { ADMIN_STEP_UP_MINUTES: '10' }
  it('is a no-op when disabled (default)', async () => {
    expect((await run(adminOnly.stepUp, mk())).passed).toBe(true)
  })
  it('refuses without an elevation token, with the code the SPA reacts to', async () => {
    const { passed, res } = await run(adminOnly.stepUp, mk({ env }))
    expect(passed).toBe(false)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ADMIN_STEP_UP_REQUIRED')
  })
  it('accepts a token minted for this user and session; rejects another user, another session, a bearer JWT and garbage', async () => {
    const user = { id: 'a1', role: 'ADMIN' }
    const mint = async (u, sid) => (await adminOnly.mintElevation({ ...env, JWT_SECRET: SECRET }, u, sid)).token
    const good = await mint(user, 's-1')
    expect((await run(adminOnly.stepUp, mk({ env, headers: { 'X-Admin-Elevation': good }, store: { sessionId: 's-1' } }))).passed).toBe(true)
    expect((await run(adminOnly.stepUp, mk({ env, headers: { 'X-Admin-Elevation': good }, store: { sessionId: 's-2' } }))).passed).toBe(false)
    expect((await run(adminOnly.stepUp, mk({ env, user: { id: 'b2', role: 'ADMIN' }, headers: { 'X-Admin-Elevation': good }, store: { sessionId: 's-1' } }))).passed).toBe(false)
    const bearer = await jwtLib.sign({ userId: 'a1', tokenVersion: 0, sid: 's-1' }, SECRET, 600)
    expect((await run(adminOnly.stepUp, mk({ env, headers: { 'X-Admin-Elevation': bearer }, store: { sessionId: 's-1' } }))).passed).toBe(false)
    expect((await run(adminOnly.stepUp, mk({ env, headers: { 'X-Admin-Elevation': 'junk' }, store: { sessionId: 's-1' } }))).passed).toBe(false)
  })
})
