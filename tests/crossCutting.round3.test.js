// Cross-cutting infra, round 3 (section 9). One describe per fix; each asserts the behaviour that was wrong.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import errorHandler from '../src/middleware/errorHandler.js'
import normalizeThrown from '../src/middleware/normalizeThrown.js'
import * as rl from '../src/middleware/rateLimiter.js'
import { rateKeyIp, isIpLiteral, parseIpList } from '../src/lib/clientIp.js'
import { checkSchema, checkCron, computeHealth, BASELINE_KEY, CRON_STALE_MINUTES } from '../src/lib/health.js'
import { validateEnv } from '../src/lib/env.js'
import adminOnly from '../src/middleware/adminOnly.js'
import { isPrivateIPv6 } from '../src/lib/ssrfGuard.js'
import constants from '../src/config/constants.js'

const quiet = () => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) }
afterEach(() => { vi.restoreAllMocks() })

// ── B1: anonymous-scan ceiling is only spent on requests the device bucket admitted ─────────────────────────
describe('anonScan: the per-IP ceiling is not burned by requests the device bucket refuses (B1)', () => {
  const dev = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  function harness() {
    const mem = new Map()
    const env = { RATE_LIMIT_KV: { get: async k => mem.get(k) ?? null, put: async (k, v) => { mem.set(k, v) }, delete: async k => { mem.delete(k) } }, NODE_ENV: 'development' }
    let mode = 'ok'
    const app = new Hono()
    app.use('*', async (c, next) => { if (c.req.header('x-user')) c.set('user', { id: 'u1' }); await next() })
    app.post('/scan', rl.anonScan, async c => {
      if (mode === 'throw') throw new Error('db down')
      if (mode === 'bad') return c.json({ success: false }, 415)
      return c.json({ success: true })
    })
    app.onError(errorHandler)
    const hit = async (ip, device, user) => {
      const h = { 'x-forwarded-for': ip }
      if (device) h['x-device-id'] = device
      if (user) h['x-user'] = '1'
      return (await app.fetch(new Request('http://x/scan', { method: 'POST', headers: h }), env)).status
    }
    return { mem, hit, setMode: m => { mode = m } }
  }
  const count = (mem, key) => JSON.parse(mem.get(key)).count

  it('a device re-submitting 30 times after its scan leaves the ceiling at one slot, and other devices still get in', async () => {
    const { hit, mem } = harness()
    expect(await hit('7.7.7.7', dev(1))).toBe(200)
    for (let i = 0; i < 30; i++) expect(await hit('7.7.7.7', dev(1))).toBe(429)
    expect(count(mem, 'rl:anonscanip:7.7.7.7')).toBe(1)
    expect(await hit('7.7.7.7', dev(2))).toBe(200)
  })
  it('still bounds device-id rotation: ten devices per IP per hour, the eleventh is refused', async () => {
    const { hit } = harness()
    const out = []
    for (let i = 1; i <= 12; i++) out.push(await hit('7.7.7.7', dev(i)))
    expect(out).toEqual([...Array(10).fill(200), 429, 429])
  })
  it('a device the ceiling refused gets its own slot handed back, so it can retry once the network frees up', async () => {
    const { hit, mem } = harness()
    for (let i = 1; i <= 10; i++) await hit('7.7.7.7', dev(i))
    expect(await hit('7.7.7.7', dev(11))).toBe(429)
    expect(count(mem, `rl:anonscan:d:${dev(11)}`)).toBe(0)
  })
  it('without a device id it is still one scan per IP per hour, and failures still refund', async () => {
    const { hit, setMode } = harness()
    setMode('bad'); expect(await hit('9.9.9.9')).toBe(415); expect(await hit('9.9.9.9')).toBe(415)
    setMode('ok');  expect(await hit('9.9.9.9')).toBe(200); expect(await hit('9.9.9.9')).toBe(429)
  })
  it('a thrown handler error refunds both buckets and still reaches errorHandler as a 500', async () => {
    quiet()
    const { hit, setMode, mem } = harness()
    setMode('throw')
    expect(await hit('7.7.7.7', dev(1))).toBe(500)
    expect(count(mem, `rl:anonscan:d:${dev(1)}`)).toBe(0)
    expect(count(mem, 'rl:anonscanip:7.7.7.7')).toBe(0)
  })
  it('a signed-in caller skips both', async () => {
    const { hit } = harness()
    for (let i = 0; i < 15; i++) expect(await hit('7.7.7.7', dev(1), true)).toBe(200)
  })
})

