import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import bcrypt from 'bcryptjs'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// AUDIT FIX (Section 12): auth.controller.js is 550 lines — the single
// largest piece of the app's actual security surface (login, registration,
// password reset, email verification, account deletion) — and had zero
// direct tests. Its dependencies (jwt.js, crypto.js) were already tested in
// isolation, but nothing exercised the controller logic that actually wires
// them together: the timing-equalization path, the BANNED-after-password-
// check ordering, the token renewal window, the token_version invalidation
// on password/reset changes, or the delete-account data scrub. Real jwt.js/
// crypto.js/mappers.js/bcryptjs run unstubbed here — only the DB, outbound
// email, and the KV-backed lockout counter are faked.

const NOW = () => new Date().toISOString()
const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const PAST = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

function baseUserRow(over = {}) {
  return {
    id: 'u1', email: 'user@example.com', password_hash: null, name: 'Ada',
    role: 'USER', status: 'ACTIVE', token_version: 1, email_verified: true,
    email_verify_token: null, email_verify_expiry: null,
    reset_token: null, reset_token_expiry: null, deleted_at: null,
    scans_today: 0, free_fix_credits: 0, scans_day_reset: null,
    paystack_customer_code: null, paystack_auth_code: null, saved_profile: null,
    created_at: NOW(), updated_at: NOW(),
    ...over,
  }
}

async function setup(opts = {}) {
  const state = { slots: [], updates: [], emails: [], lockoutChecks: [], failures: [], failureIps: [], successes: [], bucketDeletes: [], rpcCalls: [], logPurges: [], callOrder: [] }
  const userRow = 'userRow' in opts ? opts.userRow : await (async () => baseUserRow({ password_hash: await bcrypt.hash('correct-password', 10) }))()

  const db = createFakeSupabase(q => {
    if (q.table === 'users' && q.op === 'select') {
      // maybeSingle() lookups get their own handling, since the same shape
      // (.eq('email', ...).maybeSingle()) is ALSO how login/forgotPassword do
      // their own primary, legitimate lookup — this can't just special-case
      // "any maybeSingle with an email filter" without breaking those. Instead
      // this mimics what Postgres itself would actually do: a lookup by
      // pending_email_token only ever matches confirmEmailChange's own query
      // (nothing else in this file filters on that column), and a lookup BY
      // VALUE that matches this test's userRow.email is the normal "find the
      // session user" case (login, forgotPassword, updateEmail's own initial
      // read) — only a lookup for some OTHER email (updateEmail's /
      // confirmEmailChange's proactive duplicate-email check) needs the
      // opt-in opts.existingEmailUser.
      if (q.maybe) {
        // AUDIT FIX (Auth/Scan round): verifyEmail's "already used link" replay
        // lookup is the one email_verify_token query WITHOUT an expiry filter.
        if (q.filters.some(f => f[1] === 'email_verify_token') && !q.filters.some(f => f[0] === 'gt' && f[1] === 'email_verify_expiry'))
          return { data: opts.replayRow ?? null, error: null }
        if (q.filters.some(f => f[1] === 'pending_email_token'))
          return { data: 'pendingLookupRow' in opts ? opts.pendingLookupRow : null, error: null }
        const byEmail = q.filters.find(f => f[1] === 'email')
        if (byEmail && eqValue(q, 'email') !== userRow?.email)
          return { data: opts.existingEmailUser ?? null, error: null }
      }
      return { data: userRow, error: opts.selectError || null }
    }
    if (q.table === 'users' && q.op === 'insert') return { data: opts.insertedRow ?? baseUserRow({ id: 'new1', password_hash: 'x' }), error: opts.insertError || null }
    if (q.table === 'users' && q.op === 'update') {
      state.updates.push({ table: 'users', patch: q.patch, id: eqValue(q, 'id') })
      return { data: opts.updatedUserRow ?? { ...userRow, ...q.patch }, error: opts.userUpdateError || null }
    }
    if (q.table === 'scans' && q.op === 'select' && q.selectOpts?.head) {
      // deleteAccount's in-flight-work guard: a head-only count.
      state.inFlightQueries = (state.inFlightQueries || 0) + 1
      return { count: opts.inFlightCount ?? 0, error: null }
    }
    if (q.table === 'scans' && q.op === 'select') {
      // claimScan's lookup uses .maybeSingle() (a single row or null);
      // deleteAccount's uses a plain array select — same table+op, so
      // distinguish by that instead of trying to give them one shared shape.
      if (q.maybe) return { data: 'claimScanResult' in opts ? opts.claimScanResult : null, error: null }
      return { data: opts.scans ?? [], error: null }
    }
    if (q.table === 'scans' && q.op === 'update') { state.updates.push({ table: 'scans', patch: q.patch }); return { error: opts.scanUpdateError || null } }
    // AUDIT FIX (Auth section audit, fresh pass — deleteAccount email_logs
    // purge race): pushed onto the same state.callOrder array the
    // sendAccountDeleted stub below pushes onto, so a test can assert the
    // confirmation email is actually sent-and-logged BEFORE this purge runs,
    // not just that both eventually happen.
    if (q.table === 'email_logs' && q.op === 'delete') { state.logPurges.push(q.filters.find(f => f[0] === 'in' && f[1] === 'to')?.[2] ?? eqValue(q, 'to')); state.callOrder.push('log-purge'); return { error: null } }
    if (q.op === 'rpc') { state.rpcCalls.push({ name: q.name, args: q.args }); return { data: null, error: opts.rpcError || null } }
    return undefined
  })

  const { mod, restore } = loadWithStubs('controllers/auth.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      // AUDIT FIX (Auth/Scan round): per-recipient slot reserved BEFORE a
      // single-use link token is rotated; opts.slotDenied simulates the
      // throttle being exhausted. Every send* stub returns true (= "sent").
      reserveRecipientSlot: async (env, to, template) => { state.slots.push({ to, template }); return !opts.slotDenied },
      sendWelcome:       async (...a) => { state.emails.push({ type: 'welcome', to: a[2] }); return true },
      sendVerification:  async (...a) => { state.emails.push({ type: 'verify', to: a[2], raw: a[4], opts: a[5] }); return true },
      sendPasswordReset: async (...a) => { state.emails.push({ type: 'reset', to: a[2], raw: a[4], opts: a[5] }); return true },
      // FEATURE (Auth section round 2): confirmation/notification emails for
      // auth's own sensitive account changes — see auth.controller.js's
      // callers and email.service.js's real implementations for what each
      // covers. `a[2]` is always the `to` address in every emailService.send*
      // signature (env, supabase, to, ...), same convention as the three above.
      sendPasswordChanged:        async (...a) => { state.emails.push({ type: 'password_changed', to: a[2] }) },
      sendEmailChangedOldAddress: async (...a) => { state.emails.push({ type: 'email_changed_old_address', to: a[2], newEmail: a[4] }) },
      // AUDIT FIX (Auth section audit, fresh pass — deleteAccount email_logs
      // purge race): a real send has an actual network round trip in it
      // (Resend) before its own email_logs row is written. A plain
      // microtask delay isn't a reliable stand-in — the fake Supabase
      // client's own `.then()` chain (see fakeSupabase.cjs) also resolves
      // over a couple of microtasks, so two microtask-only delays race too
      // closely to deterministically catch "the handler merely scheduled
      // this and moved on" (the actual bug: the old code used waitUntil and
      // never awaited this call at all). A real macrotask delay (setTimeout)
      // reliably outlasts the purge's microtask-only chain either way, so
      // this only passes for a handler that genuinely awaits the send
      // before running the purge.
      sendAccountDeleted:         async (...a) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        state.emails.push({ type: 'account_deleted', to: a[2] })
        state.callOrder.push('account-deleted-email')
      },
      sendAccountLockoutAlert:    async (...a) => { state.emails.push({ type: 'lockout_alert', to: a[2] }) },
      // FEATURE (Auth section, feature-gap-closing pass): a[4] is the
      // { ip, when } object — captured so tests can assert the alert fired
      // with the actual incoming IP, not just that it fired at all.
      sendNewSignInAlert:         async (...a) => { state.emails.push({ type: 'new_login_alert', to: a[2], ip: a[4]?.ip }) },
      sendEmailChangeConfirmation: async (...a) => { state.emails.push({ type: 'change_confirm', to: a[2], raw: a[4], opts: a[5] }); return true },
    },
    'middleware/rateLimiter.js': {
      checkAccountLockout: async (env, email) => { state.lockoutChecks.push(email); return opts.locked ?? { locked: false, retryAfterSeconds: null } },
      // AUDIT FIX (bug — account-lockout DoS): recordLoginFailure now takes
      // the requester's IP as a third argument — captured here (alongside
      // the pre-existing state.failures) so tests can assert it's actually
      // being threaded through from clientIp(c), not silently dropped.
      // Also now returns { justLocked }, defaulting to false — tests that
      // care about the one-time lockout-alert email set opts.justLocked.
      recordLoginFailure:  async (env, email, ip) => { state.failures.push(email); state.failureIps.push(ip); return { justLocked: !!opts.justLocked } },
      recordLoginSuccess:  async (env, email) => { state.successes.push(email) },
      LOCKOUT_MINUTES: 15,
    },
  })

  const env = {
    JWT_SECRET: 'test-secret-at-least-this-long',
    JWT_EXPIRES_IN_SECONDS: '604800',
    RESUMES_BUCKET: { delete: async key => { state.bucketDeletes.push(key) } },
  }
  const c = (over = {}) => ({
    env,
    // email included here to match production: auth.js's real "safe" user
    // object (what c.get('user') actually is) only strips passwordHash and
    // the other explicitly-sensitive fields — email is never one of them.
    // changePassword/updateEmail/deleteAccount's account-lockout calls key
    // off sessionUser.email, so a mock missing it would silently pass
    // `undefined` through instead of catching a real wiring mistake.
    get: k => ({ user: opts.sessionUser ?? { id: 'u1', tokenVersion: 1, emailVerified: true, email: 'user@example.com' }, tokenExp: opts.tokenExp }[k]),
    req: {
      json: async () => (over.body ?? {}),
      query: k => (over.query ?? {})[k],
      // AUDIT FIX (bug — account-lockout DoS): clientIp(c) in
      // auth.controller.js now reads this on every login/changePassword/
      // updateEmail/deleteAccount call — a mock missing it entirely would
      // throw before ever reaching the logic under test. Defaults to
      // 'unknown' (clientIp's own fallback) unless a test supplies one.
      header: k => (over.headers ?? { 'cf-connecting-ip': '1.2.3.4' })[k],
    },
    executionCtx: { waitUntil: p => p },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, db, c, userRow }
}

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

