import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Cross-cutting infra, independent audit round 1 — one test block per gap/bug closed.

const rl = require('../src/middleware/rateLimiter.js')
const errorHandler = require('../src/middleware/errorHandler.js')
const adminOnly = require('../src/middleware/adminOnly.js')
const upload = require('../src/middleware/upload.js')
const constants = require('../src/config/constants.js')

function kv() { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }

let realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr })

// ── B2 / B3: errorHandler ────────────────────────────────────────────────────
describe('errorHandler (B2, B3)', () => {
  const ctx = env => ({ env, req: { header: () => 'ray1' }, json: (body, status) => ({ body, status }) })
  it('B2: masks internals unless NODE_ENV is explicitly development or test — an UNSET NODE_ENV no longer leaks', () => {
    const err = new Error('relation "users" does not exist')
    expect(errorHandler(err, ctx({})).body.message).toBe('An error occurred.')
    expect(errorHandler(err, ctx({ NODE_ENV: 'staging' })).body.message).toBe('An error occurred.')
    expect(errorHandler(err, ctx({ NODE_ENV: 'production' })).body.message).toBe('An error occurred.')
    expect(errorHandler(err, ctx({ NODE_ENV: 'development' })).body.message).toBe('relation "users" does not exist')
    expect(errorHandler(err, ctx({ NODE_ENV: 'test' })).body.message).toBe('relation "users" does not exist')
  })
  it('B2: an exposed 4xx is still shown whatever NODE_ENV is', () => {
    const e = new Error('Request body too large.'); e.status = 413; e.expose = true
    expect(errorHandler(e, ctx({})).body.message).toBe('Request body too large.')
  })
  it('B2: does not crash when the context has no env at all', () => {
    expect(errorHandler(new Error('x'), { req: {}, json: (b, s) => ({ body: b, status: s }) }).status).toBe(500)
  })
  it('B3: a unique violation is answered 409 AND logged (it used to leave no trace)', () => {
    const spy = vi.fn(); console.error = spy
    const err = Object.assign(new Error('duplicate key value violates unique constraint "payments_pending_uniq"'), { code: '23505', details: 'Key (user_id)=(u1) already exists.' })
    const res = errorHandler(err, ctx({ NODE_ENV: 'production' }))
    expect(res).toMatchObject({ status: 409, body: { message: 'Already exists.' } })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0].join(' '))).toContain('payments_pending_uniq')
    expect(String(spy.mock.calls[0][0])).toContain('ray1')
  })
})

// ── G5: admin network allowlist ──────────────────────────────────────────────
describe('adminOnly ADMIN_ALLOWED_IPS (G5)', () => {
  const app = () => {
    const a = new Hono()
    a.use('*', async (c, next) => { c.set('user', { id: 'admin1', role: 'ADMIN' }); return next() })
    a.get('/x', adminOnly, c => c.json({ ok: true }))
    return a
  }
  const get = (env, ip) => app().request('/x', { headers: ip ? { 'cf-connecting-ip': ip } : {} }, env)
  it('is off when unset or blank — the previous behaviour', async () => {
    expect((await get({}, '9.9.9.9')).status).toBe(200)
    expect((await get({ ADMIN_ALLOWED_IPS: '  ' }, '9.9.9.9')).status).toBe(200)
  })
  it('lets a listed IP through and refuses every other network with a clear 403', async () => {
    const env = { ADMIN_ALLOWED_IPS: '1.2.3.4, 5.6.7.8' }
    expect((await get(env, '5.6.7.8')).status).toBe(200)
    const res = await get(env, '9.9.9.9')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.message).toMatch(/not allowed from this network/)
    expect(body.code).toBe('ADMIN_NETWORK_DENIED')   // the SPA keys off this: it must NOT bounce this admin away
  })
  it('compares IPv6 by /64, like every other per-IP bucket', async () => {
    const env = { ADMIN_ALLOWED_IPS: '2001:db8:1:2::1' }
    expect((await get(env, '2001:db8:1:2:aaaa:bbbb:cccc:dddd')).status).toBe(200)
    expect((await get(env, '2001:db8:1:3::1')).status).toBe(403)
  })
  it('a list that fails closed: a configured allowlist with an unknown caller IP refuses', async () => {
    expect((await get({ ADMIN_ALLOWED_IPS: '1.2.3.4' }, null)).status).toBe(403)
  })
  it('a non-admin is still refused first, allowlist or not', async () => {
    const a = new Hono()
    a.use('*', async (c, next) => { c.set('user', { id: 'u', role: 'SEEKER' }); return next() })
    a.get('/x', adminOnly, c => c.json({}))
    expect((await a.request('/x', { headers: { 'cf-connecting-ip': '1.2.3.4' } }, { ADMIN_ALLOWED_IPS: '1.2.3.4' })).status).toBe(403)
  })
})

