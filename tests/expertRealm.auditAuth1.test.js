// Experts audit pass 1 (auth and sessions): regression tests for findings F1 to F6. Harness copied from expertRealm.phase2a.test.js.
// Original header: : gating, sign-in, two-factor, recovery codes, lockout, rate limits, session limits,
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
    'lib/fieldCrypto.js': { isSealed: s => String(s).startsWith('sealed:'), sealTaxId: async (_e, p) => `sealed:${p}`, openTaxId: async (_e, s) => String(s).replace('sealed:', ''), openSealedStrict: async (_e, s) => String(s).replace('sealed:', '') },
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


describe('audit pass 1: auth and sessions (F1 to F6)', () => {
  it('F1: parallel wrong passwords still reach the lock (the counter is a compare-and-set, not read-then-write)', async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: 'wrong password number one' } })))
    expect(rs.every(r => r.status === 401)).toBe(true)
    expect(row('exp').locked_until).toBeTruthy()
    const after = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } }); expect(after.status).toBe(401)      // right password refused while locked
  })
  it('F1: parallel wrong second-factor codes reach the lock too', async () => {
    const pendings = []; for (let i = 0; i < 3; i++) pendings.push(cookieOf(await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })))
    await Promise.all(Array.from({ length: 9 }, (_, i) => call('POST', '/api/expert-realm/auth/totp', { cookie: pendings[i % 3], body: { code: '000000' } })))
    expect(row('exp').locked_until).toBeTruthy()
  })
  it('F2: the cookie from the password step is dead once the second factor passes; the new cookie is a different session', async () => {
    const login = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } }); const pending = cookieOf(login); row('exp').totp_last_step = null
    const mfa = await call('POST', '/api/expert-realm/auth/totp', { cookie: pending, body: { code: await codeFor('exp') } }); expect(mfa.status).toBe(200); const full = cookieOf(mfa)
    expect(full).not.toBe(pending)
    expect((await call('GET', '/api/expert-realm/me', { cookie: pending })).status).toBe(401)
    expect((await call('GET', '/api/expert-realm/me', { cookie: full })).status).toBe(200)
    const rows = w.t.expert_sessions.filter(s => s.expert_id === 'exp'); expect(rows).toHaveLength(2)
    expect(rows.filter(r => r.revoked_at).map(r => r.revoked_reason)).toEqual(['promoted']); expect(rows.filter(r => !r.revoked_at && r.mfa_verified_at)).toHaveLength(1)
  })
  it('F2: a pending session promotes once (a second request on the same pending cookie cannot make a second full session)', async () => {
    const pending = cookieOf(await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })); row('exp').totp_last_step = null
    const code = await codeFor('exp')
    const [a, b] = await Promise.all([call('POST', '/api/expert-realm/auth/totp', { cookie: pending, body: { code } }), call('POST', '/api/expert-realm/auth/recover', { cookie: pending, body: { code: 'aaaaa-bbbbb' } })])
    expect([a.status, b.status].filter(s => s === 200).length).toBeLessThanOrEqual(1)
    expect(w.t.expert_sessions.filter(s => s.expert_id === 'exp' && !s.revoked_at && s.mfa_verified_at).length).toBeLessThanOrEqual(1)
  })
  it('F3: a locked account cannot be guessed at through step-up or change-password, even from a live session', async () => {
    const { cookie } = await signInFlow('exp'); row('exp').locked_until = new Date(Date.now() + 600e3).toISOString()
    for (const [path, body] of [['/api/expert-realm/auth/step-up', { password: PASSWORD }], ['/api/expert-realm/me/password', { current: PASSWORD, next: 'another long password 4321' }]]) {
      const r = await call('POST', path, { cookie, body }); expect(r.status, path).toBe(429); expect((await r.json()).code).toBe('LOCKED')
    }
    expect(w.t.expert_sessions.find(s => s.elevated_until)).toBeFalsy()
  })
  it('F4: a locked account, a wrong password and an unknown email are indistinguishable at sign-in', async () => {
    row('exp').locked_until = new Date(Date.now() + 600e3).toISOString()
    const locked = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })
    const wrong = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp2@example.com', password: 'not the password at all' } })
    const none = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'nobody@example.com', password: 'not the password at all' } })
    const bodies = await Promise.all([locked, wrong, none].map(r => r.text())); expect(new Set([locked.status, wrong.status, none.status])).toEqual(new Set([401])); expect(new Set(bodies).size).toBe(1)
    expect(locked.headers.get('set-cookie')).toBeFalsy()
  })
  it('F5: the same code sent at once on two sessions signs in one of them', async () => {
    const l1 = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } }), l2 = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })
    row('exp').totp_last_step = null; const code = await codeFor('exp')
    const rs = await Promise.all([call('POST', '/api/expert-realm/auth/totp', { cookie: cookieOf(l1), body: { code } }), call('POST', '/api/expert-realm/auth/totp', { cookie: cookieOf(l2), body: { code } })])
    expect(rs.map(r => r.status).sort()).toEqual([200, 401])
  })
  it('F6: a reset link for an account that no longer exists is refused cleanly (it was a 500)', async () => {
    const rc = require_('../src/lib/expertRealm/crypto.js'); const token = 'T'.repeat(43);
    (w.t.expert_password_resets ||= []).push({ id: 'r1', expert_id: 'ghost', token_hash: await rc.tokenHash(ENV.EXPERT_REALM_SECRET, token), expires_at: new Date(Date.now() + 600e3).toISOString(), used_at: null })
    const r = await call('POST', '/api/expert-realm/auth/password/reset', { body: { token, password: 'a long enough new password 77' } }); expect(r.status).toBe(400)
  })
})
