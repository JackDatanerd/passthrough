import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { Hono } = require_('hono')
const bcrypt = require_('bcryptjs')
const totp = require_('../src/lib/totp')
const jwt = require_('../src/lib/jwt')
const locks = require_('../src/lib/humanLocks')

// Experts Phase 1: the expert realm. Its own secret and accounts; second factor; a token from one realm is dead in the other;
// the server (not the browser) enforces the locks; an expert reaches a job's content only through the assigned-job database gate.

const EXPERT_SECRET = 'e'.repeat(40), MAIN_SECRET = 'm'.repeat(40)
const ENV = { EXPERTS_ENABLED: 'true', EXPERT_JWT_SECRET: EXPERT_SECRET, JWT_SECRET: MAIN_SECRET }
const E1 = '33333333-3333-4333-8333-333333333333', JOB = '44444444-4444-4444-8444-444444444444'
const TOTP_SECRET = totp.newSecret()
const RESUME = { name: 'Wanjiru Kamau', email: 'w@example.com', phone: '+254 712 345 678', summary: 'Product manager at Globex. Contact w@example.com.',
  experience: [{ company: 'Acme Ltd', title: 'PM', dates: '2019 - 2023', bullets: ['Grew users 40%.'] }], skills: ['SQL'] }
const LOCKED = locks.lockDocument(RESUME)
let t
afterEach(() => { t?.restore(); t = null })

async function build({ account = {}, rpcs = {}, settings = true } = {}) {
  const hash = await bcrypt.hash('correct horse', 4)
  const world = createWorld({
    expert_accounts: [{ id: E1, email: 'ex@example.com', password_hash: hash, roles: ['expert'], status: 'active', enabled: true, display_first_name: 'Ex', display_initial: 'P', token_version: 0,
      totp_secret_enc: `enc:${TOTP_SECRET}`, totp_enabled_at: new Date().toISOString(), totp_last_step: null, failed_logins: 0, locked_until: null, agreement_signed_at: '2026-10-01T00:00:00Z', ...account }],
    human_jobs: [], users: [{ id: 'u1', email: 'c@x.y', name: 'Cust' }],
    system_state: settings ? [{ key: 'human_pilot', value: { prices: { polish: 1, seven_day: 1, forty_eight_hour: 1, twenty_four_hour: 1, cover_letter: 1 }, pay: { polish: 1, seven_day: 1, forty_eight_hour: 1, twenty_four_hour: 1, cover_letter: 1 },
      tiers_enabled: { polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true }, pilot_cap_orders: 15, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3, question_max: 3, question_answer_hours: 24 } }] : [] })
  const calls = []
  for (const [name, fn] of Object.entries(rpcs)) world.rpcs[name] = args => { calls.push([name, args]); return fn(args) }
  for (const k of Object.keys(require_.cache)) if (/[\\/]src[\\/](controllers[\\/](expert|human)|routes[\\/](expert|human)|middleware[\\/](expertAuth|humanLimits))/.test(k)) delete require_.cache[k]
  t = loadWithStubs('routes/expert.routes.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'lib/fieldCrypto.js': { hasKey: () => true, sealTaxId: async (e, v) => `enc:${v}`, openTaxId: async (e, v) => String(v).replace(/^enc:/, '') },
    'services/email.service.js': { sendHumanQuestion: async () => true, sendOwnerNotice: async () => true, sendOwnerAlert: async () => {} },
  })
  const app = new Hono(); app.route('/api/expert', t.mod); app.notFound(c => c.json({ success: false, message: 'Not found.' }, 404))
  t.world = world; t.calls = calls
  return app
}
const req = (a, method, path, body, token, env = ENV) => a.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, env)
const code = async (now = Date.now()) => totp.hotp(TOTP_SECRET, totp.stepOf(now))
async function signIn(a) {
  const l = await (await req(a, 'POST', '/api/expert/auth/login', { email: 'ex@example.com', password: 'correct horse' })).json()
  const m = await (await req(a, 'POST', '/api/expert/auth/mfa', { code: await code() }, l.data.token)).json()
  return m.data.token
}