// ── G6: anonymous scan allowance per device, per-IP ceiling ──────────────────
describe('anonScan device allowance (G6)', () => {
  const dev = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  function setup(handlerStatus = 200) {
    const app = new Hono()
    app.post('/scan', rl.anonScan, c => c.json({ ok: true }, handlerStatus))
    const env = { RATE_LIMIT_KV: kv() }
    const post = (ip, device) => app.request('/scan', { method: 'POST', headers: { 'cf-connecting-ip': ip, ...(device ? { 'x-device-id': device } : {}) } }, env)
    return { post, env }
  }
  it('without a device id nothing changes: one anonymous scan per hour per IP', async () => {
    const { post } = setup()
    expect((await post('1.1.1.1')).status).toBe(200)
    expect((await post('1.1.1.1')).status).toBe(429)
  })
  it('two visitors behind ONE carrier IP each get their scan when they identify a device', async () => {
    const { post } = setup()
    expect((await post('1.1.1.1', dev(1))).status).toBe(200)
    expect((await post('1.1.1.1', dev(2))).status).toBe(200)
  })
  it('the same device is still limited to ANON_SCANS_PER_HOUR', async () => {
    const { post } = setup()
    expect((await post('1.1.1.1', dev(1))).status).toBe(200)
    expect((await post('1.1.1.1', dev(1))).status).toBe(429)
    expect((await post('2.2.2.2', dev(1))).status).toBe(429)        // changing network does not reset a device's hour
  })
  it('rotating device ids is bounded by the per-IP ceiling', async () => {
    const { post } = setup()
    for (let i = 1; i <= constants.ANON_SCANS_PER_IP_PER_HOUR; i++) expect((await post('1.1.1.1', dev(i))).status).toBe(200)
    const res = await post('1.1.1.1', dev(999))
    expect(res.status).toBe(429)
    expect((await res.json()).message).toMatch(/Too many scans from this network/)
    expect((await post('3.3.3.3', dev(999))).status).toBe(200)      // another network is unaffected
  })
  it('a malformed device id is ignored — it falls back to the strict per-IP bucket', async () => {
    const { post } = setup()
    expect((await post('1.1.1.1', 'not-a-uuid')).status).toBe(200)
    expect((await post('1.1.1.1', 'also-bad')).status).toBe(429)
  })
  it('a failed request hands the device slot back, so the visitor can retry', async () => {
    const { post } = setup(400)
    expect((await post('1.1.1.1', dev(1))).status).toBe(400)
    expect((await post('1.1.1.1', dev(1))).status).toBe(400)         // not 429: the slot came back
  })
  it('anonScanSlotKey names the bucket that was actually spent, and refundAnonScanSlot accepts it', () => {
    const c = (device, ip = '1.1.1.1') => ({ env: {}, req: { header: n => ({ 'cf-connecting-ip': ip, 'x-device-id': device })[n.toLowerCase()] } })
    expect(rl.anonScanSlotKey(c(dev(5)))).toBe(`rl:anonscan:d:${dev(5)}|rl:anonscanip:1.1.1.1`)
    expect(rl.anonScanSlotKey(c(undefined))).toBe('rl:anonscan:1.1.1.1')
    expect(rl.anonScanSlotKey(c('junk'))).toBe('rl:anonscan:1.1.1.1')
  })
})

// ── B4: per-account budgets on routes behind auth ────────────────────────────
describe('per-account keys on resumeEdit / pdfRegen / draftDownload (B4)', () => {
  for (const [name, max] of [['resumeEdit', 15], ['pdfRegen', 8], ['draftDownload', 30]]) {
    it(`${name}: two signed-in users on one IP do not share a budget; anonymous callers still do`, async () => {
      const app = new Hono()
      app.use('*', async (c, next) => { const u = c.req.header('x-user'); if (u) c.set('user', { id: u }); return next() })
      app.get('/x', rl[name], c => c.json({ ok: true }))
      const env = { RATE_LIMIT_KV: kv() }
      const hit = u => app.request('/x', { headers: { 'cf-connecting-ip': '7.7.7.7', ...(u ? { 'x-user': u } : {}) } }, env)
      for (let i = 0; i < max; i++) expect((await hit('alice')).status).toBe(200)
      expect((await hit('alice')).status).toBe(429)
      expect((await hit('bob')).status).toBe(200)                       // same IP, own budget
      for (let i = 0; i < max - 1; i++) await hit(null)
      expect((await hit(null)).status).toBe(200)                         // anonymous: per-IP bucket, own count
      expect((await hit(null)).status).toBe(429)
    })
  }
})

