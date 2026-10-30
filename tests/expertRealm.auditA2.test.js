// AUDIT A2 regression tests (realm pipeline and permission matrix). Harness copied from expertRealm.phase2a.test.js.
// (original header) Experts Phase 2A: the expert realm's HTTP behaviour: gating, sign-in, two-factor, recovery codes, lockout, rate limits, session limits,
// revoke-all, password reset, the permission matrix (generated from the table), step-up, reasons, job reads, the refund bridge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')
const { Hono } = require_('hono')
const bcrypt = require_('bcryptjs')
const totp = require_('../src/lib/totp.js')

const ORIGIN = 'https://experts.example.test'
const ENV = { EXPERT_REALM_ENABLED: 'true', EXPERT_REALM_SECRET: 'r'.repeat(40), JWT_SECRET: 'm'.repeat(40), EXPERT_JWT_SECRET: 'e'.repeat(40), EXPERT_SITE_URL: ORIGIN, EXPERT_EMAIL_FROM: 'x@experts.example.test' }
const PASSWORD = 'correct horse battery staple 1'
const JOB = '00000000-0000-4000-8000-0000000000b1', JOB_OTHER = '00000000-0000-4000-8000-0000000000b2'
const ROLE_OF = { exp: 'expert', gra: 'grader', adm: 'expert_admin', sup: 'expert_support' }
const sent = []        // reset emails
let w, t, app, sessions, perms, cfg, rlHits, queued

function seed() {
  const hash = bcrypt.hashSync(PASSWORD, 4)
  const acct = (id, role, extra = {}) => ({ id, email: `${id}@example.com`, password_hash: hash, display_first_name: id, display_initial: 'X', roles: [role], status: 'active', enabled: true,
    token_version: 0, totp_enabled_at: new Date().toISOString(), totp_secret_enc: `sealed:${totp.newSecret()}`, totp_last_step: null, failed_logins: 0, locked_until: null, ...extra })
  return { expert_accounts: [acct('exp', 'expert'), acct('exp2', 'expert'), acct('gra', 'grader'), acct('adm', 'expert_admin'), acct('sup', 'expert_support'), acct('new', 'expert', { totp_enabled_at: null, totp_secret_enc: null })],
    human_jobs: [{ id: JOB, job_number: 'HJ-1', state: 'in_progress', tier: 'forty_eight_hour', version: 3, expert_id: 'exp', payment_id: 'pay1', price_cents: 11900, expert_pay_cents: 7000, paid_at: '2026-10-01T00:00:00Z' },
      { id: JOB_OTHER, job_number: 'HJ-2', state: 'in_progress', tier: 'polish', version: 1, expert_id: 'exp2', payment_id: 'pay2', price_cents: 5000, expert_pay_cents: 2000 }],
    payments: [{ id: 'pay1', amount_cents: 11900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'ref-1', product_kind: 'human_forty_eight_hour', user_id: 'u1' }, { id: 'pay2', amount_cents: 4900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'ref-2', product_kind: null, user_id: 'u1' }],
    system_state: [{ key: 'human_pilot', value: { prices: { polish: 49, seven_day: 99, forty_eight_hour: 119, twenty_four_hour: 149, cover_letter: 19 }, pay: { polish: 20, seven_day: 50, forty_eight_hour: 70, twenty_four_hour: 90, cover_letter: 8 },
      tiers_enabled: { polish: true, seven_day: true, forty_eight_hour: true, twenty_four_hour: false }, pilot_cap_orders: 10, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3, concurrent_cap: 2, turnaround_hours: { forty_eight_hour: 48, polish: 24 }, internal_buffer_hours: {} } }] }
}