describe('register', () => {
  it('creates the user, sends welcome + verification email via waitUntil, and never leaks the password hash', async () => {
    t = await setup()
    const res = await t.mod.register(t.c({ body: { name: 'Ada', email: 'Ada@Example.com', password: 'longenough', acceptTerms: true } }))
    expect(res.status).toBe(201)
    expect(res.body.data.token).toBeTypeOf('string')
    expect(res.body.data.user.passwordHash).toBeUndefined()
    expect(res.body.data.user.emailVerifyToken).toBeUndefined()
    expect(t.state.emails.map(e => e.type).sort()).toEqual(['verify', 'welcome'])
  })

  it('rejects a password under 8 characters before ever touching the DB', async () => {
    t = await setup()
    await expect(t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password: 'short', acceptTerms: true } }))).rejects.toBeTruthy()
    expect(t.db.calls).toHaveLength(0)
  })

  // BUG FIX (round 2): the earlier length cap only checked JS string
  // .length (UTF-16 code units), not the UTF-8 byte length bcryptjs
  // actually truncates at. 72 'é' characters is well under any character-
  // count cap but is 144 bytes — verified directly against bcryptjs that a
  // password this long silently loses everything past byte 72. This must
  // now be rejected with a validation error instead of silently accepted.
  it('rejects a password within the character-count cap but over 72 UTF-8 bytes', async () => {
    t = await setup()
    const password = 'é'.repeat(72) // .length === 72, but 144 bytes in UTF-8
    await expect(t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password, acceptTerms: true } }))).rejects.toBeTruthy()
    expect(t.db.calls).toHaveLength(0)
  })

  // FEATURE GAP CLOSED (Auth/Scan round)
  it('requires accepting the Terms/Privacy Policy, and records the version accepted', async () => {
    t = await setup()
    await expect(t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password: 'longenough' } }))).rejects.toBeTruthy()
    await expect(t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password: 'longenough', acceptTerms: false } }))).rejects.toBeTruthy()
    expect(t.db.calls).toHaveLength(0)
    const res = await t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password: 'longenough', acceptTerms: true } }))
    expect(res.status).toBe(201)
    const insert = t.db.calls.find(q => q.table === 'users' && q.op === 'insert')
    expect(insert.values.terms_accepted_at).toBeTypeOf('string')
    expect(insert.values.terms_version).toBeTypeOf('string')
  })
  it('rejects a very common password and a password equal to the email address', async () => {
    t = await setup()
    await expect(t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password: 'Password123', acceptTerms: true } }))).rejects.toBeTruthy()
    const res = await t.mod.register(t.c({ body: { name: 'Ada', email: 'someone@example.com', password: 'someone@example.com', acceptTerms: true } }))
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/email/i)
    expect(t.db.calls.filter(q => q.op === 'insert')).toHaveLength(0)
  })
  it('a duplicate email is a clear 409 EMAIL_TAKEN, not a generic "Already exists."', async () => {
    t = await setup({ insertError: { code: '23505', message: 'duplicate key' } })
    const res = await t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password: 'longenough', acceptTerms: true } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('EMAIL_TAKEN')
    expect(res.body.message).toMatch(/already exists/i)
    expect(t.state.emails).toHaveLength(0)
  })
  it('accepts a password made of multi-byte characters as long as it fits in 72 bytes', async () => {
    t = await setup()
    const password = 'é'.repeat(36) // 36 chars, exactly 72 UTF-8 bytes
    const res = await t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password, acceptTerms: true } }))
    expect(res.status).toBe(201)
  })

  // FEATURE (Auth section, feature-gap-closing pass — migration 0040):
  // without this, the account's real first login() call would find
  // lastLoginIp null and — per recordLoginMetadata's own comment — never
  // alert off it, even if that first login() was an attacker's, using
  // credentials that leaked between registration and the real owner's own
  // first sign-in. Seeding here closes exactly that window.
  it('seeds last_login_at/last_login_ip from the registration request itself', async () => {
    t = await setup()
    const res = await t.mod.register(t.c({
      body: { name: 'Ada', email: 'a@b.com', password: 'longenough', acceptTerms: true },
      headers: { 'cf-connecting-ip': '198.51.100.9' }
    }))
    expect(res.status).toBe(201)
    const insert = t.db.calls.find(q => q.table === 'users' && q.op === 'insert')
    expect(insert.values.last_login_ip).toBe('198.51.100.9')
    expect(insert.values.last_login_at).toBeTypeOf('string')
  })
})