// ── B7: filenames ────────────────────────────────────────────────────────────
describe('cleanFilename (B7)', () => {
  it('strips the invisible / line-break characters a plain control-character strip left behind', () => {
    expect(upload.cleanFilename('a\u061cb\u200bc\u200dd\u2060e\u2028f\u2029g.pdf')).toBe('abcdefg.pdf')
    expect(upload.cleanFilename('evil\u202Efdp.exe')).toBe('evilfdp.exe')
    expect(upload.cleanFilename('\u200b\u200c')).toBe('')
    expect(upload.cleanFilename('Résumé — 2026.pdf')).toBe('Résumé — 2026.pdf')   // real text is untouched
  })
})

// ── G3: schema version, cron heartbeat, health ───────────────────────────────
describe('schema version guard (G3)', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations')
  const files = fs.readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()
  const newest = files[files.length - 1]
  it('constants.EXPECTED_SCHEMA_VERSION equals the newest migration number', () => {
    expect(constants.EXPECTED_SCHEMA_VERSION, `newest migration is ${newest}: bump EXPECTED_SCHEMA_VERSION and end the migration with the system_state schema_version upsert (see 0059)`).toBe(Number(newest.slice(0, 4)))
  })
  it('the newest migration records that same number in system_state.schema_version', () => {
    const sql = fs.readFileSync(path.join(dir, newest), 'utf8')
    expect(sql).toMatch(/schema_version/)
    expect(Number(/'version',\s*(\d+)/.exec(sql)?.[1])).toBe(Number(newest.slice(0, 4)))
  })
})

describe('lib/health (G3)', () => {
  const health = require('../src/lib/health.js')
  const NOW = Date.parse('2026-10-08T12:00:00Z')
  const goodEnv = { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'production',
    RATE_LIMIT_DO: {}, RATE_LIMIT_KV: {}, RESUMES_BUCKET: {}, FIX_QUEUE: {}, BROWSER: {} }
  const dbWith = ({ version = constants.EXPECTED_SCHEMA_VERSION, heartbeatAt = '2026-10-08T11:30:00Z', error = null } = {}) =>
    createFakeSupabase(q => {
      if (q.table !== 'system_state' || q.op !== 'select') return undefined
      if (error) return { data: null, error: { message: error } }
      const key = eqValue(q, 'key')
      if (key === 'schema_version') return { data: version === null ? null : { value: { version }, updated_at: 't' }, error: null }
      if (key === 'cron_heartbeat') return { data: heartbeatAt ? { value: { at: heartbeatAt }, updated_at: 't' } : null, error: null }
      return { data: null, error: null }
    })
  it('is ok when the schema matches, the cron ran recently and the bindings exist', async () => {
    const h = await health.computeHealth(goodEnv, dbWith(), { nowMs: NOW })
    expect(h.ok).toBe(true); expect(h.problems).toEqual([])
    expect(h.cron).toMatchObject({ known: true, ageMinutes: 30, stale: false })
  })
  it('reports a database BEHIND the code', async () => {
    const h = await health.computeHealth(goodEnv, dbWith({ version: constants.EXPECTED_SCHEMA_VERSION - 1 }), { nowMs: NOW })
    expect(h.ok).toBe(false)
    expect(h.schema).toMatchObject({ ok: false, actual: constants.EXPECTED_SCHEMA_VERSION - 1 })
    expect(h.problems.join(' ')).toMatch(/schema/)
  })
  it('a missing system_state table reads as "migration 0059 not applied"', async () => {
    const h = await health.computeHealth(goodEnv, dbWith({ error: 'relation "system_state" does not exist' }), { nowMs: NOW })
    expect(h.schema.ok).toBe(false)
    expect(h.schema.detail).toMatch(/0059/)
    expect(h.db.ok).toBe(true)                                      // the table is missing, the database is not down
  })
  it('flags a cron that stopped (no run for over 150 minutes)', async () => {
    const h = await health.computeHealth(goodEnv, dbWith({ heartbeatAt: '2026-10-08T08:00:00Z' }), { nowMs: NOW })
    expect(h.cron).toMatchObject({ stale: true, ok: false, ageMinutes: 240 })
    expect(h.ok).toBe(false)
  })
  it('no heartbeat yet (fresh deploy) is reported but does not fail the check', async () => {
    const h = await health.computeHealth(goodEnv, dbWith({ heartbeatAt: null }), { nowMs: NOW })
    expect(h.cron).toMatchObject({ known: false, ok: true })
    expect(h.ok).toBe(true)
  })
  it('a missing required binding is a problem; the DO alone missing is not (KV fallback)', async () => {
    expect((await health.computeHealth({ ...goodEnv, FIX_QUEUE: undefined }, dbWith(), { nowMs: NOW })).ok).toBe(false)
    expect((await health.computeHealth({ ...goodEnv, RATE_LIMIT_DO: undefined }, dbWith(), { nowMs: NOW })).ok).toBe(true)
  })
  it('recordCronHeartbeat upserts the heartbeat row and never throws', async () => {
    const db = dbWith()
    expect(await health.recordCronHeartbeat(db, new Date(NOW))).toBe(true)
    const call = db.calls.find(q => q.op === 'upsert')
    expect(call.table).toBe('system_state')
    expect(call.values).toMatchObject({ key: 'cron_heartbeat', value: { at: '2026-10-08T12:00:00.000Z' } })
    const broken = createFakeSupabase(() => ({ data: null, error: { message: 'down' } }))
    expect(await health.recordCronHeartbeat(broken)).toBe(false)
  })
})

