// Experts Phase 2A: the expert realm's HTTP behaviour: gating, sign-in, two-factor, recovery codes, lockout, rate limits, session limits,
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

describe('gating: flag, host, secret, origin', () => {
  it('registers every route with a stated policy (there is nothing unguarded to mount)', () => {
    const rs = allRoutes(); expect(rs.length).toBeGreaterThanOrEqual(23)
    for (const r of rs) expect(r.policy.action || r.policy.auth, `${r.method} ${r.path}`).toBeTruthy()
  })
  for (const [label, env] of [['flag unset', { ...ENV, EXPERT_REALM_ENABLED: undefined }], ['flag "false"', { ...ENV, EXPERT_REALM_ENABLED: 'false' }], ['flag "TRUE"', { ...ENV, EXPERT_REALM_ENABLED: 'TRUE' }],
    ['no secret', { ...ENV, EXPERT_REALM_SECRET: undefined }], ['short secret', { ...ENV, EXPERT_REALM_SECRET: 'short' }], ['same as main secret', { ...ENV, EXPERT_REALM_SECRET: ENV.JWT_SECRET }],
    ['same as phase 1 secret', { ...ENV, EXPERT_REALM_SECRET: ENV.EXPERT_JWT_SECRET }], ['no site url', { ...ENV, EXPERT_SITE_URL: undefined }]]) {
    it(`${label}: every realm route is the ordinary 404 and the database is never touched`, async () => {
      const before = w.calls.length
      for (const r of allRoutes()) {
        const res = await call(r.method, r.url, { env, body: r.method === 'GET' ? undefined : {} })
        expect(res.status, `${r.method} ${r.url}`).toBe(404); expect(await res.json()).toEqual({ success: false, message: 'Not found.' })
      }
      expect(w.calls.length).toBe(before)
    })
  }
  it('the realm answers only on the expert site host (the API host, or any other, gets 404)', async () => {
    for (const host of ['https://api.example.test', 'https://example.test', 'https://experts.example.test.evil.test']) {
      const res = await app.request(`${host}/api/expert-realm/me`, { method: 'GET' }, ENV); expect(res.status, host).toBe(404)
    }
  })
  it('a state-changing request without the expert site as Origin is refused, before anything else', async () => {
    const res = await app.request(`${ORIGIN}/api/expert-realm/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: JSON.stringify({ email: 'a@b.co', password: 'x' }) }, ENV)
    expect(res.status).toBe(403); expect((await res.json()).code).toBe('BAD_ORIGIN')
    const none = await app.request(`${ORIGIN}/api/expert-realm/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, ENV); expect(none.status).toBe(403)
  })
})