describe('login', () => {
  it('a locked-out account is rejected with 429 before any DB read', async () => {
    t = await setup({ locked: { locked: true, retryAfterSeconds: 125 } })
    const res = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'x' } }))
    expect(res.status).toBe(429)
    expect(res.body.message).toMatch(/3 minute/)
    expect(t.db.calls).toHaveLength(0)
  })

  it('an unknown email still pays the bcrypt cost (timing equalization) and records a failure', async () => {
    t = await setup({ userRow: null })
    const res = await t.mod.login(t.c({ body: { email: 'ghost@example.com', password: 'whatever' } }))
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Invalid credentials')
    expect(t.state.failures).toEqual(['ghost@example.com'])
  })

  it('a wrong password is rejected and recorded as a failure', async () => {
    t = await setup()
    const res = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'nope' } }))
    expect(res.status).toBe(401)
    expect(t.state.failures).toEqual(['user@example.com'])
    expect(t.state.successes).toHaveLength(0)
  })

  // AUDIT FIX (bug — account-lockout DoS): recordLoginFailure's third
  // argument is the piece rateLimiter.js's distinct-IP requirement depends
  // on entirely — if clientIp(c) silently stopped being threaded through
  // (e.g. a future edit that reverts to the old two-arg call), every
  // failure would collapse onto the same 'unknown' bucket and the fix
  // would quietly regress back to a single-IP-locks-any-email DoS with no
  // test catching it. This asserts the real header value reaches the call.
  it('threads the requester IP through to recordLoginFailure', async () => {
    t = await setup()
    await t.mod.login(t.c({
      body: { email: 'user@example.com', password: 'nope' },
      headers: { 'cf-connecting-ip': '203.0.113.7' }
    }))
    expect(t.state.failureIps).toEqual(['203.0.113.7'])
  })

  // AUDIT FIX being locked in: BANNED is only revealed AFTER the password
  // proves correct — a wrong guess against a banned account must look
  // identical (401 Invalid credentials) to a wrong guess against any other.
  it('a wrong password against a BANNED account still says "Invalid credentials", not "suspended"', async () => {
    t = await setup({ userRow: baseUserRow({ status: 'BANNED', password_hash: await bcrypt.hash('correct-password', 10) }) })
    const res = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'nope' } }))
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Invalid credentials')
  })

  it('the CORRECT password against a BANNED account is rejected as suspended, and does not record a failure', async () => {
    t = await setup({ userRow: baseUserRow({ status: 'BANNED', password_hash: await bcrypt.hash('correct-password', 10) }) })
    const res = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('BANNED')
    expect(t.state.failures).toHaveLength(0)
  })

  it('a correct login succeeds, issues a token, and records success', async () => {
    t = await setup()
    const res = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(200)
    expect(res.body.data.token).toBeTypeOf('string')
    expect(t.state.successes).toEqual(['user@example.com'])
  })

  // FEATURE (Auth section round 2): recordLoginFailure reporting justLocked
  // is what triggers the one-time lockout alert email — this pins that
  // wiring down at the call site, independent of rateLimiter.js's own
  // justLocked logic (covered separately in rateLimiter.test.js).
  it('sends a one-time lockout alert email when this failure is the one that locks the account', async () => {
    t = await setup({ justLocked: true })
    const res = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'nope' } }))
    expect(res.status).toBe(401)
    expect(t.state.emails).toEqual([{ type: 'lockout_alert', to: 'user@example.com' }])
  })

  it('does NOT send a lockout alert on an ordinary failure that does not trigger a lock', async () => {
    t = await setup({ justLocked: false })
    await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'nope' } }))
    expect(t.state.emails).toHaveLength(0)
  })

  // The no-such-account branch never has a real user/email to alert — this
  // guards against a future edit trying to wire the alert in there too and
  // emailing an address that isn't a Passthrough account.
  it('never sends a lockout alert for an unknown email, even if justLocked', async () => {
    t = await setup({ userRow: null, justLocked: true })
    await t.mod.login(t.c({ body: { email: 'ghost@example.com', password: 'whatever' } }))
    expect(t.state.emails).toHaveLength(0)
  })
})

// FEATURE (Auth section, feature-gap-closing pass — migration 0040):
// recordLoginMetadata is called fire-and-forget (not awaited) from login(),
// wrapped in its own waitUntil — same shape as maybeSendLockoutAlert, but
// with a real `await` (the users-table update) before the point these tests
// check, unlike that simpler one-await case. The test harness's fake
// `executionCtx.waitUntil: p => p` doesn't await the promise it's given
// either — it only starts it — so a flush past every pending microtask is
// needed before asserting on t.state.updates/t.state.emails, or these tests
// would pass or fail depending on exactly how many microtask ticks
// issueJWT's real Web Crypto call happens to take relative to the fake
// Supabase client's .then() chain. A macrotask boundary (setTimeout)
// guarantees every microtask queued before it has already run.
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('login — new sign-in visibility + alert (migration 0040)', () => {
  it('on an account with no prior recorded login, seeds last_login_at/ip and does not alert', async () => {
    t = await setup({ userRow: baseUserRow({ password_hash: await bcrypt.hash('correct-password', 10), last_login_at: null, last_login_ip: null }) })
    const res = await t.mod.login(t.c({
      body: { email: 'user@example.com', password: 'correct-password' },
      headers: { 'cf-connecting-ip': '9.9.9.9' }
    }))
    expect(res.status).toBe(200)
    await flush()
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch.last_login_ip).toBe('9.9.9.9')
    expect(update.patch.last_login_at).toBeTypeOf('string')
    expect(update.patch.previous_login_at).toBeNull()
    expect(update.patch.previous_login_ip).toBeNull()
    expect(update.patch).not.toHaveProperty('last_login_alert_at')
    expect(t.state.emails.filter(e => e.type === 'new_login_alert')).toHaveLength(0)
  })

  it('does not alert when signing in again from the same network, but still shifts previous/last', async () => {
    const priorAt = PAST()
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      last_login_at: priorAt, last_login_ip: '9.9.9.9', last_login_alert_at: null,
    }) })
    await t.mod.login(t.c({
      body: { email: 'user@example.com', password: 'correct-password' },
      headers: { 'cf-connecting-ip': '9.9.9.9' }
    }))
    await flush()
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch.previous_login_at).toBe(priorAt)
    expect(update.patch.previous_login_ip).toBe('9.9.9.9')
    expect(update.patch.last_login_ip).toBe('9.9.9.9')
    expect(t.state.emails.filter(e => e.type === 'new_login_alert')).toHaveLength(0)
  })

  it('alerts when the network looks different and no alert has recently gone out — and the response still reports the OLD ip, not the new one', async () => {
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      last_login_at: PAST(), last_login_ip: '9.9.9.9', last_login_alert_at: null,
    }) })
    const res = await t.mod.login(t.c({
      body: { email: 'user@example.com', password: 'correct-password' },
      headers: { 'cf-connecting-ip': '55.55.55.55' }
    }))
    // The response was built from the user row fetched at the TOP of the
    // request, before recordLoginMetadata's own (still in-flight) write —
    // it must report last sign-in as it was BEFORE this one, same reasoning
    // as Settings.jsx showing "previous", never "current".
    expect(res.body.data.user.lastLoginIp).toBe('9.9.9.9')
    await flush()
    expect(t.state.emails).toEqual([{ type: 'new_login_alert', to: 'user@example.com', ip: '55.55.55.55' }])
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch.last_login_alert_at).toBeTypeOf('string')
  })

  it('throttles: no alert if one already went out recently, even from a different network — but previous/last still shift', async () => {
    const recentAlert = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago, under the 6h floor
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      last_login_at: PAST(), last_login_ip: '9.9.9.9', last_login_alert_at: recentAlert,
    }) })
    await t.mod.login(t.c({
      body: { email: 'user@example.com', password: 'correct-password' },
      headers: { 'cf-connecting-ip': '55.55.55.55' }
    }))
    await flush()
    expect(t.state.emails.filter(e => e.type === 'new_login_alert')).toHaveLength(0)
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch.last_login_ip).toBe('55.55.55.55') // still recorded
    expect(update.patch).not.toHaveProperty('last_login_alert_at') // not re-stamped
  })

  it('an IPv6 login from the same /64 (different low bits) is NOT treated as a new network', async () => {
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      last_login_at: PAST(), last_login_ip: '2001:db8:1234:5678:aaaa:bbbb:cccc:dddd', last_login_alert_at: null,
    }) })
    await t.mod.login(t.c({
      body: { email: 'user@example.com', password: 'correct-password' },
      headers: { 'cf-connecting-ip': '2001:db8:1234:5678:1111:2222:3333:4444' }
    }))
    await flush()
    expect(t.state.emails.filter(e => e.type === 'new_login_alert')).toHaveLength(0)
  })

  it('an IPv6 login from a genuinely different /64 IS treated as a new network', async () => {
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      last_login_at: PAST(), last_login_ip: '2001:db8:1234:5678::1', last_login_alert_at: null,
    }) })
    await t.mod.login(t.c({
      body: { email: 'user@example.com', password: 'correct-password' },
      headers: { 'cf-connecting-ip': '2001:db8:9999:0000::1' }
    }))
    await flush()
    expect(t.state.emails.filter(e => e.type === 'new_login_alert')).toHaveLength(1)
  })

  // A DB hiccup recording this bookkeeping must never surface as a failed
  // sign-in — this is genuinely background, unlike the credential checks
  // earlier in login().
  it('a failure writing last-login metadata does not affect the (already-sent) login response', async () => {
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      last_login_at: PAST(), last_login_ip: '9.9.9.9',
    }), userUpdateError: { message: 'db down' } })
    const res = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(200)
    await flush()
  })

  it('never leaks lastLoginAlertAt (internal throttle bookkeeping) in the login response', async () => {
    t = await setup()
    const res = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'correct-password' } }))
    expect(res.body.data.user.lastLoginAlertAt).toBeUndefined()
  })
})