// ── G4: suppression honoured by send() ───────────────────────────────────────
describe('send() honours the suppression list (G4)', () => {
  let t
  afterEach(() => t?.restore())
  function setup({ suppressed = true, lookupError = false } = {}) {
    const sent = []
    const db = createFakeSupabase(q => {
      if (q.table === 'email_suppressions' && q.op === 'select')
        return lookupError ? { data: null, error: { message: 'down' } } : { data: suppressed ? { reason: 'bounce', created_at: 't' } : null, error: null }
      return undefined
    })
    const { mod, restore } = loadWithStubs('services/email.service.js', {
      'config/email.js': { sendViaResend: async (env, msg) => { sent.push(msg); return { id: 'x' } } },
      'config/supabase.js': { getSupabase: () => db },
    })
    return { mod, restore, sent, db, env: { FRONTEND_URL: 'https://passthrough.dev', EMAIL_FROM: 'P <h@p.dev>', RATE_LIMIT_KV: kv() } }
  }
  const logs = db => db.calls.filter(q => q.table === 'email_logs' && q.op === 'insert').map(q => q.values)
  it('skips non-security mail to a suppressed address, logs it as suppressed, and spends no throttle slot', async () => {
    t = setup()
    expect(await t.mod.sendWelcome(t.env, t.db, 'dead@example.com', 'D')).toBe(false)
    expect(t.sent).toHaveLength(0)
    expect(logs(t.db)[0]).toMatchObject({ template: 'welcome', status: 'suppressed' })
    expect([...t.env.RATE_LIMIT_KV.m.keys()].filter(k => k.startsWith('rl:mail'))).toEqual([])
  })
  it('still sends security and payment mail — a person must be able to reach their own account', async () => {
    t = setup()
    expect(await t.mod.sendPasswordReset(t.env, t.db, 'dead@example.com', 'D', 'tok')).toBe(true)
    expect(await t.mod.sendVerification(t.env, t.db, 'dead@example.com', 'D', 'tok')).toBe(true)
    expect(await t.mod.sendPasswordChanged(t.env, t.db, 'dead@example.com', 'D')).toBe(true)
    expect(t.sent).toHaveLength(3)
  })
  it('sends normally to an address that is not suppressed', async () => {
    t = setup({ suppressed: false })
    expect(await t.mod.sendWelcome(t.env, t.db, 'ok@example.com', 'O')).toBe(true)
  })
  it('FAILS OPEN: a lookup error never stops an email', async () => {
    t = setup({ lookupError: true })
    expect(await t.mod.sendWelcome(t.env, t.db, 'ok@example.com', 'O')).toBe(true)
  })
  it('lib/emailSuppression record / lift round-trip through the table by address hash', async () => {
    const sup = require('../src/lib/emailSuppression.js')
    const db = createFakeSupabase(q => q.op === 'delete' ? { data: [{ email_hash: 'h' }], error: null } : undefined)
    expect(await sup.recordSuppression(db, ' Dead@Example.com ', 'complaint')).toBe(true)
    const up = db.calls.find(q => q.op === 'upsert')
    expect(up.values).toMatchObject({ reason: 'complaint' })
    expect(up.values.email_hash).toBe(await require('../src/lib/crypto.js').sha256('dead@example.com'))
    expect(await sup.liftSuppression(db, 'DEAD@example.com')).toBe(true)
    expect(eqValue(db.calls.find(q => q.op === 'delete'), 'email_hash')).toBe(up.values.email_hash)
  })
})