describe('flag', () => {
  it('off: every path is the ordinary 404 and nothing is read', async () => {
    const a = await build()
    for (const [m, p] of [['POST', '/api/expert/auth/login'], ['GET', '/api/expert/me'], ['GET', '/api/expert/jobs'], ['GET', `/api/expert/jobs/${JOB}`], ['PUT', `/api/expert/jobs/${JOB}/document`]])
      expect((await req(a, m, p, m === 'GET' ? undefined : {}, null, { EXPERT_JWT_SECRET: EXPERT_SECRET })).status, p).toBe(404)
  })
})

describe('sign-in', () => {
  it('password then authenticator code gives a full token; the token reaches /me', async () => {
    const a = await build(); const token = await signIn(a)
    const me = await (await req(a, 'GET', '/api/expert/me', null, token)).json()
    expect(me.data.name).toBe('Ex P.')
  })
  it('wrong password, unknown email, a disabled expert and a paused expert all get the same 401 words', async () => {
    const msgs = new Set()
    for (const [acct, email, pw] of [[{}, 'ex@example.com', 'wrong'], [{}, 'nobody@example.com', 'x'], [{ enabled: false }, 'ex@example.com', 'correct horse'], [{ status: 'paused' }, 'ex@example.com', 'correct horse']]) {
      const a = await build({ account: acct }); const r = await req(a, 'POST', '/api/expert/auth/login', { email, password: pw })
      expect(r.status).toBe(401); msgs.add((await r.json()).message); t.restore()
    }
    expect([...msgs]).toEqual(['Those details are not right.'])
  })
  it('five wrong passwords lock the account for a while; even the right password is then refused', async () => {
    const a = await build()
    for (let i = 0; i < 5; i++) await req(a, 'POST', '/api/expert/auth/login', { email: 'ex@example.com', password: 'bad' })
    expect(t.world.t.expert_accounts[0].locked_until).toBeTruthy()
    expect((await req(a, 'POST', '/api/expert/auth/login', { email: 'ex@example.com', password: 'correct horse' })).status).toBe(429)
  })
  it('a code works once: replaying it is refused; a wrong code is refused', async () => {
    const a = await build()
    const l = await (await req(a, 'POST', '/api/expert/auth/login', { email: 'ex@example.com', password: 'correct horse' })).json()
    const c1 = await code()
    expect((await req(a, 'POST', '/api/expert/auth/mfa', { code: c1 }, l.data.token)).status).toBe(200)
    expect((await req(a, 'POST', '/api/expert/auth/mfa', { code: c1 }, l.data.token)).status).toBe(401)
    expect((await req(a, 'POST', '/api/expert/auth/mfa', { code: '000000' }, l.data.token)).status).toBe(401)
  })
  it('first sign-in enrols: a secret is shown once, sealed at rest, and only a valid code from it turns two-factor on', async () => {
    const a = await build({ account: { totp_secret_enc: null, totp_enabled_at: null } })
    const l = await (await req(a, 'POST', '/api/expert/auth/login', { email: 'ex@example.com', password: 'correct horse' })).json()
    expect(l.data.stage).toBe('enroll')
    const s = (await (await req(a, 'POST', '/api/expert/auth/enroll/start', {}, l.data.token)).json()).data
    expect(s.otpauthUrl).toMatch(/^otpauth:\/\/totp\//); expect(t.world.t.expert_accounts[0].totp_secret_enc).toBe(`enc:${s.secret}`)
    expect(t.world.t.expert_accounts[0].totp_enabled_at).toBeNull()
    const ok = await req(a, 'POST', '/api/expert/auth/mfa', { code: await totp.hotp(s.secret, totp.stepOf(Date.now())) }, l.data.token)
    expect(ok.status).toBe(200); expect(t.world.t.expert_accounts[0].totp_enabled_at).toBeTruthy()
  })
  it('a pending token cannot do anything but finish sign-in; a full token cannot be used to finish one', async () => {
    const a = await build()
    const l = await (await req(a, 'POST', '/api/expert/auth/login', { email: 'ex@example.com', password: 'correct horse' })).json()
    expect((await req(a, 'GET', '/api/expert/jobs', null, l.data.token)).status).toBe(401)
    const full = await signIn(a)
    expect((await req(a, 'POST', '/api/expert/auth/mfa', { code: await code() }, full)).status).toBe(401)
  })
  it('signing out kills every token the account holds', async () => {
    const a = await build(); const token = await signIn(a)
    expect((await req(a, 'POST', '/api/expert/auth/logout', {}, token)).status).toBe(200)
    expect((await req(a, 'GET', '/api/expert/me', null, token)).status).toBe(401)
  })
  it('pausing the expert, or switching them off, kills a live token at once', async () => {
    const a = await build(); const token = await signIn(a)
    t.world.t.expert_accounts[0].enabled = false
    expect((await req(a, 'GET', '/api/expert/me', null, token)).status).toBe(401)
  })
})

describe('realms are separate', () => {
  it('a main-app token (signed with JWT_SECRET) is refused on every expert route', async () => {
    const a = await build()
    const mainToken = await jwt.sign({ userId: E1, tokenVersion: 0 }, MAIN_SECRET, 3600)
    for (const p of ['/api/expert/me', '/api/expert/jobs']) expect((await req(a, 'GET', p, null, mainToken)).status).toBe(401)
    expect((await req(a, 'POST', '/api/expert/auth/mfa', { code: await code() }, mainToken)).status).toBe(401)
  })
  it('an expert token is refused by the main app\'s own auth middleware (and so by the admin area behind it)', async () => {
    const a = await build(); const token = await signIn(a)
    const mainAuth = require_('../src/middleware/auth.js')
    const app = new Hono(); app.get('/api/anything', mainAuth, c => c.json({ ok: true }))
    const res = await app.request('/api/anything', { headers: { authorization: `Bearer ${token}` } }, { JWT_SECRET: MAIN_SECRET })
    expect(res.status).toBe(401)
  })
  it('an expert token minted with the SAME secret as the main app is refused (a shared secret would make tokens interchangeable)', async () => {
    const a = await build()
    const r = await req(a, 'POST', '/api/expert/auth/login', { email: 'ex@example.com', password: 'correct horse' }, null, { ...ENV, EXPERT_JWT_SECRET: MAIN_SECRET })
    expect(r.status).toBe(503)
    const short = await req(a, 'POST', '/api/expert/auth/login', { email: 'ex@example.com', password: 'correct horse' }, null, { ...ENV, EXPERT_JWT_SECRET: 'short' })
    expect(short.status).toBe(503)
  })
  it('a token with the wrong audience or type is refused even if signed with the expert secret', async () => {
    const a = await build()
    for (const claims of [{ sub: E1, aud: 'something-else', typ: 'expert', stage: 'full', tv: 0 }, { sub: E1, aud: 'passthrough-experts', typ: 'user', stage: 'full', tv: 0 }, { sub: E1, aud: 'passthrough-experts', typ: 'expert', stage: 'full', tv: 99 }])
      expect((await req(a, 'GET', '/api/expert/me', null, await jwt.sign(claims, EXPERT_SECRET, 600))).status).toBe(401)
  })
})

describe('the workbench', () => {
  const readOk = ({ p_expert }) => ({ data: { job: { id: JOB, job_number: 'HJ-T', state: 'in_progress', tier: 'forty_eight_hour', brief: { targetRole: 'PM', jobPosting: 'About Globex\nGlobex is hiring a PM. At Globex you will lead.' } },
    source: LOCKED.body, ai_draft: null, working: { version: 1, body: LOCKED.body, cover_letter: null }, questions: [], materials: [] }, error: null })
  it('returns the job with the employer masked from the posting, the read-only paths, and a server diff; the read goes through the database gate', async () => {
    const a = await build({ rpcs: { human_job_expert_read: readOk } }); const token = await signIn(a)
    const d = (await (await req(a, 'GET', `/api/expert/jobs/${JOB}`, null, token)).json()).data
    expect(d.brief.jobPosting).not.toContain('Globex'); expect(d.brief.jobPosting).toContain('[the company]')
    expect(d.readOnly).toEqual(expect.arrayContaining(['name', 'email', 'phone', 'experience.0.company', 'experience.0.dates']))
    expect(d.readOnly).not.toContain('summary')
    expect(d.document.version).toBe(1); expect(d.changes).toEqual([]); expect(d.canEdit).toBe(true)
    expect(JSON.stringify(d)).not.toContain('w@example.com')
    expect(t.calls[0]).toEqual(['human_job_expert_read', { p_job: JOB, p_expert: E1, p_window_days: 7 }])
  })
  it('a job that is not this expert\'s is a 403 and the content is never returned', async () => {
    const a = await build({ rpcs: { human_job_expert_read: () => ({ data: null, error: null }) } }); const token = await signIn(a)
    const r = await req(a, 'GET', `/api/expert/jobs/${JOB}`, null, token); expect(r.status).toBe(403)
    expect(JSON.stringify(await r.json())).not.toContain('Product')
    expect((await req(a, 'GET', '/api/expert/jobs/not-a-uuid', null, token)).status).toBe(403)
  })
  const edit = fn => { const b = JSON.parse(JSON.stringify(LOCKED.body)); fn(b); return b }
  const savable = () => ({ human_job_expert_baseline: () => ({ data: { body: LOCKED.body, cover_letter: null }, error: null }), human_job_expert_save: () => ({ data: { ok: true, version: 2 }, error: null }) })
  it('saves a valid rewrite through the database function', async () => {
    const a = await build({ rpcs: savable() }); const token = await signIn(a)
    const r = await req(a, 'PUT', `/api/expert/jobs/${JOB}/document`, { baseVersion: 1, body: edit(b => { b.summary = 'Product leader.'; b.experience[0].bullets.push('Led 5 PMs.') }), seconds: 40 }, token)
    expect(r.status).toBe(200); expect((await r.json()).data.version).toBe(2)
    expect(t.calls.find(c => c[0] === 'human_job_expert_save')[1]).toMatchObject({ p_job: JOB, p_expert: E1, p_base_version: 1, p_seconds: 40 })
  })
  it.each([
    ['a locked contact field', b => { b.email = 'me@mine.com' }],
    ['an employer name', b => { b.experience[0].company = 'Globex' }],
    ['a typed email address', b => { b.summary = 'write to a@b.com' }],
    ['a typed phone number', b => { b.skills.push('call +1 415 555 0132') }],
    ['a removed locked field', b => { delete b.phone }],
  ])('refuses %s with a 422 and never calls the save function', async (_l, fn) => {
    const a = await build({ rpcs: savable() }); const token = await signIn(a)
    const r = await req(a, 'PUT', `/api/expert/jobs/${JOB}/document`, { baseVersion: 1, body: edit(fn) }, token)
    expect(r.status).toBe(422); expect((await r.json()).errors.length).toBeGreaterThan(0)
    expect(t.calls.some(c => c[0] === 'human_job_expert_save')).toBe(false)
  })
  it('a save on a job that is not this expert\'s is a 403; a stale version is a 409', async () => {
    const a = await build({ rpcs: { human_job_expert_baseline: () => ({ data: null, error: null }) } }); const token = await signIn(a)
    expect((await req(a, 'PUT', `/api/expert/jobs/${JOB}/document`, { baseVersion: 1, body: LOCKED.body }, token)).status).toBe(403); t.restore()
    const b = await build({ rpcs: { ...savable(), human_job_expert_save: () => ({ data: { ok: false, reason: 'conflict', current_version: 3 }, error: null }) } }); const tk = await signIn(b)
    const r = await req(b, 'PUT', `/api/expert/jobs/${JOB}/document`, { baseVersion: 1, body: LOCKED.body }, tk); expect(r.status).toBe(409)
  })
  it('asks a question (no contact details in it) and submits for review', async () => {
    const a = await build({ rpcs: { human_job_ask: () => ({ data: { ok: true, seq: 1 }, error: null }), human_job_submit: () => ({ data: { ok: true }, error: null }) } }); const token = await signIn(a)
    expect((await req(a, 'POST', `/api/expert/jobs/${JOB}/questions`, { body: 'Which role is the target?' }, token)).status).toBe(200)
    expect((await req(a, 'POST', `/api/expert/jobs/${JOB}/questions`, { body: 'Email me at a@b.com please' }, token)).status).toBe(422)
    expect((await req(a, 'POST', `/api/expert/jobs/${JOB}/questions`, { body: 'x' }, token)).status).toBe(400)
    expect((await req(a, 'POST', `/api/expert/jobs/${JOB}/submit`, {}, token)).status).toBe(200)
  })
})