describe('getMe — silent token renewal', () => {
  it('does not reissue a token when plenty of time remains', async () => {
    t = await setup({ tokenExp: Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60 }) // 6 days left
    const res = await t.mod.getMe(t.c())
    expect(res.body.data.token).toBeUndefined()
  })
  it('reissues a fresh token when under 24h remains', async () => {
    t = await setup({ tokenExp: Math.floor(Date.now() / 1000) + 60 * 60 }) // 1h left
    const res = await t.mod.getMe(t.c())
    expect(res.body.data.token).toBeTypeOf('string')
  })
})

describe('forgotPassword — non-enumeration', () => {
  it('gives the exact same response for an unknown email and sends nothing', async () => {
    t = await setup({ userRow: null })
    const res = await t.mod.forgotPassword(t.c({ body: { email: 'ghost@example.com' } }))
    expect(res.body.message).toMatch(/if that email is registered/i)
    expect(t.state.emails).toHaveLength(0)
  })
  it('for a known active email, sends the reset email but gives the identical response', async () => {
    t = await setup()
    const res = await t.mod.forgotPassword(t.c({ body: { email: 'user@example.com' } }))
    expect(res.body.message).toMatch(/if that email is registered/i)
    expect(t.state.emails).toEqual([{ type: 'reset', to: 'user@example.com', raw: expect.any(String), opts: { slotReserved: true } }])
  })
  // AUDIT FIX (Auth/Scan round): a throttled request must rotate NOTHING —
  // otherwise the fourth request in an hour replaced the stored token with
  // one that was never mailed, killing the link already in the inbox (and
  // letting a stranger do that to anyone).
  it('when the per-recipient email slot is exhausted, the stored reset token is NOT rotated and nothing is sent — same response', async () => {
    t = await setup({ slotDenied: true })
    const res = await t.mod.forgotPassword(t.c({ body: { email: 'user@example.com' } }))
    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(/if that email is registered/i)
    expect(t.state.emails).toHaveLength(0)
    const userUpdates = t.state.updates.filter(u => u.table === 'users')
    expect(userUpdates.every(u => u.id !== 'u1')).toBe(true)   // only the no-op timing-equalizer UPDATE
  })
  it('reserves the slot first, then sends with slotReserved so the throttle is not spent twice', async () => {
    t = await setup()
    await t.mod.forgotPassword(t.c({ body: { email: 'user@example.com' } }))
    expect(t.state.slots).toEqual([{ to: 'user@example.com', template: 'password_reset' }])
    expect(t.state.emails[0].opts).toEqual({ slotReserved: true })
    expect(t.state.updates.some(u => u.table === 'users' && u.id === 'u1' && u.patch.reset_token)).toBe(true)
  })
  // HARDENING (Auth section audit, fresh pass): the known-email branch pays
  // for a real network round trip to Supabase (the reset-token UPDATE)
  // before responding; the unknown-email branch used to pay for nothing
  // extra at all, which is a bigger and easier-to-measure timing tell than
  // the bcrypt gap login()'s getDummyPasswordHash() closes. An unknown email
  // must now issue an equivalent UPDATE — filtered on a value that can never
  // match a real row — so both branches do exactly one users-table UPDATE.
  it('an unknown email still issues an equivalent-cost dummy UPDATE, matching no real user', async () => {
    t = await setup({ userRow: null })
    await t.mod.forgotPassword(t.c({ body: { email: 'ghost@example.com' } }))
    const userUpdates = t.state.updates.filter(u => u.table === 'users')
    expect(userUpdates).toHaveLength(1)
    expect(userUpdates[0].id).not.toBe('u1')
    expect(userUpdates[0].patch).toHaveProperty('reset_token')
  })
})

describe('resetPassword', () => {
  it('rejects an invalid/expired token without revealing why', async () => {
    t = await setup({ userRow: null })
    const res = await t.mod.resetPassword(t.c({ body: { token: 'bad', newPassword: 'longenough' } }))
    expect(res.status).toBe(400)
  })
  it('on success, bumps token_version (invalidating every existing session)', async () => {
    t = await setup({ userRow: baseUserRow({ reset_token: 'hashed', reset_token_expiry: FUTURE(), token_version: 3 }) })
    const res = await t.mod.resetPassword(t.c({ body: { token: 'raw-token', newPassword: 'longenough' } }))
    expect(res.status).toBe(200)
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch.token_version).toBe(4)
  })

  // BUG FIX (round 2): resetting the password is a stronger identity proof
  // than the failed-guess heuristic the login lockout gates on — it must
  // clear any active lockout so the owner isn't still locked out right
  // after doing the one thing the flow exists for.
  it('clears any account lockout on success', async () => {
    t = await setup({ userRow: baseUserRow({ reset_token: 'hashed', reset_token_expiry: FUTURE() }) })
    await t.mod.resetPassword(t.c({ body: { token: 'raw-token', newPassword: 'longenough' } }))
    expect(t.state.successes).toEqual(['user@example.com'])
  })

  it('sends a password-changed confirmation email', async () => {
    t = await setup({ userRow: baseUserRow({ reset_token: 'hashed', reset_token_expiry: FUTURE() }) })
    await t.mod.resetPassword(t.c({ body: { token: 'raw-token', newPassword: 'longenough' } }))
    expect(t.state.emails).toEqual([{ type: 'password_changed', to: 'user@example.com' }])
  })

  it('rejects a new password within the character-count cap but over 72 UTF-8 bytes', async () => {
    t = await setup({ userRow: baseUserRow({ reset_token: 'hashed', reset_token_expiry: FUTURE() }) })
    const newPassword = 'é'.repeat(72)
    await expect(t.mod.resetPassword(t.c({ body: { token: 'raw-token', newPassword } }))).rejects.toBeTruthy()
  })

  // BUG FIX (Auth section audit): changePassword already clears a pending
  // email change on the reasoning "shouldn't survive proving you know the
  // current password" — this endpoint proves an even STRONGER identity check
  // (control of the actual inbox) but never applied the same clearing, so a
  // pending email change staged before the reset could still be confirmed
  // afterward, right through the recovery flow meant to lock that out.
  it('also clears any pending email change on success, same as changePassword', async () => {
    t = await setup({ userRow: baseUserRow({
      reset_token: 'hashed', reset_token_expiry: FUTURE(),
      pending_email: 'new@example.com', pending_email_token: 'x', pending_email_expiry: FUTURE(),
    }) })
    const res = await t.mod.resetPassword(t.c({ body: { token: 'raw-token', newPassword: 'longenough' } }))
    expect(res.status).toBe(200)
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch).toMatchObject({
      pending_email: null, pending_email_token: null, pending_email_expiry: null,
    })
  })
})