beforeEach(async () => {
  w = createWorld(seed()); w.unique.expert_bridge_calls = [['fn', 'idem_key']]; w.unique.expert_password_resets = [['token_hash']]
  rlHits = new Map(); queued = []; sent.length = 0
  w.rpcs.human_job_expert_read = args => (args.p_expert === 'exp' && args.p_job === JOB
    ? { data: { job: { id: JOB, job_number: 'HJ-1', state: 'in_progress', tier: 'forty_eight_hour', version: 3, promised_deadline_at: '2026-10-03T00:00:00Z', brief: { jobPosting: 'Company: Acme Corp\nAcme Corp builds things. Role at Acme Corp.' } } }, error: null }
    : { data: null, error: null })
  t = loadWithStubs('routes/expert-realm.routes.js', {
    'config/supabase.js': { getSupabase: () => w.db },
    'middleware/rateLimiter.js': { clientIp: () => '203.0.113.9', rateKeyIp: ip => ip, isBypassed: () => false,
      runOp: async (_e, _op, { key, max }) => { const n = (rlHits.get(key) || 0) + 1; rlHits.set(key, n); return { allowed: n <= max, retryAfter: 60 } } },
    'lib/fieldCrypto.js': { isSealed: s => String(s).startsWith('sealed:'), sealTaxId: async (_e, p) => `sealed:${p}`, openTaxId: async (_e, s) => String(s).replace('sealed:', '') },
    'lib/pwned.js': { isPwnedPassword: async p => p === 'password1234!' },
    'services/refund.service.js': { queueRefund: async (_e, _s, payment, o) => { queued.push({ payment: payment.id, ...o }); return { ok: true, amountCents: o.amountCents ?? payment.amount_cents, partial: false, queued: true } } },
    'config/email.js': { sendViaResend: async (_e, m) => { sent.push(m) } },
  })
  app = new Hono(); app.route('/api/expert-realm', t.mod.realm); app.route('/api/expert-admin', t.mod.admin)
  app.notFound(c => c.json({ success: false, message: 'Not found.' }, 404))
  sessions = require_('../src/services/expertSession.service.js'); perms = require_('../src/lib/expertRealm/permissions.js'); cfg = require_('../src/lib/expertRealm/config.js'); cfg.resetSettingsCache()
})
afterEach(() => { t.restore(); vi.useRealTimers() })

const call = (method, path, { cookie, body, env = ENV, headers = {} } = {}) => app.request(ORIGIN + path, { method, headers: { 'content-type': 'application/json', ...(method === 'GET' ? {} : { origin: ORIGIN }), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }, env)
const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0]
const row = id => w.t.expert_accounts.find(a => a.id === id)
const codeFor = (id, drift = 0) => { const s = row(id).totp_secret_enc.replace('sealed:', ''); return totp.hotp(s, totp.stepOf(Date.now()) + drift).then(c => String(c).padStart(6, '0')) }

// a signed-in session for an account, made by the real session service (skips the UI flow)
async function sessionFor(id) {
  const acct = row(id); const { sessionId, cookie } = await sessions.createSession(ENV, w.db, acct, { ip: '1.1.1.1', userAgent: 'test' })
  const full = await sessions.promote(ENV, w.db, acct, sessionId); return full.split(';')[0]
}
async function signInFlow(id) {                       // the real flow: password then second factor
  const login = await call('POST', '/api/expert-realm/auth/login', { body: { email: `${id}@example.com`, password: PASSWORD } })
  const pending = cookieOf(login); row(id).totp_last_step = null
  const mfa = await call('POST', '/api/expert-realm/auth/totp', { cookie: pending, body: { code: await codeFor(id) } })
  return { login, mfa, cookie: cookieOf(mfa) }
}
const elevated = async (cookie) => { const r = await call('POST', '/api/expert-realm/auth/step-up', { cookie, body: { password: PASSWORD } }); expect(r.status).toBe(200) }
const allRoutes = () => [...perms.routesOf('realm'), ...perms.routesOf('admin')].map(r => ({ ...r, url: `${r.realm === 'admin' ? '/api/expert-admin' : '/api/expert-realm'}${r.path.replace(':id', JOB)}` }))


