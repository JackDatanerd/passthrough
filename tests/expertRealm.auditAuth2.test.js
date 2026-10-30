// Experts audit pass 2 (auth and sessions): regression tests for the nine reported items (1 to 9). Harness copied from expertRealm.phase2a.test.js.
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
const realAudit = require_('../src/services/expertAudit.service.js'); let auditFail = false, auditFailAll = false
const auditStub = { ...realAudit, audit: async (s, o) => { if ((auditFail && o.required) || auditFailAll) { if (o.required) throw Object.assign(new Error('x'), { code: 'AUDIT_FAILED' }); return { ok: false } } return realAudit.audit(s, o) } }
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
  rlHits = new Map(); queued = []; sent.length = 0; auditFail = false; auditFailAll = false
  w.rpcs.human_job_expert_read = args => (args.p_expert === 'exp' && args.p_job === JOB
    ? { data: { job: { id: JOB, job_number: 'HJ-1', state: 'in_progress', tier: 'forty_eight_hour', version: 3, promised_deadline_at: '2026-10-03T00:00:00Z', brief: { jobPosting: 'Company: Acme Corp\nAcme Corp builds things. Role at Acme Corp.' } } }, error: null }
    : { data: null, error: null })
  t = loadWithStubs('routes/expert-realm.routes.js', {
    'config/supabase.js': { getSupabase: () => w.db },
    'middleware/rateLimiter.js': { clientIp: () => '203.0.113.9', rateKeyIp: ip => ip, isBypassed: () => false,
      runOp: async (_e, _op, { key, max }) => { const n = (rlHits.get(key) || 0) + 1; rlHits.set(key, n); return { allowed: n <= max, retryAfter: 60 } } },
    'lib/fieldCrypto.js': { isSealed: s => String(s).startsWith('sealed:'), sealTaxId: async (_e, p) => `sealed:${p}`, openTaxId: async (_e, s) => String(s).replace('sealed:', '') },
    'services/expertAudit.service.js': auditStub,
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


const HOUR = 3600e3
describe('audit pass 2: the nine reported items', () => {
  it('item 1: a first password stops working after 72 hours with no second factor; enrolled accounts are not affected; the window is a setting', async () => {
    const login = () => call('POST', '/api/expert-realm/auth/login', { body: { email: 'new@example.com', password: PASSWORD } })
    row('new').created_at = new Date(Date.now() - 71 * HOUR).toISOString(); expect((await login()).status).toBe(200)
    row('new').created_at = new Date(Date.now() - 73 * HOUR).toISOString()
    const r = await login(); expect(r.status).toBe(401); expect(r.headers.get('set-cookie')).toBeFalsy()
    const wrong = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'new@example.com', password: 'not the password at all' } })
    expect(await r.text()).toBe(await wrong.text())                                  // does not confirm the password was right
    expect(w.t.expert_audit_log.some(a => a.action === 'auth.enrolment_expired')).toBe(true)
    row('exp').created_at = new Date(Date.now() - 900 * HOUR).toISOString(); expect((await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })).status).toBe(200)
    w.t.system_state.push({ key: 'expert_realm', value: { enrol_hours: 200 } }); cfg.resetSettingsCache(); expect((await login()).status).toBe(200)
  })
  it('item 3: at most 3 reset links an hour per account; a new request does not void the earlier link; a used link voids the rest; forgot and reset have separate rate buckets', async () => {
    const forgot = () => call('POST', '/api/expert-realm/auth/password/forgot', { body: { email: 'exp@example.com' } })
    const answers = []; for (let i = 0; i < 4; i++) { const r = await forgot(); answers.push(r.status + (await r.text())) }
    expect(new Set(answers).size).toBe(1); expect(sent).toHaveLength(3)
    const unknown = await call('POST', '/api/expert-realm/auth/password/forgot', { body: { email: 'nobody@example.com' } }); expect(unknown.status + (await unknown.text())).toBe(answers[0])
    const tokens = sent.map(m => (m.text.match(/#token=([\w-]+)/) || [])[1]); expect(tokens.every(Boolean)).toBe(true)
    const use = tok => call('POST', '/api/expert-realm/auth/password/reset', { body: { token: tok, password: 'brand new long password 55' } })
    expect((await use(tokens[2])).status).toBe(200)                                   // the LATEST link works
    expect((await use(tokens[0])).status).toBe(400)                                   // and it voided the others
    rlHits.clear(); for (let i = 0; i < 6; i++) await forgot()
    expect((await use('x'.repeat(30))).status).toBe(400)                              // the reset bucket is untouched by forgot (400 bad token, not 429)
  })
  it('item 3: an earlier link survives a newer request (older links are not voided by asking again)', async () => {
    const forgot = () => call('POST', '/api/expert-realm/auth/password/forgot', { body: { email: 'exp@example.com' } })
    await forgot(); await forgot(); const first = (sent[0].text.match(/#token=([\w-]+)/))[1]
    expect((await call('POST', '/api/expert-realm/auth/password/reset', { body: { token: first, password: 'brand new long password 55' } })).status).toBe(200)
  })
  it('item 4: a new recovery code set replaces the old one and the old codes stop working', async () => {
    const { cookie } = await signInFlow('exp'); await elevated(cookie)
    const a = await (await call('POST', '/api/expert-realm/me/recovery-codes', { cookie })).json(); const b = await (await call('POST', '/api/expert-realm/me/recovery-codes', { cookie })).json()
    expect(a.data.recoveryCodes).toHaveLength(10); expect(b.data.recoveryCodes).toHaveLength(10)
    expect((w.t.expert_recovery_codes || []).filter(r => r.expert_id === 'exp')).toHaveLength(10)
    const pending = cookieOf(await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } }))
    expect((await call('POST', '/api/expert-realm/auth/recover', { cookie: pending, body: { code: a.data.recoveryCodes[0] } })).status).toBe(401)
    expect((await call('POST', '/api/expert-realm/auth/recover', { cookie: pending, body: { code: b.data.recoveryCodes[0] } })).status).toBe(200)
  })
  it('item 4: if storing the new set fails, the old codes still work (nothing is deleted first)', async () => {
    const { cookie } = await signInFlow('exp'); await elevated(cookie)
    const a = await (await call('POST', '/api/expert-realm/me/recovery-codes', { cookie })).json()
    const real = w.db.from.bind(w.db); w.db.from = tbl => { const b = real(tbl); if (tbl === 'expert_recovery_codes') b.insert = () => Promise.resolve({ error: new Error('boom') }); return b }
    const r = await call('POST', '/api/expert-realm/me/recovery-codes', { cookie }); expect(r.status).toBe(500)
    w.db.from = real
    expect((w.t.expert_recovery_codes || []).filter(x => x.expert_id === 'exp')).toHaveLength(10)
    const pending = cookieOf(await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } }))
    expect((await call('POST', '/api/expert-realm/auth/recover', { cookie: pending, body: { code: a.data.recoveryCodes[0] } })).status).toBe(200)
  })
  it('item 5: a plain-text second-factor value in the column is never used', async () => {
    const plain = totp.newSecret(); row('exp').totp_secret_enc = plain; row('exp').totp_last_step = null
    const pending = cookieOf(await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } }))
    const code = String(await totp.hotp(plain, totp.stepOf(Date.now()))).padStart(6, '0')
    expect((await call('POST', '/api/expert-realm/auth/totp', { cookie: pending, body: { code } })).status).toBe(401)
  })
  it('item 6: the realm decides by the request URL host, not a Host header the caller sets', async () => {
    const res = await app.request('https://evil.test/api/expert-realm/me', { method: 'GET', headers: { host: 'experts.example.test' } }, ENV); expect(res.status).toBe(404)
  })
  it('item 7: a sign-in that cannot be recorded is refused and leaves no live session; failed-attempt rows never block anything', async () => {
    auditFail = true
    const pending = cookieOf(await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })); row('exp').totp_last_step = null
    const r = await call('POST', '/api/expert-realm/auth/totp', { cookie: pending, body: { code: await codeFor('exp') } })
    expect(r.status).toBe(503); expect(r.headers.get('set-cookie') || '').not.toMatch(/eyJ/)
    expect(w.t.expert_sessions.filter(s => s.expert_id === 'exp' && !s.revoked_at && s.mfa_verified_at)).toHaveLength(0)
    auditFail = false; auditFailAll = true
    const wrong = await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: 'wrong wrong wrong wrong' } }); expect(wrong.status).toBe(401)
  })
  it('item 8: unfinished and long-expired sessions are deleted at the next sign-in; live ones stay', async () => {
    const now = Date.now(); const mk = (id, extra) => (w.t.expert_sessions ||= []).push({ id, expert_id: 'exp', created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(), revoked_at: null, mfa_verified_at: null, ...extra })
    mk('stale-pending', { absolute_expires_at: new Date(now - 60e3).toISOString() })
    mk('live-pending', { absolute_expires_at: new Date(now + 5 * 60e3).toISOString() })
    mk('old-full', { mfa_verified_at: new Date(now - 40 * 86400e3).toISOString(), absolute_expires_at: new Date(now - 31 * 86400e3).toISOString() })
    mk('live-full', { mfa_verified_at: new Date(now).toISOString(), absolute_expires_at: new Date(now + 86400e3).toISOString() })
    await call('POST', '/api/expert-realm/auth/login', { body: { email: 'exp@example.com', password: PASSWORD } })
    const ids = w.t.expert_sessions.map(s => s.id); expect(ids).toContain('live-pending'); expect(ids).toContain('live-full'); expect(ids).not.toContain('stale-pending'); expect(ids).not.toContain('old-full')
  })
  it('item 9: simultaneous revoke-all calls each move the token version', async () => {
    const acct = { ...row('exp') }
    await Promise.all([1, 2, 3].map(() => sessions.revokeAll(w.db, acct, 'revoke_all')))
    expect(row('exp').token_version).toBe(3)
  })
})