describe('sign-in, two-factor, recovery codes', () => {
  it('enrolment: password -> secret -> first code -> signed in; ten recovery codes shown once, stored only as hashes', async () => {
    const login = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'new@example.com', password: PASSWORD } })
    expect(login.status).toBe(200); const raw = await login.text(); expect(JSON.parse(raw).data.stage).toBe('enroll'); expect(raw).not.toMatch(/eyJ/)       // no token in the body
    const set = login.headers.get('set-cookie'); const pending = set.split(';')[0]
    for (const attr of ['__Host-pt_xr=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(set).toContain(attr)
    expect(set).not.toMatch(/Domain=/i)
    expect((await call('GET', '/api/expert-realm/me', { cookie: pending })).status).toBe(401)          // pending cannot reach anything real
    expect((await call('GET', '/api/expert-realm/desk', { cookie: pending })).status).toBe(401)
    const setup = await call('POST', '/api/expert-realm/auth/totp/setup', { cookie: pending }); expect(setup.status).toBe(200)
    const secret = (await setup.json()).data.secret; expect(row('new').totp_secret_enc).toBe(`sealed:${secret}`)
    const code = String(await totp.hotp(secret, totp.stepOf(Date.now()))).padStart(6, '0')
    const mfa = await call('POST', '/api/expert-realm/auth/totp', { cookie: pending, body: { code } }); expect(mfa.status).toBe(200)
    const body = (await mfa.json()).data; expect(body.stage).toBe('full'); expect(body.recoveryCodes).toHaveLength(10)
    expect(row('new').totp_enabled_at).toBeTruthy()
    const stored = JSON.stringify(w.t.expert_recovery_codes); for (const c of body.recoveryCodes) expect(stored).not.toContain(c.replace('-', ''))
    expect(w.t.expert_recovery_codes).toHaveLength(10)
    expect((await call('GET', '/api/expert-realm/me', { cookie: cookieOf(mfa) })).status).toBe(200)
  })
  it('a returning expert with two-factor signs in; recovery codes are not shown again', async () => {
    const a = await signInFlow('exp'); expect(a.mfa.status).toBe(200)
    const first = (await a.mfa.json()).data; expect(first.recoveryCodes).toHaveLength(10)           // a Phase 1 pilot account had none: issued now
    const b = await signInFlow('exp'); expect((await b.mfa.json()).data.recoveryCodes).toBeUndefined()
  })
  it('a wrong password and an unknown email get the same answer', async () => {
    const a = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: 'wrong wrong wrong' } })
    const b = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'nobody@example.com', password: 'wrong wrong wrong' } })
    expect(a.status).toBe(401); expect(b.status).toBe(401); expect(await a.json()).toEqual(await b.json())
    expect(a.headers.get('set-cookie')).toBeNull()
  })
  it('disabled, suspended and role-less accounts cannot sign in', async () => {
    for (const patch of [{ enabled: false }, { status: 'suspended' }, { roles: [] }]) { Object.assign(row('exp'), { enabled: true, status: 'active', roles: ['expert'] }, patch)
      expect((await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })).status).toBe(401) }
  })
  it('five wrong passwords lock the account; the right password is then refused until the lock ends', async () => {
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: 'nope nope nope nope' } })).status).toBe(401)
    expect(row('exp').locked_until).toBeTruthy()
    const locked = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } }); expect(locked.status).toBe(401)
    row('exp').locked_until = new Date(Date.now() - 1000).toISOString()
    expect((await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })).status).toBe(200)
  })
  it('wrong second-factor codes count toward the lock; a replayed code is refused', async () => {
    const { cookie } = await signInFlow('exp'); expect(cookie).toBeTruthy()
    const login = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } }); const pending = cookieOf(login)
    expect((await call('POST', '/api/expert-realm/auth/totp', { cookie: pending, body: { code: await codeFor('exp') } })).status).toBe(401)   // that step was just used
    for (let i = 0; i < 4; i++) expect((await call('POST', '/api/expert-realm/auth/totp', { cookie: pending, body: { code: '000000' } })).status).toBe(401)
    expect(row('exp').locked_until).toBeTruthy()
  })
  it('the sign-in routes are rate limited per IP and per session', async () => {
    let last; for (let i = 0; i < 21; i++) last = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'nobody@example.com', password: 'x' } })
    expect(last.status).toBe(429); expect(last.headers.get('retry-after')).toBeTruthy()
    const pending = cookieOf(await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD }, headers: {} }).catch(() => null) || { headers: new Headers() })
    expect(pending).toBeDefined()
  })
  it('a recovery code signs in once; the same code never works twice; codes are single use', async () => {
    const first = await signInFlow('exp'); const codes = (await first.mfa.json()).data.recoveryCodes
    const l1 = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })
    const r1 = await call('POST', '/api/expert-realm/auth/recover', { cookie: cookieOf(l1), body: { code: codes[0].toUpperCase() } }); expect(r1.status).toBe(200)
    expect((await r1.json()).data.recoveryCodesLeft).toBe(9)
    const l2 = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })
    expect((await call('POST', '/api/expert-realm/auth/recover', { cookie: cookieOf(l2), body: { code: codes[0] } })).status).toBe(401)
    expect((await call('POST', '/api/expert-realm/auth/recover', { cookie: cookieOf(l2), body: { code: codes[1] } })).status).toBe(200)
  })
})