const JOB3 = '00000000-0000-4000-8000-0000000000b3'
const addHumanJob3 = () => {
  w.t.human_jobs.push({ id: JOB3, job_number: 'HJ-3', state: 'in_progress', tier: 'polish', version: 1, expert_id: 'exp2', payment_id: 'pay3', price_cents: 5000, expert_pay_cents: 2000 })
  w.t.payments.push({ id: 'pay3', amount_cents: 4900, currency: 'USD', status: 'SUCCESS', paystack_ref: 'ref-3', product_kind: 'human_polish', user_id: 'u2' })
}
const refund = (cookie, job, body) => call('POST', `/api/expert-admin/jobs/${job}/refund`, { cookie, body })

describe('A2 G1: the expert host serves only the realm', () => {
  const guard = require_('../src/middleware/expertHostGuard.js')
  const mk = env => { const a = new Hono(); a.use('*', guard); a.all('*', c => c.json({ reached: true })); a.notFound(c => c.json({ nf: true }, 404)); return p => a.request(p, { method: 'GET' }, env) }
  it('main-app paths on the expert host are the ordinary 404; realm paths and other hosts pass', async () => {
    const req = mk(ENV)
    for (const p of ['/api/pricing', '/api/admin/users', '/api/auth/login', '/api/webhooks/paystack', '/api/expert/auth/login', '/api/human/checkout', '/healthz', '/api/expert-realmx/me', '/api/expert-realm-evil'])
      expect((await req(ORIGIN + p)).status, p).toBe(404)
    for (const p of ['/api/expert-realm/me', '/api/expert-realm', '/api/expert-admin/board']) expect((await req(ORIGIN + p)).status, p).toBe(200)
    expect((await req('https://api.example.test/api/pricing')).status).toBe(200)
    expect((await req('https://api.example.test/api/expert-realm/me')).status).toBe(200)       // (the realm's own gate refuses that one)
  })
  it('does nothing while EXPERT_SITE_URL is unset (every deployment before 2A)', async () => {
    const req = mk({ ...ENV, EXPERT_SITE_URL: undefined }); expect((await req(ORIGIN + '/api/pricing')).status).toBe(200)
  })
  it('applies whether or not the realm flag is on, and a capitalised setting still matches', async () => {
    expect((await mk({ ...ENV, EXPERT_REALM_ENABLED: undefined })(ORIGIN + '/api/pricing')).status).toBe(404)
    expect((await mk({ ...ENV, EXPERT_SITE_URL: 'https://Experts.Example.Test:443' })(ORIGIN + '/api/pricing')).status).toBe(404)
  })
  it('is mounted app-wide, ahead of the envCheck / limiter / auth middleware', () => {
    const idx = require_('node:fs').readFileSync(require_('node:path').resolve(__dirname, '../src/index.js'), 'utf8')
    const at = s => idx.indexOf(s); expect(at("app.use('*', expertHostGuard)")).toBeGreaterThan(at("app.use('*', corsMiddleware)")); expect(at("app.use('*', expertHostGuard)")).toBeLessThan(at("app.use('/api/*', envCheck)"))
  })
})

describe('A2 G2: the registry is binding', () => {
  it('every route the two routers actually serve is in the registry with the same policy, and nothing registered is unmounted', () => {
    for (const [name, router] of [['realm', t.mod.realm], ['admin', t.mod.admin]]) {
      const served = router.routes.filter(r => r.method !== 'ALL').map(r => `${r.method} ${r.path}`).sort()
      const declared = perms.routesOf(name).map(r => `${r.method} ${r.path}`).sort()
      expect([...new Set(served)], name).toEqual(declared)
    }
  })
  it('define() adds the guards itself: an action route gets session + limiter + matrix check; a pending route a session; public none', () => {
    const got = {}; const fake = { get: (p, ...h) => { got[p] = h.length }, post: (p, ...h) => { got[p] = h.length } }; const h = () => {}
    perms.define(fake, 'x', 'get', '/a1', { action: 'board.view' }, h); perms.define(fake, 'x', 'post', '/a2', { auth: 'pending' }, h); perms.define(fake, 'x', 'post', '/a3', { auth: 'public' }, h); perms.define(fake, 'x', 'get', '/a4', { auth: 'session' }, h)
    expect(got).toEqual({ '/a1': 4, '/a2': 2, '/a3': 1, '/a4': 2 })
  })
  it('refuses a handler-less route, an unknown auth kind, and the same route declared with a different policy', () => {
    const fake = { get() {} }; const h = () => {}
    expect(() => perms.define(fake, 'x', 'get', '/b1', { action: 'board.view' })).toThrow(/no handler/); expect(() => perms.define(fake, 'x', 'get', '/b2', { auth: 'whatever' }, h)).toThrow(/unknown auth/)
    perms.define(fake, 'x', 'get', '/b3', { action: 'board.view' }, h); expect(() => perms.define(fake, 'x', 'get', '/b3', { action: 'audit.view' }, h)).toThrow(/different policy/); perms.define(fake, 'x', 'get', '/b3', { action: 'board.view' }, h)
  })
})