// ── B5 / B8: email service ───────────────────────────────────────────────────
describe('email service (B5, B8)', () => {
  let t
  afterEach(() => t?.restore())
  function setup() {
    const sent = []; const flags = { fail: false }
    const db = createFakeSupabase()
    const { mod, restore } = loadWithStubs('services/email.service.js', {
      'config/email.js': { sendViaResend: async (env, msg) => { if (flags.fail) throw new Error('Resend down'); sent.push(msg); return { id: 'x' } } },
      'config/supabase.js': { getSupabase: () => db },
    })
    return { mod, restore, sent, flags, db, env: { FRONTEND_URL: 'https://passthrough.dev', EMAIL_FROM: 'P <h@p.dev>', OWNER_ALERT_EMAIL: 'owner@example.com', RATE_LIMIT_KV: kv() } }
  }
  it('B5: a FAILED alert send gives its dedupe slot back, so the next occurrence still emails', async () => {
    t = setup()
    t.flags.fail = true
    expect(await t.mod.sendOwnerAlert(t.env, 'Queue job failed', 'boom')).toBe(false)
    t.flags.fail = false
    expect(await t.mod.sendOwnerAlert(t.env, 'Queue job failed', 'boom again')).toBe(true)   // was silenced for 10 minutes before
    expect(await t.mod.sendOwnerAlert(t.env, 'Queue job failed', 'third')).toBe(false)        // a SUCCESSFUL send still dedupes
    expect(t.sent).toHaveLength(1)
  })
  it('G2 (round 4): with ALERT_WEBHOOK_URL set, an alert still reaches the owner when Resend is down', async () => {
    t = setup()
    t.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/x'
    const hooks = []; const realFetch = global.fetch
    global.fetch = async (u, init) => { hooks.push(JSON.parse(init.body)); return new Response('ok', { status: 200 }) }
    try {
      t.flags.fail = true
      expect(await t.mod.sendOwnerAlert(t.env, 'Queue job failed', 'boom')).toBe(false)   // email did not go...
      expect(hooks).toHaveLength(1)                                                       // ...the webhook did
      expect(hooks[0].subject).toBe('Queue job failed')
      t.flags.fail = false
      await t.mod.sendOwnerAlert(t.env, 'Queue job failed', 'boom')
      expect(hooks).toHaveLength(1)   // the dedupe window now holds (the slot was spent by the delivered webhook)
    } finally { global.fetch = realFetch }
  })
  it('B8: a rejection reason always ends in punctuation before the fixed sentence', async () => {
    t = setup()
    await t.mod.sendPartnerApplicationRejected(t.env, t.db, 'p@x.co', 'P', 'Not enough audience')
    await t.mod.sendPartnerApplicationRejected(t.env, t.db, 'p2@x.co', 'P', 'Too early!')
    await t.mod.sendPartnerApplicationRejected(t.env, t.db, 'p3@x.co', 'P', '')
    const texts = t.sent.map(m => m.text)
    expect(texts[0]).toContain("right now. Not enough audience. You're welcome to apply again after 30 days.")
    expect(texts[1]).toContain('Too early! You\'re welcome')
    expect(texts[2]).toContain("right now. You're welcome to apply again")
  })
  it('B8: payout, commission and reversal mails format money like receipts do', async () => {
    t = setup()
    await t.mod.sendPayoutSent(t.env, t.db, 'a@x.co', 'A', 4550, 'USD')
    await t.mod.sendPartnerCommissionReversed(t.env, t.db, 'b@x.co', 'B', 1250, 'USD', 'https://x')
    await t.mod.sendPartnerConversionEarned(t.env, t.db, 'c@x.co', 'C', 'CODE', 900, 'USD', 'https://x')
    expect(t.sent[0].text).toContain('$45.50')
    expect(t.sent[1].text).toContain('$12.50')
    expect(t.sent[2].text).toContain('$9')
    expect(t.sent.map(m => m.text).join(' ')).not.toMatch(/\d\.\d\d USD/)
  })
})