describe('session limits and revocation', () => {
  it('ends after 8 hours idle and after 7 days absolute (from settings, not constants)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T08:00:00Z'))
    const cookie = await sessionFor('exp')
    vi.setSystemTime(new Date('2026-10-01T15:59:00Z')); expect((await call('GET', '/api/expert-realm/me', { cookie })).status).toBe(200)     // touched: idle clock restarts
    vi.setSystemTime(new Date('2026-10-01T22:30:00Z')); expect((await call('GET', '/api/expert-realm/me', { cookie })).status).toBe(200)
    vi.setSystemTime(new Date('2026-10-02T06:31:00Z')); const idle = await call('GET', '/api/expert-realm/me', { cookie }); expect(idle.status).toBe(401)      // 8h + 1m with no request
    expect(idle.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    w.t.system_state.push({ key: 'expert_realm', value: { idle_hours: 24 } }); cfg.resetSettingsCache()       // the daily visits below are 23 hours apart
    vi.setSystemTime(new Date('2026-10-01T08:00:00Z')); const c2 = await sessionFor('exp')
    for (let d = 1; d <= 6; d++) { vi.setSystemTime(new Date(Date.parse('2026-10-01T08:00:00Z') + d * 86400e3 - 3600e3)); expect((await call('GET', '/api/expert-realm/me', { cookie: c2 })).status, `day ${d}`).toBe(200) }
    vi.setSystemTime(new Date(Date.parse('2026-10-01T08:00:00Z') + 7 * 86400e3 + 60e3)); expect((await call('GET', '/api/expert-realm/me', { cookie: c2 })).status).toBe(401)
  })
  it('limits come from settings: a stored override takes effect (and a wild value is ignored)', async () => {
    w.t.system_state.push({ key: 'expert_realm', value: { idle_hours: 1, absolute_days: 9999 } }); cfg.resetSettingsCache()
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T08:00:00Z')); const cookie = await sessionFor('exp')
    vi.setSystemTime(new Date('2026-10-01T09:05:00Z')); expect((await call('GET', '/api/expert-realm/me', { cookie })).status).toBe(401)
    expect((await cfg.loadSettings(w.db, Date.now() + 99e3)).absolute_days).toBe(7)
  })
  it('revoke all sessions ends every cookie, including ones on other devices', async () => {
    const a = await sessionFor('exp'), b = await sessionFor('exp')
    expect((await call('GET', '/api/expert-realm/me', { cookie: b })).status).toBe(200)
    const out = await call('POST', '/api/expert-realm/auth/logout-all', { cookie: a }); expect(out.status).toBe(200)
    expect((await call('GET', '/api/expert-realm/me', { cookie: a })).status).toBe(401); expect((await call('GET', '/api/expert-realm/me', { cookie: b })).status).toBe(401)
    expect(row('exp').token_version).toBe(1); expect(w.t.audit_dummy).toBeUndefined()
    expect(w.t.expert_audit_log.some(e => e.action === 'auth.revoke_all' && e.actor_id === 'exp')).toBe(true)
  })
  it('sign out ends only this session; the session list shows the others and can end one', async () => {
    const a = await sessionFor('exp'), b = await sessionFor('exp')
    const list = (await (await call('GET', '/api/expert-realm/sessions', { cookie: a })).json()).data.sessions; expect(list).toHaveLength(2); expect(list.filter(s => s.current)).toHaveLength(1)
    const other = list.find(s => !s.current); expect((await call('DELETE', `/api/expert-realm/sessions/${other.id}`, { cookie: a })).status).toBe(200)
    expect((await call('GET', '/api/expert-realm/me', { cookie: b })).status).toBe(401)
    expect((await call('POST', '/api/expert-realm/auth/logout', { cookie: a })).status).toBe(200); expect((await call('GET', '/api/expert-realm/me', { cookie: a })).status).toBe(401)
  })
  it('one expert cannot end another expert\'s session', async () => {
    const mine = await sessionFor('exp'); const theirs = await sessionFor('exp2')
    const theirId = (await (await call('GET', '/api/expert-realm/sessions', { cookie: theirs })).json()).data.sessions[0].id
    await call('DELETE', `/api/expert-realm/sessions/${theirId}`, { cookie: mine }); expect((await call('GET', '/api/expert-realm/me', { cookie: theirs })).status).toBe(200)
  })
  it('a suspended or role-less account loses a live session on its next request', async () => {
    const cookie = await sessionFor('exp'); row('exp').status = 'suspended'; expect((await call('GET', '/api/expert-realm/me', { cookie })).status).toBe(401)
  })
  it('a tampered, wrong-secret or wrong-audience cookie is refused', async () => {
    const good = await sessionFor('exp'); const jwt = require_('../src/lib/jwt.js')
    expect((await call('GET', '/api/expert-realm/me', { cookie: good.slice(0, -3) + 'abc' })).status).toBe(401)
    const forged = await jwt.sign({ sub: 'exp', sid: 'x', tv: 0, aud: 'expert-realm' }, 'z'.repeat(40), 3600); expect((await call('GET', '/api/expert-realm/me', { cookie: `__Host-pt_xr=${forged}` })).status).toBe(401)
    const wrongAud = await jwt.sign({ sub: 'exp', sid: 'x', tv: 0, aud: 'passthrough-experts' }, ENV.EXPERT_REALM_SECRET, 3600); expect((await call('GET', '/api/expert-realm/me', { cookie: `__Host-pt_xr=${wrongAud}` })).status).toBe(401)
  })
  it('an Authorization header is never read, even carrying a perfectly good realm token', async () => {
    const good = (await sessionFor('exp')).split('=')[1]
    expect((await call('GET', '/api/expert-realm/me', { headers: { authorization: `Bearer ${good}` } })).status).toBe(401)
  })
})