describe('A2 G3: scope is used', () => {
  const S = require_('../src/lib/expertRealm/scope.js')
  it('jobAccess: own for the assigned account; any only for metadata, never for content; nothing without a grant', () => {
    const acct = { id: 'a' }, mine = { expert_id: 'a' }, other = { expert_id: 'b' }
    expect(S.jobAccess(perms.can(['expert'], 'job.view_full'), acct, mine, { content: true })).toEqual({ allowed: true, via: 'own' })
    expect(S.jobAccess(perms.can(['expert'], 'job.view_full'), acct, other).allowed).toBe(false)
    expect(S.jobAccess(perms.can(['expert_admin'], 'job.view_full'), acct, other)).toEqual({ allowed: true, via: 'any' })
    expect(S.jobAccess(perms.can(['expert_admin'], 'job.view_full'), acct, other, { content: true }).allowed).toBe(false)
    expect(S.jobAccess(perms.can(['expert_support'], 'job.view_full'), acct, { expert_id: null }, { content: true }).allowed).toBe(false)
    expect(S.jobAccess({ allowed: false }, acct, mine).allowed).toBe(false); expect(S.jobAccess(null, acct, mine).allowed).toBe(false)
  })
  it('the brief route reads the grant: the owner reads, the admin and a second expert do not', async () => {
    expect((await call('GET', `/api/expert-realm/jobs/${JOB}/brief`, { cookie: await sessionFor('exp') })).status).toBe(200)
    expect((await call('GET', `/api/expert-realm/jobs/${JOB}/brief`, { cookie: await sessionFor('adm') })).status).toBe(403)
    expect((await call('GET', `/api/expert-realm/jobs/${JOB}/brief`, { cookie: await sessionFor('exp2') })).status).toBe(403)
  })
})

describe('A2 G4: board paging and assignment against a version', () => {
  it('a full page carries nextBefore; a marker returns only older jobs; a bad marker is a 400', async () => {
    w.t.human_jobs.find(j => j.id === JOB).created_at = '2026-10-02T00:00:00.000Z'; w.t.human_jobs.find(j => j.id === JOB_OTHER).created_at = '2026-10-01T00:00:00.000Z'
    const cookie = await sessionFor('adm')
    const p1 = await (await call('GET', '/api/expert-admin/board?limit=2', { cookie })).json(); expect(p1.data.nextBefore).toBe('2026-10-01T00:00:00.000Z')
    const p2 = await (await call('GET', `/api/expert-admin/board?before=${p1.data.nextBefore}`, { cookie })).json(); expect(p2.data.jobs).toHaveLength(0); expect(p2.data.nextBefore).toBeNull()
    const p3 = await (await call('GET', '/api/expert-admin/board?before=2026-10-01T12:00:00.000Z', { cookie })).json(); expect(p3.data.jobs.map(j => j.id)).toEqual([JOB_OTHER])
    expect((await call('GET', '/api/expert-admin/board?before=banana', { cookie })).status).toBe(400)
  })
  it('expectedVersion reaches the engine; a stale one is a 409 VERSION_CONFLICT', async () => {
    const seen = []; w.rpcs.human_job_transition = a => { seen.push(a); return a.p_expected_version === 3 ? { data: { ok: true, state: 'claimed', version: 4, event_id: 1 }, error: null } : { data: { ok: false, code: 'VERSION_CONFLICT', state: 'in_progress' }, error: null } }
    const cookie = await sessionFor('adm'); const E = '00000000-0000-4000-8000-0000000000e2'
    expect((await call('POST', `/api/expert-admin/jobs/${JOB}/reassign`, { cookie, body: { expertId: E, reason: 'expert unavailable', expectedVersion: 3 } })).status).toBe(200); expect(seen[0].p_expected_version).toBe(3)
    const stale = await call('POST', `/api/expert-admin/jobs/${JOB}/reassign`, { cookie, body: { expertId: E, reason: 'expert unavailable', expectedVersion: 2 } }); expect(stale.status).toBe(409); expect((await stale.json()).code).toBe('VERSION_CONFLICT')
    expect((await call('POST', `/api/expert-admin/jobs/${JOB}/reassign`, { cookie, body: { expertId: E, reason: 'expert unavailable', expectedVersion: 'x' } })).status).toBe(400)
  })
})