// ── G1: Browser Rendering launch retry ───────────────────────────────────────
describe('pdf.service launch retry (G1)', () => {
  let t
  afterEach(() => t?.restore())
  function setup(launchOutcomes) {
    let n = 0; const calls = []
    const page = { setJavaScriptEnabled: async () => {}, setDefaultNavigationTimeout: async () => {}, setContent: async () => {}, emulateMediaType: async () => {}, pdf: async () => Buffer.from('pdf'), close: async () => {} }
    const browser = { newPage: async () => page, close: async () => { calls.push('browser.close') } }
    const launch = async () => { calls.push('launch'); const o = launchOutcomes[Math.min(n++, launchOutcomes.length - 1)]; if (o instanceof Error) throw o; return browser }
    const { mod, restore } = loadWithStubs('services/pdf.service.js', { '@cloudflare/puppeteer': { launch } })
    return { mod, restore, calls }
  }
  const limit = () => new Error('Unable to create new browser: code: 429: message: Too many concurrent browsers')
  it('retries a launch refused for being over the concurrency limit, then renders', async () => {
    t = setup([limit(), limit(), 'ok'])
    const buf = await t.mod.generateResumePDF({ BROWSER: {} }, '<html/>', { launchRetryDelaysMs: [0, 0, 0] })
    expect(buf.toString()).toBe('pdf')
    expect(t.calls.filter(c => c === 'launch')).toHaveLength(3)
  })
  it('gives up after the retries are used (and says why)', async () => {
    t = setup([limit()])
    await expect(t.mod.generateResumePDF({ BROWSER: {} }, '<html/>', { launchRetryDelaysMs: [0, 0] })).rejects.toThrow(/429/)
    expect(t.calls.filter(c => c === 'launch')).toHaveLength(3)
  })
  it('does NOT retry an error that is not a limit — it would fail the same way', async () => {
    t = setup([new Error('Browser binding is not configured')])
    await expect(t.mod.generateResumePDF({ BROWSER: {} }, '<html/>', { launchRetryDelaysMs: [0, 0] })).rejects.toThrow(/binding/)
    expect(t.calls.filter(c => c === 'launch')).toHaveLength(1)
  })
  it('isLaunchLimitError recognises the refusals and not unrelated failures', () => {
    t = setup(['ok'])
    const { isLaunchLimitError } = t.mod
    for (const m of ['429 Too Many Requests', 'Rate limit exceeded', 'concurrent browser limit reached', 'over capacity']) expect(isLaunchLimitError(new Error(m))).toBe(true)
    for (const m of ['Navigation timeout', 'net::ERR_FAILED', 'binding missing']) expect(isLaunchLimitError(new Error(m))).toBe(false)
  })
})

// ── G1 / config wiring ───────────────────────────────────────────────────────
describe('wrangler.toml / deploy docs wiring (G1, G2, B1)', () => {
  const root = path.join(__dirname, '..')
  const toml = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8')
  const doc = fs.readFileSync(path.join(root, 'DEPLOYMENT.md'), 'utf8')
  it('the fix-queue consumer is concurrency-capped', () => {
    const block = toml.slice(toml.indexOf('queue              = "passthrough-fix-jobs"\nmax_batch_size'))
    expect(block).toMatch(/max_concurrency\s*=\s*\d+/)
  })
  it('DEPLOYMENT.md tells the operator to create both queues before the first deploy', () => {
    expect(doc).toMatch(/wrangler queues create passthrough-fix-jobs\b/)
    expect(doc).toMatch(/wrangler queues create passthrough-fix-jobs-dlq/)
  })
  it('DEPLOYMENT.md no longer claims RATE_LIMIT_BYPASS_IPS is ignored in production (the code honours it)', () => {
    expect(doc).not.toMatch(/ignored in production/i)
    expect(doc).toMatch(/RATE_LIMIT_BYPASS_IPS[\s\S]{0,400}production/i)
  })
  it('the pre-launch verification section pdf.service points to exists', () => {
    expect(doc).toMatch(/Pre-launch verification/)
  })
  it('the cron comment and the scheduled export agree on the number of jobs', () => {
    const idx = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8')
    const calls = (idx.match(/^\s{4}(?:return )?\w+Sweep\(event, env, ctx\)|^\s{4}scheduled\(event, env, ctx\)/gm) || []).length
    expect(calls).toBe(10)
    expect(toml).toMatch(/ten scheduled jobs/)
  })
})