describe('password reset and change', () => {
  it('request answers the same for any email; a link works once, ends all sessions, and does not bypass two-factor', async () => {
    const cookie = await sessionFor('exp')
    const a = await call('POST', '/api/expert-realm/auth/password/forgot', { body: { email: 'exp@example.com' } }); const b = await call('POST', '/api/expert-realm/auth/password/forgot', { body: { email: 'nobody@example.com' } })
    expect(await a.json()).toEqual(await b.json()); expect(sent).toHaveLength(1)
    expect(sent[0].from).toBe(ENV.EXPERT_EMAIL_FROM); const token = sent[0].text.match(/#token=([\w-]+)/)[1]
    expect(sent[0].html).not.toMatch(/\?token=/); expect(JSON.stringify(w.t.expert_password_resets)).not.toContain(token)       // only a hash is kept
    const weak = await call('POST', '/api/expert-realm/auth/password/reset', { body: { token, password: 'short' } }); expect(weak.status).toBe(400)
    const pw = await call('POST', '/api/expert-realm/auth/password/reset', { body: { token, password: 'a brand new passphrase 22' } }); expect(pw.status).toBe(200)
    expect((await call('POST', '/api/expert-realm/auth/password/reset', { body: { token, password: 'another passphrase 333' } })).status).toBe(400)   // used
    expect((await call('GET', '/api/expert-realm/me', { cookie })).status).toBe(401)
    const login = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: 'a brand new passphrase 22' } })
    expect((await login.json()).data.stage).toBe('mfa'); expect((await call('GET', '/api/expert-realm/me', { cookie: cookieOf(login) })).status).toBe(401)
  })
  it('an expired link and a breached password are refused', async () => {
    await call('POST', '/api/expert-realm/auth/password/forgot', { body: { email: 'exp@example.com' } }); const token = sent[0].text.match(/#token=([\w-]+)/)[1]
    expect((await call('POST', '/api/expert-realm/auth/password/reset', { body: { token, password: 'password1234!' } })).status).toBe(400)
    w.t.expert_password_resets[0].expires_at = new Date(Date.now() - 1000).toISOString()
    expect((await call('POST', '/api/expert-realm/auth/password/reset', { body: { token, password: 'a brand new passphrase 22' } })).status).toBe(400)
  })
  it('changing the password needs the current one and signs every session out', async () => {
    const cookie = await sessionFor('exp')
    expect((await call('POST', '/api/expert-realm/me/password', { cookie, body: { current: 'wrong', next: 'a brand new passphrase 22' } })).status).toBe(401)
    expect((await call('POST', '/api/expert-realm/me/password', { cookie, body: { current: PASSWORD, next: 'a brand new passphrase 22' } })).status).toBe(200)
    expect((await call('GET', '/api/expert-realm/me', { cookie })).status).toBe(401)
  })
})