describe('A2 B1/B2: a refund key is one request', () => {
  it('the same key on a DIFFERENT job is refused (409 KEY_REUSED), queues nothing, and is not logged as queued', async () => {
    addHumanJob3(); const cookie = await sessionFor('adm'); await elevated(cookie)
    expect((await refund(cookie, JOB, { reason: 'first customer', idemKey: 'refund-key-0001' })).status).toBe(200)
    const b = await refund(cookie, JOB3, { reason: 'second customer', idemKey: 'refund-key-0001' }); expect(b.status).toBe(409); expect((await b.json()).code).toBe('KEY_REUSED')
    expect(queued.map(q => q.payment)).toEqual(['pay1']); expect(w.t.expert_audit_log.filter(r => r.action === 'money.refund_queued').map(r => r.target_id)).toEqual([JOB])
  })
  it('the same key and amount on the same job still replays ok; a different amount is refused', async () => {
    const cookie = await sessionFor('adm'); await elevated(cookie)
    await refund(cookie, JOB, { reason: 'first customer', idemKey: 'refund-key-0002', amountCents: 500 })
    const again = await (await refund(cookie, JOB, { reason: 'first customer', idemKey: 'refund-key-0002', amountCents: 500 })).json(); expect(again.data.replay).toBe(true); expect(queued).toHaveLength(1)
    expect((await refund(cookie, JOB, { reason: 'first customer', idemKey: 'refund-key-0002', amountCents: 900 })).status).toBe(409)
  })
  it('a key whose first attempt never finished says so with a 409 (not a 200 "Not possible: null"); a refused one replays as a refusal', async () => {
    const cookie = await sessionFor('adm'); await elevated(cookie)
    w.t.expert_bridge_calls = [{ id: 1, fn: 'refund_human_order', job_id: JOB, actor_id: 'adm', idem_key: 'stuck-key-0001', amount_cents: null, outcome: 'started', code: null },
      { id: 2, fn: 'refund_human_order', job_id: JOB, actor_id: 'adm', idem_key: 'refused-key-01', amount_cents: null, outcome: 'refused', code: 'ALREADY_REFUNDED' }]
    const s = await refund(cookie, JOB, { reason: 'retry after crash', idemKey: 'stuck-key-0001' }); expect(s.status).toBe(409); const sj = await s.json(); expect(sj.code).toBe('UNFINISHED'); expect(sj.message).not.toMatch(/null/)
    const r = await refund(cookie, JOB, { reason: 'try again please', idemKey: 'refused-key-01' }); expect(r.status).toBe(409); expect((await r.json()).code).toBe('ALREADY_REFUNDED'); expect(queued).toHaveLength(0)
  })
})

