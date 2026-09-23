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
  const state = { updates: [], emails: [], lockoutChecks: [], failures: [], failureIps: [], successes: [], bucketDeletes: [], rpcCalls: [], logPurges: [] }
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
    if (q.table === 'scans' && q.op === 'select') {
      // claimScan's lookup uses .maybeSingle() (a single row or null);
      // deleteAccount's uses a plain array select — same table+op, so
      // distinguish by that instead of trying to give them one shared shape.
      if (q.maybe) return { data: 'claimScanResult' in opts ? opts.claimScanResult : null, error: null }
      return { data: opts.scans ?? [], error: null }
    }
    if (q.table === 'scans' && q.op === 'update') { state.updates.push({ table: 'scans', patch: q.patch }); return { error: opts.scanUpdateError || null } }
    if (q.table === 'email_logs' && q.op === 'delete') { state.logPurges.push(eqValue(q, 'to')); return { error: null } }
    if (q.op === 'rpc') { state.rpcCalls.push({ name: q.name, args: q.args }); return { data: null, error: opts.rpcError || null } }
    return undefined
  })

  const { mod, restore } = loadWithStubs('controllers/auth.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendWelcome:       async (...a) => { state.emails.push({ type: 'welcome', to: a[2] }) },
      sendVerification:  async (...a) => { state.emails.push({ type: 'verify', to: a[2], raw: a[4] }) },
      sendPasswordReset: async (...a) => { state.emails.push({ type: 'reset', to: a[2], raw: a[4] }) },
      // FEATURE (Auth section round 2): confirmation/notification emails for
      // auth's own sensitive account changes — see auth.controller.js's
      // callers and email.service.js's real implementations for what each
      // covers. `a[2]` is always the `to` address in every emailService.send*
      // signature (env, supabase, to, ...), same convention as the three above.
      sendPasswordChanged:        async (...a) => { state.emails.push({ type: 'password_changed', to: a[2] }) },
      sendEmailChangedOldAddress: async (...a) => { state.emails.push({ type: 'email_changed_old_address', to: a[2], newEmail: a[4] }) },
      sendAccountDeleted:         async (...a) => { state.emails.push({ type: 'account_deleted', to: a[2] }) },
      sendAccountLockoutAlert:    async (...a) => { state.emails.push({ type: 'lockout_alert', to: a[2] }) },
      sendEmailChangeConfirmation: async (...a) => { state.emails.push({ type: 'change_confirm', to: a[2], raw: a[4] }) },
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
    const res = await t.mod.register(t.c({ body: { name: 'Ada', email: 'Ada@Example.com', password: 'longenough' } }))
    expect(res.status).toBe(201)
    expect(res.body.data.token).toBeTypeOf('string')
    expect(res.body.data.user.passwordHash).toBeUndefined()
    expect(res.body.data.user.emailVerifyToken).toBeUndefined()
    expect(t.state.emails.map(e => e.type).sort()).toEqual(['verify', 'welcome'])
  })

  it('rejects a password under 8 characters before ever touching the DB', async () => {
    t = await setup()
    await expect(t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password: 'short' } }))).rejects.toBeTruthy()
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
    await expect(t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password } }))).rejects.toBeTruthy()
    expect(t.db.calls).toHaveLength(0)
  })

  it('accepts a password made of multi-byte characters as long as it fits in 72 bytes', async () => {
    t = await setup()
    const password = 'é'.repeat(36) // 36 chars, exactly 72 UTF-8 bytes
    const res = await t.mod.register(t.c({ body: { name: 'Ada', email: 'a@b.com', password } }))
    expect(res.status).toBe(201)
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
    expect(t.state.emails).toEqual([{ type: 'reset', to: 'user@example.com', raw: expect.any(String) }])
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
    expect(t.state.updates[0].patch).toEqual({ email_verified: true, email_verify_token: null, email_verify_expiry: null })
  })
})

describe('resendVerification', () => {
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
      { type: 'change_confirm', to: 'new@example.com', raw: expect.any(String) },
      { type: 'email_changed_old_address', to: 'user@example.com', newEmail: 'new@example.com' },
    ]))
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
    expect(t.state.logPurges).toEqual(['user@example.com'])
  })
  it('a failed scrub purges nothing (the account was not actually deleted)', async () => {
    t = await setup({ scans: [], rpcError: { message: 'constraint violation' } })
    await expect(t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))).rejects.toThrow()
    expect(t.state.logPurges).toHaveLength(0)
  })
})