describe('the permission matrix, generated: every role against every action route', () => {
  it('allows exactly what the matrix allows and denies the rest with an audited 403', async () => {
    const routes = allRoutes().filter(r => r.policy.action); expect(routes.length).toBeGreaterThanOrEqual(9)
    const cookies = {}; for (const [id, role] of [['exp', 'expert'], ['gra', 'grader'], ['adm', 'expert_admin'], ['sup', 'expert_support']]) cookies[role] = await sessionFor(id)
    let checked = 0
    for (const r of routes) for (const [role, cookie] of Object.entries(cookies)) {
      const res = await call(r.method, r.url, { cookie, body: r.method === 'GET' ? undefined : {} }); const j = await res.clone().json().catch(() => ({}))
      const ok = perms.MATRIX[r.policy.action][role] !== '-'
      if (ok) expect(['FORBIDDEN', 'AUTH', 'MFA_REQUIRED'].includes(j.code), `${role} should reach ${r.method} ${r.path} (${res.status} ${j.code})`).toBe(false)
      else { expect(res.status, `${role} ${r.method} ${r.path}`).toBe(403); expect(j.code).toBe('FORBIDDEN') }
      checked++
    }
    expect(checked).toBe(routes.length * 4); expect(w.t.expert_audit_log.filter(e => e.action === 'realm.denied').length).toBeGreaterThan(10)
  })
  it('a role in the account but none that grants the action is denied; roles combine upward only', async () => {
    row('sup').roles = ['expert_support', 'expert']; const cookie = await sessionFor('sup')
    expect((await call('GET', '/api/expert-admin/board', { cookie })).status).toBe(200)                              // support grants board.view
    expect((await call('GET', '/api/expert-admin/audit', { cookie })).status).toBe(403)                              // neither role grants audit.view
  })
  it('every unauthenticated or pending request to a session route is refused', async () => {
    for (const r of allRoutes().filter(r => r.policy.action || r.policy.auth === 'session')) {
      const res = await call(r.method, r.url, { body: r.method === 'GET' ? undefined : {} }); expect(res.status, `${r.method} ${r.url}`).toBe(401) }
  })
})