describe('A2 B3: denied and read attempts are limited before they are audited', () => {
  it('a signed-in expert hitting the console 150 times gets 120 audited denials, then 429s; audit rows stop at the limit', async () => {
    const cookie = await sessionFor('exp'); const codes = []
    for (let i = 0; i < 150; i++) codes.push((await call('GET', '/api/expert-admin/board', { cookie })).status)
    expect(codes.filter(s => s === 403)).toHaveLength(120); expect(codes.filter(s => s === 429)).toHaveLength(30); expect(w.t.expert_audit_log.filter(r => r.action === 'realm.denied')).toHaveLength(120)
  })
  it('brief reads (own or someone else\'s) and the desk are limited per account too', async () => {
    const cookie = await sessionFor('exp'); const codes = []
    for (let i = 0; i < 130; i++) codes.push((await call('GET', `/api/expert-realm/jobs/${JOB_OTHER}/brief`, { cookie })).status)
    expect(codes.filter(s => s === 429).length).toBe(10); expect(w.t.expert_audit_log.filter(r => r.action === 'job.read_denied')).toHaveLength(120)
    expect((await call('GET', '/api/expert-realm/desk', { cookie })).status).toBe(429)       // same bucket
  })
})

describe('A2 B4/B5: a failed read is a 503, not a verdict', () => {
  it('brief: a database error on the job lookup is 503, with no denied-read row', async () => {
    const cookie = await sessionFor('exp'); w.failNext('human_jobs', 'select', { message: 'connection reset' })
    const r = await call('GET', `/api/expert-realm/jobs/${JOB}/brief`, { cookie }); expect(r.status).toBe(503); expect((w.t.expert_audit_log || []).filter(x => x.action === 'job.read_denied')).toHaveLength(0)
  })
  it('job detail: a failed job, events or next-action read is a 503; healthy is unchanged', async () => {
    const cookie = await sessionFor('adm')
    for (const table of ['human_jobs', 'job_events', 'job_next_actions']) { w.failNext(table, 'select', { message: 'timeout' }); expect((await call('GET', `/api/expert-admin/jobs/${JOB}`, { cookie })).status, table).toBe(503) }
    const ok = await call('GET', `/api/expert-admin/jobs/${JOB}`, { cookie }); expect(ok.status).toBe(200); expect((await ok.json()).data.eventsTruncated).toBe(false)
  })
  it('a job with more events than the cap says the clock check is unknown instead of guessing', async () => {
    w.t.job_events = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, job_id: JOB, kind: 'note', actor_kind: 'system', created_at: '2026-10-01T00:00:00Z', detail: {} }))
    const d = (await (await call('GET', `/api/expert-admin/jobs/${JOB}`, { cookie: await sessionFor('adm') })).json()).data; expect(d.eventsTruncated).toBe(true); expect(d.clockMatchesStored).toBeNull()
  })
})

describe('A2 B6: the site origin is what a browser sends', () => {
  it('capitals, a default port and a trailing slash all reduce to the same origin; junk is null', () => {
    for (const v of ['https://Experts.Example.Test', 'https://experts.example.test:443', 'https://experts.example.test/', 'https://experts.example.test/app']) expect(cfg.siteOrigin({ EXPERT_SITE_URL: v }), v).toBe('https://experts.example.test')
    for (const v of ['experts.example.test', 'ftp://x.test', '', undefined]) expect(cfg.siteOrigin({ EXPERT_SITE_URL: v }), String(v)).toBeNull()
  })
  it('a login POST from the real origin works whichever way the setting is spelled', async () => {
    for (const url of ['https://Experts.Example.Test', 'https://experts.example.test:443']) {
      const res = await app.request(ORIGIN + '/api/expert-realm/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ email: 'exp@example.com', password: PASSWORD }) }, { ...ENV, EXPERT_SITE_URL: url })
      expect(res.status, url).toBe(200)
    }
  })
})

describe('A2 B7: an oversized body is a 413, not "reason missing"', () => {
  it('requireAction passes the 413 up', async () => {
    const mw = require_('../src/middleware/expertRealm.js'); const ctx = { get: k => (k === 'xr' ? { roles: ['expert_admin'], account: { id: 'adm' }, session: {} } : undefined), set() {}, env: ENV, req: { method: 'POST', json: async () => { throw Object.assign(new Error('Request body too large.'), { status: 413 }) } } }
    await expect(mw.requireAction('job.assign')(ctx, async () => {})).rejects.toMatchObject({ status: 413 })
  })
})