describe('resetPassword — additions (Auth/Scan round)', () => {
  it('marks the email verified: following the emailed link proves control of the inbox', async () => {
    t = await setup({ userRow: baseUserRow({ reset_token: 'hashed', reset_token_expiry: FUTURE(), email_verified: false }) })
    const res = await t.mod.resetPassword(t.c({ body: { token: 'raw-token', newPassword: 'a-fresh-passphrase' } }))
    expect(res.status).toBe(200)
    expect(t.state.updates.find(u => u.table === 'users').patch.email_verified).toBe(true)
  })
  it('refuses a new password that is just the account\'s own email address', async () => {
    t = await setup({ userRow: baseUserRow({ reset_token: 'hashed', reset_token_expiry: FUTURE() }) })
    const res = await t.mod.resetPassword(t.c({ body: { token: 'raw-token', newPassword: 'user@example.com' } }))
    expect(res.status).toBe(400)
    expect(t.state.updates).toHaveLength(0)
  })
})

describe('checkResetToken', () => {
  it('reports valid for a live token, invalid otherwise, with no side effects', async () => {
    t = await setup({ userRow: baseUserRow({ reset_token: 'hashed', reset_token_expiry: FUTURE() }) })
    expect((await t.mod.checkResetToken(t.c({ query: { token: 'raw' } }))).body.data.valid).toBe(true)
    expect(t.state.updates).toHaveLength(0)
    t.restore()
    t = await setup({ userRow: null })
    expect((await t.mod.checkResetToken(t.c({ query: { token: 'raw' } }))).body.data.valid).toBe(false)
    expect((await t.mod.checkResetToken(t.c({ query: {} }))).body.data.valid).toBe(false)
  })
})

describe('verifyEmail', () => {
  it('400s with no token', async () => {
    t = await setup()
    expect((await t.mod.verifyEmail(t.c({ query: {} }))).status).toBe(400)
  })
  it('400s for an invalid/expired token', async () => {
    t = await setup({ userRow: null })
    expect((await t.mod.verifyEmail(t.c({ query: { token: 'bad' } }))).status).toBe(400)
  })
  it('flips email_verified on a valid token', async () => {
    t = await setup({ userRow: baseUserRow({ email_verify_token: 'x', email_verify_expiry: FUTURE(), email_verified: false }) })
    const res = await t.mod.verifyEmail(t.c({ query: { token: 'raw' } }))
    expect(res.status).toBe(200)
    expect(t.state.updates[0].patch).toEqual({ email_verified: true, email_verify_expiry: null })
  })
})

describe('verifyEmail — replay of an already-used link', () => {
  // AUDIT FIX (Auth/Scan round)
  it('answers success ("already verified") instead of "invalid or expired", changing nothing', async () => {
    t = await setup({ userRow: null, replayRow: { id: 'u1' } })
    const res = await t.mod.verifyEmail(t.c({ query: { token: 'raw' } }))
    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(/already verified/i)
    expect(t.state.updates).toHaveLength(0)
  })
  it('a genuinely unknown token is still a 400', async () => {
    t = await setup({ userRow: null })
    expect((await t.mod.verifyEmail(t.c({ query: { token: 'nope' } }))).status).toBe(400)
  })
})

describe('resendVerification', () => {
  // AUDIT FIX (Auth/Scan round)
  it('when the recipient slot is exhausted: 429, and the stored token is NOT rotated, nothing sent', async () => {
    t = await setup({ slotDenied: true, sessionUser: { id: 'u1', tokenVersion: 1, emailVerified: false, email: 'user@example.com', name: 'Ada' } })
    const res = await t.mod.resendVerification(t.c())
    expect(res.status).toBe(429)
    expect(t.state.updates).toHaveLength(0)
    expect(t.state.emails).toHaveLength(0)
  })
  it('400s when already verified — and sends nothing', async () => {
    t = await setup({ sessionUser: { id: 'u1', tokenVersion: 1, emailVerified: true } })
    const res = await t.mod.resendVerification(t.c())
    expect(res.status).toBe(400)
    expect(t.state.emails).toHaveLength(0)
  })
  it('sends a fresh verification email when not yet verified', async () => {
    t = await setup({ sessionUser: { id: 'u1', tokenVersion: 1, emailVerified: false, email: 'user@example.com', name: 'Ada' } })
    const res = await t.mod.resendVerification(t.c())
    expect(res.status).toBe(200)
    expect(t.state.emails).toHaveLength(1)
  })
})