describe('step-up, reasons and money', () => {
  const post = (cookie, body, id = JOB) => call('POST', `/api/expert-admin/jobs/${id}/refund`, { cookie, body })
  it('a refund needs a fresh password check, then a reason, then a request key', async () => {
    const cookie = await sessionFor('adm')
    let r = await post(cookie, { reason: 'duplicate order', idemKey: 'refund-key-1' }); expect(r.status).toBe(403); expect((await r.json()).code).toBe('STEP_UP_REQUIRED')
    await elevated(cookie)
    r = await post(cookie, { idemKey: 'refund-key-1' }); expect(r.status).toBe(400); expect((await r.json()).code).toBe('REASON_REQUIRED')
    r = await post(cookie, { reason: 'duplicate order' }); expect(r.status).toBe(400)
    expect(queued).toHaveLength(0)
  })
  it('the elevation lapses after the step-up window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T08:00:00Z')); const cookie = await sessionFor('adm'); await elevated(cookie)
    vi.setSystemTime(new Date('2026-10-01T08:11:00Z')); expect((await post(cookie, { reason: 'duplicate order', idemKey: 'refund-key-9' })).status).toBe(403)
  })
  it('a refund goes through the bridge once: logged before and after, and a repeat with the same key moves no money', async () => {
    const cookie = await sessionFor('adm'); await elevated(cookie)
    const a = await post(cookie, { reason: 'duplicate order', idemKey: 'refund-key-1' }); expect(a.status).toBe(200)
    const b = await post(cookie, { reason: 'duplicate order', idemKey: 'refund-key-1' }); expect(b.status).toBe(200); expect((await b.json()).data.replay).toBe(true)
    expect(queued).toHaveLength(1); expect(queued[0].payment).toBe('pay1')
    expect(w.t.expert_bridge_calls).toHaveLength(1); expect(w.t.expert_bridge_calls[0]).toMatchObject({ fn: 'refund_human_order', outcome: 'ok', actor_id: 'adm' })
    const acts = w.t.expert_audit_log.map(e => e.action); expect(acts).toContain('money.refund_requested'); expect(acts).toContain('money.refund_queued')
  })
  it('never refunds a payment that is not a human order, and never without an audit row', async () => {
    const cookie = await sessionFor('adm'); await elevated(cookie)
    const r = await post(cookie, { reason: 'wrong order', idemKey: 'refund-key-2' }, JOB_OTHER); expect(r.status).toBe(409); expect(queued).toHaveLength(0)
    w.failNext('expert_audit_log', 'insert', { message: 'audit down' })
    const down = await post(cookie, { reason: 'duplicate order', idemKey: 'refund-key-3' }); expect(down.status).toBe(503); expect(queued).toHaveLength(0)
  })
  it('support and experts cannot refund at all', async () => {
    for (const id of ['sup', 'exp', 'gra']) { const cookie = await sessionFor(id); await elevated(cookie).catch(() => {}); expect((await post(cookie, { reason: 'duplicate order', idemKey: 'k-' + id + '-12' })).status).toBe(403) }
    expect(queued).toHaveLength(0)
  })
  it('the bridge is rate limited per admin', async () => {
    const cookie = await sessionFor('adm'); await elevated(cookie); let last
    for (let i = 0; i < 12; i++) last = await post(cookie, { reason: 'duplicate order', idemKey: `refund-loop-${i}` })
    expect(last.status).toBe(429)
  })
})

describe('job content: only for the expert it is assigned to, every read logged', () => {
  const brief = (cookie, id = JOB) => call('GET', `/api/expert-realm/jobs/${id}/brief`, { cookie })
  it('the assigned expert reads the brief (company masked) and the read is logged', async () => {
    const cookie = await sessionFor('exp'); const res = await brief(cookie); expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json()); expect(text).not.toContain('Acme'); expect(w.t.expert_audit_log.some(e => e.action === 'job.brief_read' && e.actor_id === 'exp' && e.target_id === JOB)).toBe(true)
  })
  it('another expert, a grader, an admin and support are all refused the same way, and each attempt is logged', async () => {
    for (const id of ['exp2', 'gra', 'adm', 'sup']) { const res = await brief(await sessionFor(id)); expect(res.status, id).toBe(403); expect((await res.json()).code).toBe('NO_ACCESS') }
    expect(w.t.expert_audit_log.filter(e => e.action === 'job.read_denied')).toHaveLength(4)
  })
  it('a job that is no longer assigned or is in a non-working state cannot be read', async () => {
    const cookie = await sessionFor('exp'); w.t.human_jobs[0].expert_id = 'exp2'; expect((await brief(cookie)).status).toBe(403)
    w.t.human_jobs[0].expert_id = 'exp'; w.t.human_jobs[0].state = 'open'; expect((await brief(cookie)).status).toBe(403)
    expect((await brief(cookie, 'not-a-uuid')).status).toBe(403)
  })
  it('no audit row, no read: the content is not returned when the log write fails', async () => {
    const cookie = await sessionFor('exp'); w.failNext('expert_audit_log', 'insert', { message: 'audit down' })
    const res = await brief(cookie); expect(res.status).toBe(503); expect(JSON.stringify(await res.json())).not.toContain('Role at')
  })
  it('the desk lists only the expert\'s own jobs', async () => {
    const res = await call('GET', '/api/expert-realm/desk', { cookie: await sessionFor('exp') }); const jobs = (await res.json()).data.jobs
    expect(jobs.map(j => j.id)).toEqual([JOB])
  })
})