// ── B2: a database ahead of the code is not an outage ───────────────────────────────────────────────────────
describe('health: schema version ahead of the code is a note, not a failure (B2)', () => {
  const E = constants.EXPECTED_SCHEMA_VERSION
  const stateDb = (rows = {}) => ({
    rows,
    from() {
      const q = { _k: null }
      q.select = () => q
      q.eq = (_c, k) => { q._k = k; return q }
      q.maybeSingle = async () => ({ data: rows[q._k] ? { value: rows[q._k], updated_at: 'x' } : null })
      q.upsert = async (row, opts) => { if (!(opts && opts.ignoreDuplicates && rows[row.key])) rows[row.key] = row.value; return { error: null } }
      q.limit = async () => ({ data: [], error: null })
      return q
    },
  })
  it('behind: not ok, and says how far', async () => {
    const r = await checkSchema(stateDb({ schema_version: { version: E - 1 } }))
    expect(r).toMatchObject({ ok: false, ahead: false, actual: E - 1 })
    expect(r.detail).toMatch(/apply every migration above/)
  })
  it('equal: ok, no detail', async () => {
    expect(await checkSchema(stateDb({ schema_version: { version: E } }))).toMatchObject({ ok: true, ahead: false, detail: null })
  })
  it('ahead: ok, flagged ahead, with an explanation instead of a bare failure', async () => {
    const r = await checkSchema(stateDb({ schema_version: { version: E + 1 } }))
    expect(r).toMatchObject({ ok: true, ahead: true, actual: E + 1 })
    expect(r.detail).toMatch(/ahead of this code/)
  })
  it('unreadable / unrecorded stays a failure', async () => {
    expect(await checkSchema(stateDb({}))).toMatchObject({ ok: false, actual: null })
  })
  it('computeHealth is ok when ahead, and carries the explanation as a note', async () => {
    const db = stateDb({ schema_version: { version: E + 2 }, cron_heartbeat: { at: new Date().toISOString() } })
    const env = { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', JWT_SECRET: 'x'.repeat(40), RESUMES_BUCKET: {}, FIX_QUEUE: {}, RATE_LIMIT_DO: {}, RATE_LIMIT_KV: {} }
    const h = await computeHealth(env, db)
    expect(h.ok).toBe(true)
    expect(h.problems).toEqual([])
    expect(h.notes.join(' ')).toMatch(/ahead/)
  })
})

// ── G1: a cron that never ran is noticed ────────────────────────────────────────────────────────────────────
describe('health: a cron that has NEVER run is detected (G1)', () => {
  const mk = () => {
    const rows = {}
    return { rows, from: () => { const q = {}; q.select = () => q; q.eq = (_c, k) => { q._k = k; return q }
      q.maybeSingle = async () => ({ data: rows[q._k] ? { value: rows[q._k] } : null })
      q.upsert = async (row, opts) => { if (!(opts && opts.ignoreDuplicates && rows[row.key])) rows[row.key] = row.value; return { error: null } }
      return q } }
  }
  const T0 = Date.parse('2026-10-09T00:00:00Z')
  it('the first look records a baseline and reports ok', async () => {
    const db = mk()
    const r = await checkCron(db, T0)
    expect(r).toMatchObject({ known: false, ok: true })
    expect(db.rows[BASELINE_KEY].at).toBe(new Date(T0).toISOString())
  })
  it('still ok inside the window, and the baseline is not moved by later looks', async () => {
    const db = mk()
    await checkCron(db, T0)
    const r = await checkCron(db, T0 + 100 * 60000)
    expect(r.ok).toBe(true)
    expect(db.rows[BASELINE_KEY].at).toBe(new Date(T0).toISOString())
  })
  it('past the stale window with no heartbeat ever, it fails and says why', async () => {
    const db = mk()
    await checkCron(db, T0)
    const r = await checkCron(db, T0 + (CRON_STALE_MINUTES + 5) * 60000)
    expect(r).toMatchObject({ ok: false, stale: true, known: false })
    expect(r.detail).toMatch(/no cron heartbeat has ever been recorded/)
  })
  it('a heartbeat, once written, wins over the baseline', async () => {
    const db = mk()
    await checkCron(db, T0)
    db.rows.cron_heartbeat = { at: new Date(T0 + 200 * 60000).toISOString() }
    expect(await checkCron(db, T0 + 220 * 60000)).toMatchObject({ known: true, ok: true })
  })
  it('never throws when the database cannot even store the baseline', async () => {
    const broken = { from: () => { throw new Error('db down') } }
    expect(await checkCron(broken, T0)).toMatchObject({ ok: true })
  })
})

// ── B3: IPv6 bucketing ─────────────────────────────────────────────────────────────────────────────────────
describe('rateKeyIp: IPv4-mapped IPv6 in either spelling is the IPv4 client (B3)', () => {
  it('hex and dotted spellings agree, and neither shares ::1\'s bucket', () => {
    expect(rateKeyIp('::ffff:102:304')).toBe('1.2.3.4')
    expect(rateKeyIp('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(rateKeyIp('0:0:0:0:0:ffff:a00:1')).toBe('10.0.0.1')
    expect(rateKeyIp('::ffff:a00:1')).not.toBe(rateKeyIp('::1'))
    expect(rateKeyIp('::ffff:a00:1', 48)).toBe('10.0.0.1')
  })
  it('an IPv6 with a dotted tail still collapses to its /64, and /48 still works', () => {
    expect(rateKeyIp('64:ff9b::1.2.3.4')).toBe('0064:ff9b:0000:0000::/64')
    expect(rateKeyIp('2001:db8:1:2:3:4:5:6', 48)).toBe('2001:0db8:0001::/48')
  })
  it('malformed input is its own bucket instead of being mangled into a shared one', () => {
    expect(rateKeyIp('1::2::3')).toBe('1::2::3')
    expect(rateKeyIp('2001:db8:1:2:3:4:5:6:7')).toBe('2001:db8:1:2:3:4:5:6:7')
  })
  it('unchanged behaviour: IPv4, unknown and empty', () => {
    expect(rateKeyIp('203.0.113.9')).toBe('203.0.113.9')
    expect(rateKeyIp('')).toBe('unknown')
    expect(rateKeyIp(undefined)).toBe('unknown')
  })
})

describe('isIpLiteral / parseIpList', () => {
  it('accepts addresses, rejects ranges and junk', () => {
    for (const ok of ['1.2.3.4', '::1', '2001:db8::1', '[2001:db8::1]', '::ffff:1.2.3.4']) expect(isIpLiteral(ok)).toBe(true)
    for (const bad of ['1.2.3.0/24', '999.1.1.1', 'localhost', '', '1.2.3', '2001:db8::/32', 'a::b::c']) expect(isIpLiteral(bad)).toBe(false)
  })
  it('splits a list', () => {
    expect(parseIpList('1.2.3.4, 10.0.0.0/8 ,nope,::1')).toEqual({ valid: ['1.2.3.4', '::1'], invalid: ['10.0.0.0/8', 'nope'] })
  })
})

// ── G3: configuration the Worker can be silently wrong about ────────────────────────────────────────────────
describe('validateEnv: silent misconfigurations are named (G3)', () => {
  const base = { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y', JWT_SECRET: 'a'.repeat(40), NODE_ENV: 'production', FRONTEND_URL: 'https://x.dev' }
  const warn = env => validateEnv({ ...base, ...env }).warnings
  it('missing OWNER_ALERT_EMAIL and PAYSTACK_CALLBACK_URL are warned about', () => {
    const w = warn({}).join('\n')
    expect(w).toMatch(/OWNER_ALERT_EMAIL is not set/)
    expect(w).toMatch(/PAYSTACK_CALLBACK_URL is not set/)
    const set = warn({ OWNER_ALERT_EMAIL: 'me@x.dev', PAYSTACK_CALLBACK_URL: 'https://x.dev/payment/success' }).join('\n')
    expect(set).not.toMatch(/OWNER_ALERT_EMAIL|PAYSTACK_CALLBACK_URL/)
  })
  it('a valid CIDR entry is accepted silently; an all-invalid list says every admin is locked out', () => {
    expect(warn({ ADMIN_ALLOWED_IPS: '203.0.113.0/24' }).join('\n')).not.toMatch(/ADMIN_ALLOWED_IPS/)
    const w = warn({ ADMIN_ALLOWED_IPS: '203.0.113.0/99' }).join('\n')
    expect(w).toMatch(/203\.0\.113\.0\/99/)
    expect(w).toMatch(/EVERY admin request is refused/)
  })
  it('one bad entry beside a good one warns but does not claim a lockout', () => {
    const w = warn({ ADMIN_ALLOWED_IPS: '1.2.3.4, typo' }).join('\n')
    expect(w).toMatch(/typo/)
    expect(w).not.toMatch(/EVERY admin request/)
  })
  it('a clean list and an unset list are silent', () => {
    expect(warn({ ADMIN_ALLOWED_IPS: '1.2.3.4,2001:db8::1' }).join('\n')).not.toMatch(/ADMIN_ALLOWED_IPS/)
    expect(warn({}).join('\n')).not.toMatch(/ADMIN_ALLOWED_IPS/)
  })
})

describe('adminOnly: the allow-list only matches real addresses (G3)', () => {
  const allowed = adminOnly.adminIpAllowed
  it('exact, mapped and /64 matches still work', () => {
    expect(allowed({ ADMIN_ALLOWED_IPS: '1.2.3.4' }, '1.2.3.4')).toBe(true)
    expect(allowed({ ADMIN_ALLOWED_IPS: '::ffff:1.2.3.4' }, '1.2.3.4')).toBe(true)
    expect(allowed({ ADMIN_ALLOWED_IPS: '2001:db8:1:2::1' }, '2001:db8:1:2:ffff::9')).toBe(true)
    expect(allowed({ ADMIN_ALLOWED_IPS: '1.2.3.4' }, '1.2.3.5')).toBe(false)
  })
  it('a CIDR entry matches its range (round 4) and unset allows all', () => {
    expect(allowed({ ADMIN_ALLOWED_IPS: '1.2.3.0/24' }, '1.2.3.4')).toBe(true)
    expect(allowed({ ADMIN_ALLOWED_IPS: '1.2.3.0/24' }, '1.2.4.4')).toBe(false)
    expect(allowed({ ADMIN_ALLOWED_IPS: '' }, 'unknown')).toBe(true)
    expect(allowed({}, 'unknown')).toBe(true)
  })
})

// ── G2: transient infrastructure failures are retryable 503s ────────────────────────────────────────────────
describe('errorHandler: transient infrastructure failures answer 503 + Retry-After (G2)', () => {
  const run = async thrown => {
    quiet()
    const app = new Hono()
    app.use('*', normalizeThrown)
    app.get('/x', () => { throw thrown })
    app.onError(errorHandler)
    const r = await app.fetch(new Request('http://x/x'), { NODE_ENV: 'production' })
    return { status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json() }
  }
  it.each([
    ['a Supabase timeout', { message: 'TimeoutError: The operation was aborted due to timeout', details: '', hint: '', code: '' }],
    ['an aborted fetch', Object.assign(new Error('AbortError: This operation was aborted'), { name: 'AbortError' })],
    ['fetch failed', { message: 'TypeError: fetch failed' }],
    ['workerd dropping the connection', new Error('Network connection lost.')],
    ['a deadlock', { code: '40P01', message: 'deadlock detected' }],
    ['a serialization failure', { code: '40001', message: 'could not serialize access' }],
    ['a statement timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['PostgREST schema cache loading', { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' }],
    ['PostgREST pool timeout', { code: 'PGRST003', message: 'Timed out acquiring connection from the connection pool.' }],
    ['the rate-limiter DO', new Error('rate limiter DO timed out after 3000ms')],
  ])('%s', async (_n, thrown) => {
    const r = await run(thrown)
    expect(r.status).toBe(503)
    expect(r.retryAfter).toBe('5')
    expect(r.body).toEqual({ success: false, message: 'Temporarily unavailable. Please try again in a moment.' })
  })
  it.each([
    ['an ordinary bug', new Error('x is not a function')],
    ['an invalid uuid (a client mistake path, not transient)', { code: '22P02', message: 'invalid input syntax for type uuid' }],
    ['an upstream status copied onto an error', Object.assign(new Error('Resend API error (503): down'), { status: 503 })],
  ])('stays a masked 500: %s', async (_n, thrown) => {
    const r = await run(thrown)
    expect(r.status).toBe(500)
    expect(r.retryAfter).toBeNull()
    expect(r.body.message).toBe('An error occurred.')
  })
  it('an error that opts in with expose keeps its own answer even if its text sounds transient', async () => {
    const e = Object.assign(new Error('fetch failed: nope'), { status: 422, expose: true })
    const r = await run(e)
    expect(r.status).toBe(422)
  })
  it('a unique violation is still a 409', async () => {
    expect((await run({ code: '23505', message: 'dup' })).status).toBe(409)
  })
})

// ── G4: a stuck Durable Object, and an alert that does not flood during an outage ───────────────────────────
describe('rate limiter: a Durable Object that never answers fails open instead of hanging (G4)', () => {
  const hangingNs = () => ({ idFromName: n => n, get: () => ({ fetch: () => new Promise(() => {}) }) })
  const slowNs = (ms, body) => ({ idFromName: n => n, get: () => ({ fetch: () => new Promise(r => setTimeout(() => r(Response.json(body)), ms)) }) })

  it('runOp rejects after the timeout instead of waiting forever', async () => {
    const env = { RATE_LIMIT_DO: hangingNs(), RATE_LIMIT_DO_TIMEOUT_MS: '25' }
    const t0 = Date.now()
    await expect(rl.runOp(env, 'consume', { key: 'k', windowSeconds: 60, max: 5 })).rejects.toThrow(/timed out after 25ms/)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it('a normal answer inside the timeout is returned', async () => {
    const env = { RATE_LIMIT_DO: slowNs(5, { allowed: true, retryAfter: 0 }), RATE_LIMIT_DO_TIMEOUT_MS: '500' }
    expect(await rl.runOp(env, 'consume', { key: 'k', windowSeconds: 60, max: 5 })).toEqual({ allowed: true, retryAfter: 0 })
  })
  it('hitQuota fails open and tryHitQuota says the backend could not answer', async () => {
    quiet()
    const env = { RATE_LIMIT_DO: hangingNs(), RATE_LIMIT_DO_TIMEOUT_MS: '20' }
    expect(await rl.hitQuota(env, 'rl:x:y', 1, 60)).toBe(true)
    expect(await rl.tryHitQuota(env, 'rl:x:y', 1, 60)).toBeNull()
  })
  it('tryHitQuota reports real answers as booleans', async () => {
    const mem = new Map()
    const env = { RATE_LIMIT_KV: { get: async k => mem.get(k) ?? null, put: async (k, v) => { mem.set(k, v) }, delete: async () => {} } }
    expect(await rl.tryHitQuota(env, 'rl:x:y', 1, 60)).toBe(true)
    expect(await rl.tryHitQuota(env, 'rl:x:y', 1, 60)).toBe(false)
  })
  it('the default and override are sane', () => {
    expect(rl.doTimeoutMs({})).toBe(rl.DEFAULT_DO_TIMEOUT_MS)
    expect(rl.doTimeoutMs({ RATE_LIMIT_DO_TIMEOUT_MS: '750' })).toBe(750)
    expect(rl.doTimeoutMs({ RATE_LIMIT_DO_TIMEOUT_MS: 'junk' })).toBe(rl.DEFAULT_DO_TIMEOUT_MS)
  })
  it('a limiter on a hung DO lets the request through', async () => {
    quiet()
    const app = new Hono()
    app.use('*', rl.auth)
    app.get('/x', c => c.json({ ok: true }))
    const env = { RATE_LIMIT_DO: hangingNs(), RATE_LIMIT_DO_TIMEOUT_MS: '20' }
    const r = await app.fetch(new Request('http://x/x', { headers: { 'cf-connecting-ip': '1.1.1.1' } }), env)
    expect(r.status).toBe(200)
  })
})

describe('sendOwnerAlert: de-dupe survives a backend outage (G4)', () => {
  let t
  afterEach(() => t?.restore())
  function load({ tryHit, alertLogs = [] } = {}) {
    const sent = []
    const inserted = []
    const db = {
      from: () => {
        const q = { filters: [] }
        q.insert = async row => { inserted.push(row); return { error: null } }
        q.select = () => q
        q.eq = () => q; q.gte = () => q
        q.limit = async () => ({ data: alertLogs, error: null })
        return q
      },
    }
    t = loadWithStubs('services/email.service.js', {
      'config/email.js': { sendViaResend: async (_e, msg) => { sent.push(msg); return {} } },
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { hitQuota: async () => true, refundQuota: async () => {}, tryHitQuota: tryHit },
    })
    return { svc: t.mod, sent, inserted }
  }
  const env = { OWNER_ALERT_EMAIL: 'owner@x.dev', EMAIL_FROM: 'a@x.dev' }

  it('healthy backend: the quota decides (allowed -> emailed, refused -> not)', async () => {
    const { svc, sent } = load({ tryHit: async () => true })
    expect(await svc.sendOwnerAlert(env, 'S1', 'm')).toBe(true)
    const r = load({ tryHit: async () => false })
    expect(await r.svc.sendOwnerAlert(env, 'S2', 'm')).toBe(false)
    expect(sent.length).toBe(1)
  })
  it('backend down: the SAME alert is emailed once per isolate, not once per occurrence', async () => {
    quiet()
    const { svc, sent, inserted } = load({ tryHit: async () => null })
    const results = []
    for (let i = 0; i < 6; i++) results.push(await svc.sendOwnerAlert(env, 'DB is down', 'same message'))
    expect(results).toEqual([true, false, false, false, false, false])
    expect(sent.length).toBe(1)
    expect(inserted.length).toBe(6)   // every occurrence is still recorded in alert_logs
  })
  it('backend down: a DIFFERENT alert is not swallowed by the first', async () => {
    quiet()
    const { svc, sent } = load({ tryHit: async () => null })
    await svc.sendOwnerAlert(env, 'DB is down', 'a')
    await svc.sendOwnerAlert(env, 'Queue job failed: runAtsScan', 'scanId: 1')
    expect(sent.length).toBe(2)
  })
  it('backend down + another isolate already emailed it (alert_logs says so): not emailed again', async () => {
    quiet()
    const { svc, sent } = load({ tryHit: async () => null, alertLogs: [{ created_at: new Date().toISOString() }] })
    expect(await svc.sendOwnerAlert(env, 'DB is down', 'm')).toBe(false)
    expect(sent.length).toBe(0)
  })
  it('no OWNER_ALERT_EMAIL: nothing emailed, still logged', async () => {
    const { svc, sent, inserted } = load({ tryHit: async () => true })
    expect(await svc.sendOwnerAlert({ EMAIL_FROM: 'a@x.dev' }, 'S', 'm')).toBe(false)
    expect(sent.length).toBe(0)
    expect(inserted.length).toBe(1)
  })
})

// ── Hardening ──────────────────────────────────────────────────────────────────────────────────────────────
describe('ssrfGuard: special-purpose IPv6 blocks are refused', () => {
  it.each(['100::1', '2001:1::1', '2001:2::1', '2001:10::1', '2001:20::1', '3fff::1', '2001:db8::1', '2002:7f00:1::', '::1', 'fe80::1', 'fd00::1'])('%s is private', ip => {
    expect(isPrivateIPv6(ip)).toBe(true)
  })
  it.each(['2606:4700::1111', '2a00:1450:4001:81b::200e', '2001:4860:4860::8888', '2620:fe::fe'])('%s (a real public address) is not', ip => {
    expect(isPrivateIPv6(ip)).toBe(false)
  })
})