describe('changePassword', () => {
  it('400s on an incorrect current password', async () => {
    t = await setup()
    const res = await t.mod.changePassword(t.c({ body: { currentPassword: 'wrong', newPassword: 'longenough' } }))
    expect(res.status).toBe(400)
  })
  it('refuses a "new" password identical to the current one, or equal to the account\'s email', async () => {
    t = await setup()
    let res = await t.mod.changePassword(t.c({ body: { currentPassword: 'correct-password', newPassword: 'correct-password' } }))
    expect(res.status).toBe(400)
    res = await t.mod.changePassword(t.c({ body: { currentPassword: 'correct-password', newPassword: 'user@example.com' } }))
    expect(res.status).toBe(400)
    expect(t.state.updates).toHaveLength(0)
  })
  // BUG FIX being locked in: the response must hand back a token that is
  // valid under the NEW token_version, so the very session that changed the
  // password doesn't get logged out by its own request.
  it('bumps token_version but returns a token that matches the NEW version', async () => {
    t = await setup({ userRow: baseUserRow({ token_version: 5, password_hash: await bcrypt.hash('correct-password', 10) }) })
    const res = await t.mod.changePassword(t.c({ body: { currentPassword: 'correct-password', newPassword: 'longenough' } }))
    expect(res.status).toBe(200)
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch.token_version).toBe(6)
    expect(res.body.data.token).toBeTypeOf('string')
  })
  // FEATURE FIX being locked in: currentPassword is a live bcrypt.compare
  // against attacker-supplied input — the same password-guessing-oracle
  // shape login() already guards with account lockout. Anyone holding a
  // stolen/leaked JWT could otherwise grind guesses here, bounded only by
  // the generic per-IP rate limiter.
  it('a locked-out account is rejected with 429 before any DB read', async () => {
    t = await setup({ locked: { locked: true, retryAfterSeconds: 125 } })
    const res = await t.mod.changePassword(t.c({ body: { currentPassword: 'whatever', newPassword: 'longenough' } }))
    expect(res.status).toBe(429)
    expect(res.body.message).toMatch(/3 minute/)
    expect(t.db.calls).toHaveLength(0)
  })
  it('records a failure on an incorrect current password, keyed by the session user\'s own email', async () => {
    t = await setup()
    await t.mod.changePassword(t.c({ body: { currentPassword: 'wrong', newPassword: 'longenough' } }))
    expect(t.state.failures).toEqual(['user@example.com'])
    expect(t.state.successes).toHaveLength(0)
  })
  it('records a success on a correct current password', async () => {
    t = await setup()
    await t.mod.changePassword(t.c({ body: { currentPassword: 'correct-password', newPassword: 'longenough' } }))
    expect(t.state.successes).toEqual(['user@example.com'])
    expect(t.state.failures).toHaveLength(0)
  })

  it('sends a password-changed confirmation email on success', async () => {
    t = await setup()
    await t.mod.changePassword(t.c({ body: { currentPassword: 'correct-password', newPassword: 'longenough' } }))
    expect(t.state.emails).toEqual([{ type: 'password_changed', to: 'user@example.com' }])
  })

  it('rejects a new password within the character-count cap but over 72 UTF-8 bytes', async () => {
    t = await setup()
    const newPassword = 'é'.repeat(72)
    await expect(t.mod.changePassword(t.c({ body: { currentPassword: 'correct-password', newPassword } }))).rejects.toBeTruthy()
  })

  it('sends a one-time lockout alert email when this failure is the one that locks the account', async () => {
    t = await setup({ justLocked: true })
    await t.mod.changePassword(t.c({ body: { currentPassword: 'wrong', newPassword: 'longenough' } }))
    expect(t.state.emails).toEqual([{ type: 'lockout_alert', to: 'user@example.com' }])
  })

  // BUG FIX being locked in (Section 6, second fixing-time pass): a reset
  // link (a separate credential from any JWT) and a pending email change in
  // flight both used to survive a password change untouched.
  it('clears any outstanding reset token and pending email change', async () => {
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      reset_token: 'sometoken', reset_token_expiry: FUTURE(),
      pending_email: 'new@example.com', pending_email_token: 'x', pending_email_expiry: FUTURE(),
    }) })
    await t.mod.changePassword(t.c({ body: { currentPassword: 'correct-password', newPassword: 'longenough' } }))
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch).toMatchObject({
      reset_token: null, reset_token_expiry: null,
      pending_email: null, pending_email_token: null, pending_email_expiry: null,
    })
  })
})

describe('signOutOtherSessions', () => {
  // FEATURE (Auth section audit): bumps token_version on its own — no
  // password change involved — for someone who just wants to sign a lost/
  // stolen device out.
  it('bumps token_version and returns a fresh token valid under the NEW version', async () => {
    t = await setup({ sessionUser: { id: 'u1', tokenVersion: 5, email: 'user@example.com' } })
    const res = await t.mod.signOutOtherSessions(t.c())
    expect(res.status).toBe(200)
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch).toEqual({ token_version: 6 })
    expect(res.body.data.token).toBeTypeOf('string')
  })
  it('requires no password and touches nothing but token_version', async () => {
    t = await setup({ sessionUser: { id: 'u1', tokenVersion: 1, email: 'user@example.com' } })
    const res = await t.mod.signOutOtherSessions(t.c({ body: {} }))
    expect(res.status).toBe(200)
    expect(t.state.updates).toHaveLength(1)
    expect(Object.keys(t.state.updates[0].patch)).toEqual(['token_version'])
  })
})

describe('updateEmail', () => {
  it('400s on an incorrect password', async () => {
    t = await setup()
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'new@example.com', password: 'wrong' } }))
    expect(res.status).toBe(400)
  })
  it('400s when the "new" email is unchanged', async () => {
    t = await setup()
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'user@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(400)
  })
  it('400s a new email already in use by someone else, WITHOUT touching pending_email', async () => {
    t = await setup({ existingEmailUser: { id: 'someone-else' } })
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'taken@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('That email address is already in use.')
    expect(t.state.updates.find(u => u.table === 'users')).toBeUndefined()
    expect(t.state.emails).toHaveLength(0)
  })
  // BUG FIX being locked in (Section 6, second fixing-time pass): this used
  // to flip `email` immediately, to whatever was sent, and mark the account
  // unverified right away. Now it only stages the change: the live account
  // (including email_verified) is untouched until confirmEmailChange
  // succeeds. The round-2 old-address notice is kept, now fired at this
  // REQUEST step (see the controller's and the template's own comments for
  // why the timing — and therefore the wording — changed).
  it('on success, stages a pending email WITHOUT touching the live email/email_verified, and notifies both addresses', async () => {
    t = await setup()
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'new@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(200)
    expect(res.body.message).toContain('new@example.com')
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch).toMatchObject({ pending_email: 'new@example.com' })
    expect(update.patch.pending_email_token).toBeTypeOf('string')
    expect('email' in update.patch).toBe(false)
    expect('email_verified' in update.patch).toBe(false)
    expect(t.state.emails).toEqual(expect.arrayContaining([
      { type: 'change_confirm', to: 'new@example.com', raw: expect.any(String), opts: { slotReserved: true } },
      { type: 'email_changed_old_address', to: 'user@example.com', newEmail: 'new@example.com' },
    ]))
  })
  // AUDIT FIX (Auth/Scan round)
  it('when the NEW address\'s confirmation slot is exhausted: 429, no pending token staged, nothing sent', async () => {
    t = await setup({ slotDenied: true })
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'new@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(429)
    expect(t.state.updates.filter(u => u.table === 'users')).toHaveLength(0)
    expect(t.state.emails).toHaveLength(0)
  })
  // FEATURE FIX being locked in — same password-guessing-oracle shape as
  // changePassword above: `password` here is a live bcrypt.compare too.
  it('a locked-out account is rejected with 429 before any DB read', async () => {
    t = await setup({ locked: { locked: true, retryAfterSeconds: 65 } })
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'new@example.com', password: 'whatever' } }))
    expect(res.status).toBe(429)
    expect(res.body.message).toMatch(/2 minute/)
    expect(t.db.calls).toHaveLength(0)
  })
  it('records a failure on an incorrect password', async () => {
    t = await setup()
    await t.mod.updateEmail(t.c({ body: { newEmail: 'new@example.com', password: 'wrong' } }))
    expect(t.state.failures).toEqual(['user@example.com'])
  })

  it('sends a one-time lockout alert email when this failure is the one that locks the account', async () => {
    t = await setup({ justLocked: true })
    await t.mod.updateEmail(t.c({ body: { newEmail: 'new@example.com', password: 'wrong' } }))
    expect(t.state.emails).toEqual([{ type: 'lockout_alert', to: 'user@example.com' }])
  })

  it('cancels a pending change back to the current email, when requested with cancelPending', async () => {
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      pending_email: 'new@example.com', pending_email_token: 'x', pending_email_expiry: FUTURE(),
    }) })
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'user@example.com', password: 'correct-password', cancelPending: true } }))
    expect(res.status).toBe(200)
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch).toEqual({ pending_email: null, pending_email_token: null, pending_email_expiry: null })
  })
  it('without cancelPending, "unchanged email" is still a plain 400 even with a pending change present', async () => {
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      pending_email: 'new@example.com', pending_email_token: 'x', pending_email_expiry: FUTURE(),
    }) })
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'user@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(400)
    expect(t.state.updates.find(u => u.table === 'users')).toBeUndefined()
  })
})