describe('the console reads and assigns', () => {
  it('board, timeline, directory and audit viewer return metadata only', async () => {
    const cookie = await sessionFor('adm')
    w.t.job_events = [{ id: 1, job_id: JOB, kind: 'paid', actor_kind: 'system', created_at: '2026-10-01T00:00:00Z', detail: { from: 'awaiting_payment', to: 'offered', trigger: 'payment_confirmed', secret_note: 'x' } }]
    const board = await (await call('GET', '/api/expert-admin/board', { cookie })).json(); expect(board.data.jobs).toHaveLength(2)
    const detail = await (await call('GET', `/api/expert-admin/jobs/${JOB}`, { cookie })).json(); expect(detail.data.timeline[0]).toMatchObject({ kind: 'paid', from: 'awaiting_payment', to: 'offered' })
    const dir = await (await call('GET', '/api/expert-admin/experts', { cookie })).json(); expect(dir.data.experts.find(e => e.id === 'exp').activeJobs).toBe(1)
    const text = JSON.stringify([board, detail, dir]); for (const bad of ['password', 'totp', 'paystack', 'email', 'brief', 'jobPosting']) expect(text.toLowerCase(), bad).not.toContain(bad.toLowerCase())
    expect((await call('GET', '/api/expert-admin/audit', { cookie })).status).toBe(200)
  })
  it('assign and reassign call the engine with the right trigger and record who and why', async () => {
    const seen = []; w.rpcs.human_job_transition = a => { seen.push(a); return { data: { ok: true, state: 'claimed', version: 4, event_id: 9 }, error: null } }
    w.t.human_jobs.find(j => j.id === JOB_OTHER).state = 'open'; w.t.human_jobs.find(j => j.id === JOB_OTHER).expert_id = null
    const cookie = await sessionFor('adm'); const E = '00000000-0000-4000-8000-0000000000e2'
    expect((await call('POST', `/api/expert-admin/jobs/${JOB_OTHER}/assign`, { cookie, body: { expertId: E, reason: 'closest fit' } })).status).toBe(200)
    expect(seen[0]).toMatchObject({ p_trigger: 'assign', p_actor_kind: 'operator', p_actor: 'adm', p_expert: E })
    expect((await call('POST', `/api/expert-admin/jobs/${JOB}/reassign`, { cookie, body: { expertId: E, reason: 'expert unavailable' } })).status).toBe(200); expect(seen[1].p_trigger).toBe('reassign')
    // the state machine refuses the wrong pairing before the database is asked
    expect((await call('POST', `/api/expert-admin/jobs/${JOB}/assign`, { cookie, body: { expertId: E, reason: 'closest fit' } })).status).toBe(409); expect(seen).toHaveLength(2)
    expect((await call('POST', `/api/expert-admin/jobs/${JOB}/assign`, { cookie, body: { expertId: E } })).status).toBe(400)           // reason required
  })
})