describe('confirmEmailChange', () => {
  const RAW = 'a-raw-token'
  async function pendingRow(over = {}) {
    return baseUserRow({
      pending_email: 'new@example.com',
      pending_email_token: await (await import('../src/lib/crypto.js')).sha256(RAW),
      pending_email_expiry: FUTURE(),
      token_version: 4,
      ...over,
    })
  }
  it('400s an unknown/expired token without changing anything', async () => {
    t = await setup({ pendingLookupRow: null })
    const res = await t.mod.confirmEmailChange(t.c({ body: { token: 'nope' } }))
    expect(res.status).toBe(400)
    expect(t.state.updates).toHaveLength(0)
  })
  it('on success, commits the email, verifies it, clears pending_*, bumps token_version and returns a fresh token', async () => {
    const row = await pendingRow()
    t = await setup({ userRow: row, pendingLookupRow: row })
    const res = await t.mod.confirmEmailChange(t.c({ body: { token: RAW } }))
    expect(res.status).toBe(200)
    expect(res.body.data.token).toBeTypeOf('string')
    expect(res.body.data.user.email).toBe('new@example.com')
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch).toMatchObject({
      email: 'new@example.com', email_verified: true,
      pending_email: null, pending_email_token: null, pending_email_expiry: null,
      token_version: 5,
    })
  })
  // BUG FIX (Auth section audit): the account's identity is changing here,
  // same as a password change — resetPassword's own comment establishes that
  // a credential issued BEFORE an identity change shouldn't survive it. A
  // reset_token issued earlier (e.g. from a briefly-compromised old inbox,
  // before the owner moved to this new address) stayed valid for its full
  // window even after the email it was tied to had moved on.
  it('also clears any outstanding password-reset token on success', async () => {
    const row = await pendingRow({ reset_token: 'hashed', reset_token_expiry: FUTURE() })
    t = await setup({ userRow: row, pendingLookupRow: row })
    const res = await t.mod.confirmEmailChange(t.c({ body: { token: RAW } }))
    expect(res.status).toBe(200)
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch).toMatchObject({ reset_token: null, reset_token_expiry: null })
  })
  it('400s if the pending email was claimed by someone else in the meantime, and clears the stale pending_* fields', async () => {
    const row = await pendingRow()
    t = await setup({ userRow: row, pendingLookupRow: row, existingEmailUser: { id: 'someone-else' } })
    const res = await t.mod.confirmEmailChange(t.c({ body: { token: RAW } }))
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('That email address is already in use.')
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch).toEqual({ pending_email: null, pending_email_token: null, pending_email_expiry: null })
  })
})

describe('deleteAccount', () => {
  it('400s on an incorrect password, and touches nothing', async () => {
    t = await setup()
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'wrong' } }))
    expect(res.status).toBe(400)
    expect(t.state.updates).toHaveLength(0)
    expect(t.state.rpcCalls).toHaveLength(0)
  })
  // AUDIT FIX: stale since migration 0022 — this used to assert on two
  // separate app-level `.update()` calls (scans, then users) that deleteAccount
  // has not issued since scrub_account_data (see that migration's comment)
  // replaced them with one atomic RPC. The old assertions here always found
  // `undefined` where they expected the 'scans' update, throwing before ever
  // reaching the 'users' assertions below — this test had been failing on
  // main independent of anything in this round's actual changes. The
  // column-level scrub behavior (scan content nulled, ats_score/status kept,
  // user anonymized, token_version bumped) is what scrub_account_data itself
  // does and is documented/asserted at the SQL level in that migration; what
  // belongs here at the controller boundary is that deleteAccount calls it
  // with the right user, surfaces its error instead of swallowing it, and
  // still does the best-effort R2 cleanup using the scan paths read before
  // the scrub runs.
  it('calls scrub_account_data for the right user and deletes the R2 files read before the scrub', async () => {
    t = await setup({
      scans: [{ id: 's1', resume_path: 'r/1.docx', resume_ats_path: 'r/1-ats.docx', resume_pdf_path: null }],
    })
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))
    expect(res.status).toBe(200)
    expect(t.state.bucketDeletes.sort()).toEqual(['r/1-ats.docx', 'r/1.docx'])
    expect(t.state.rpcCalls).toEqual([{ name: 'scrub_account_data', args: { p_user_id: 'u1' } }])
  })
  it('surfaces a scrub failure as an error and does not report success', async () => {
    t = await setup({ scans: [], rpcError: { message: 'constraint violation' } })
    await expect(t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))).rejects.toThrow('constraint violation')
  })
  // FEATURE FIX being locked in — same password-guessing-oracle shape as
  // changePassword/updateEmail above.
  it('a locked-out account is rejected with 429 before any DB read', async () => {
    t = await setup({ locked: { locked: true, retryAfterSeconds: 65 } })
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'whatever' } }))
    expect(res.status).toBe(429)
    expect(res.body.message).toMatch(/2 minute/)
    expect(t.db.calls).toHaveLength(0)
  })
  it('records a failure on an incorrect password', async () => {
    t = await setup()
    await t.mod.deleteAccount(t.c({ body: { password: 'wrong' } }))
    expect(t.state.failures).toEqual(['user@example.com'])
  })

  it('sends a one-time lockout alert email when this failure is the one that locks the account', async () => {
    t = await setup({ justLocked: true })
    await t.mod.deleteAccount(t.c({ body: { password: 'wrong' } }))
    expect(t.state.emails).toEqual([{ type: 'lockout_alert', to: 'user@example.com' }])
  })

  // FEATURE (Auth section round 2): sent to the address the account had a
  // moment ago — captured before scrub_account_data overwrites it with a
  // placeholder (migration 0022).
  it('sends an account-deleted confirmation to the pre-scrub email address', async () => {
    t = await setup({ scans: [] })
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))
    expect(res.status).toBe(200)
    expect(t.state.emails).toEqual([{ type: 'account_deleted', to: 'user@example.com' }])
  })
})

describe('claimScan', () => {
  it('404s for a missing/expired/already-claimed anon scan', async () => {
    t = await setup({ claimScanResult: null })
    const res = await t.mod.claimScan(t.c({ body: { anonToken: 'x' } }))
    expect(res.status).toBe(404)
  })
  it('links the scan to the account and clears its anon fields', async () => {
    t = await setup({ claimScanResult: { id: 's1', status: 'COMPLETE_PASS' } })
    const res = await t.mod.claimScan(t.c({ body: { anonToken: 'x' } }))
    expect(res.status).toBe(200)
    expect(res.body.data.scanId).toBe('s1')
    const update = t.state.updates.find(u => u.table === 'scans')
    expect(update.patch).toEqual({ user_id: 'u1', anon_token: null, anon_expires_at: null, contact_name: null, contact_email: null })
  })
})

// ── Section 9/10 hardening on top of the round-2 auth pass ─────────────────

describe('unchecked-write bug class: a failed DB write must never be reported as success', () => {
  const dbErr = new Error('connection reset by peer')
  it('forgotPassword: if the token cannot be stored, no reset email is sent (it would be a dead link)', async () => {
    t = await setup({ userUpdateError: dbErr })
    await expect(t.mod.forgotPassword(t.c({ body: { email: 'user@example.com' } }))).rejects.toThrow()
    expect(t.state.emails).toHaveLength(0)
  })
  it('verifyEmail: a failed update rejects', async () => {
    t = await setup({ userRow: baseUserRow({ email_verify_token: 'x', email_verify_expiry: FUTURE(), email_verified: false }), userUpdateError: dbErr })
    await expect(t.mod.verifyEmail(t.c({ query: { token: 'raw' } }))).rejects.toThrow()
  })
  it('resendVerification: if the token cannot be stored, no email is sent', async () => {
    t = await setup({ sessionUser: { id: 'u1', tokenVersion: 1, emailVerified: false, email: 'user@example.com', name: 'Ada' }, userUpdateError: dbErr })
    await expect(t.mod.resendVerification(t.c())).rejects.toThrow()
    expect(t.state.emails).toHaveLength(0)
  })
  it('claimScan: a failed update rejects', async () => {
    t = await setup({ claimScanResult: { id: 's1', status: 'COMPLETE_PASS' }, scanUpdateError: dbErr })
    await expect(t.mod.claimScan(t.c({ body: { anonToken: 'x' } }))).rejects.toThrow()
  })
})

describe('input bounds', () => {
  it('login refuses an absurdly long password (no free CPU burn) but accepts any sane existing one', async () => {
    t = await setup()
    await expect(t.mod.login(t.c({ body: { email: 'user@example.com', password: 'x'.repeat(5000) } }))).rejects.toBeTruthy()
    const ok = await t.mod.login(t.c({ body: { email: 'user@example.com', password: 'correct-password' } }))
    expect(ok.status).toBe(200)
  })
  it('register rejects an absurdly long email before ever touching the DB', async () => {
    t = await setup()
    await expect(t.mod.register(t.c({ body: { name: 'A', email: 'a'.repeat(260) + '@b.com', password: 'longenough' } }))).rejects.toBeTruthy()
    expect(t.db.calls).toHaveLength(0)
  })
  it('changePassword/updateEmail/deleteAccount refuse an absurdly long checked password too', async () => {
    t = await setup()
    await expect(t.mod.changePassword(t.c({ body: { currentPassword: 'x'.repeat(5000), newPassword: 'longenough' } }))).rejects.toBeTruthy()
    t = await setup()
    await expect(t.mod.updateEmail(t.c({ body: { newEmail: 'new@example.com', password: 'x'.repeat(5000) } }))).rejects.toBeTruthy()
    t = await setup()
    await expect(t.mod.deleteAccount(t.c({ body: { password: 'x'.repeat(5000) } }))).rejects.toBeTruthy()
  })
})

describe('deleteAccount — email_logs purge', () => {
  it('purges email_logs for the account address after a successful deletion', async () => {
    t = await setup({ scans: [] })
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))
    expect(res.status).toBe(200)
    // Both the real address (the confirmation's own row) and the placeholder
    // scrub_account_data renamed every EARLIER row to — purging only the real
    // address left all of those behind.
    expect(t.state.logPurges).toEqual([['user@example.com', 'deleted-u1@passthrough.dev']])
  })
  it('a failed scrub purges nothing (the account was not actually deleted)', async () => {
    t = await setup({ scans: [], rpcError: { message: 'constraint violation' } })
    await expect(t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))).rejects.toThrow()
    expect(t.state.logPurges).toHaveLength(0)
  })
  // BUG FIX (Auth section audit, fresh pass): sendAccountDeleted used to be
  // fired via waitUntil (fire-and-forget) with the purge below running
  // synchronously right after — not after the send actually finished. Since
  // send() only inserts this email's own email_logs row once the outbound
  // call completes, and an external Resend round trip is essentially always
  // slower than one Supabase DELETE, the purge would typically win the race
  // and run BEFORE this email's own log row existed — leaving exactly the
  // row "no trace... survives" was supposed to prevent. The confirmation
  // email must now be fully sent (awaited) before the purge runs.
  it('sends and logs the account-deleted confirmation BEFORE purging that address\'s email_logs — not merely before it, in scheduling order', async () => {
    t = await setup({ scans: [] })
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))
    expect(res.status).toBe(200)
    expect(t.state.callOrder).toEqual(['account-deleted-email', 'log-purge'])
  })
})

// ── Section 6 traces: unchecked writes + deleting while work is in flight ───

describe('password / pending-email writes are checked (lib/db.js\'s own rule)', () => {
  const dbErr = new Error('connection reset by peer')
  it('changePassword: a failed write is an error — no success, no "password changed" email, no token', async () => {
    t = await setup({ userUpdateError: dbErr })
    await expect(t.mod.changePassword(t.c({ body: { currentPassword: 'correct-password', newPassword: 'longenough' } }))).rejects.toThrow()
    expect(t.state.emails.filter(e => e.type === 'password_changed')).toHaveLength(0)
  })
  it('resetPassword: a failed write is an error, not "password reset"', async () => {
    t = await setup({ userRow: baseUserRow({ reset_token: 'hashed', reset_token_expiry: FUTURE() }), userUpdateError: dbErr })
    await expect(t.mod.resetPassword(t.c({ body: { token: 'raw', newPassword: 'longenough' } }))).rejects.toThrow()
    expect(t.state.emails.filter(e => e.type === 'password_changed')).toHaveLength(0)
  })
  it('updateEmail cancelPending: a failed write is an error, not "Email change canceled."', async () => {
    t = await setup({ userRow: baseUserRow({
      password_hash: await bcrypt.hash('correct-password', 10),
      pending_email: 'new@example.com', pending_email_token: 'x', pending_email_expiry: FUTURE(),
    }), userUpdateError: dbErr })
    await expect(t.mod.updateEmail(t.c({ body: { newEmail: 'user@example.com', password: 'correct-password', cancelPending: true } }))).rejects.toThrow()
  })
})

describe('deleteAccount — work in flight', () => {
  it('409s, and touches nothing, while a scan or fix is still being produced', async () => {
    t = await setup({ scans: [], inFlightCount: 1 })
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/still being processed/)
    expect(t.state.rpcCalls).toHaveLength(0)
    expect(t.state.bucketDeletes).toHaveLength(0)
    expect(t.state.emails).toHaveLength(0)
  })
  it('checks only recent work, so a dead job can never make an account undeletable', async () => {
    t = await setup({ scans: [] })
    await t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))
    const q = t.db.calls.find(c => c.table === 'scans' && c.selectOpts?.head)
    expect(q.filters.find(f => f[0] === 'in')[2]).toEqual(['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING'])
    const since = q.filters.find(f => f[0] === 'gt' && f[1] === 'updated_at')[2]
    expect(Date.now() - Date.parse(since)).toBeGreaterThan(59 * 60 * 1000)
    expect(Date.now() - Date.parse(since)).toBeLessThan(61 * 60 * 1000)
  })
})

// Names: one shared definition (lib/text.js) for register and updateName.
describe('name validation (register + updateName)', () => {
  const register = (name) => t.mod.register(t.c({ body: { name, email: 'ada@example.com', password: 'longenough', acceptTerms: true } }))
  it('updateName stores the cleaned name: control characters and zero-width filler gone, spaces collapsed', async () => {
    t = await setup()
    await t.mod.updateName(t.c({ body: { name: '  Ada \u200b  Lovelace\u0007 ' } }))
    expect(t.state.updates.find(u => u.table === 'users').patch).toEqual({ name: 'Ada Lovelace' })
  })
  it('register still accepts an ordinary name with the same cleaning applied', async () => {
    t = await setup()
    expect((await register('  Ada \u200b  Lovelace ')).status).toBe(201)
  })
  it('register and updateName both refuse a name with no letter or digit in it (zero-width only, punctuation only)', async () => {
    t = await setup()
    for (const bad of ['\u200b', '\u200b\ufeff', '---', '   ']) {
      await expect(register(bad)).rejects.toBeTruthy()
      await expect(t.mod.updateName(t.c({ body: { name: bad } }))).rejects.toBeTruthy()
    }
  })
})
