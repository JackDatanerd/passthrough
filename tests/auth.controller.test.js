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
  const state = { updates: [], emails: [], lockoutChecks: [], failures: [], successes: [], bucketDeletes: [] }
  const userRow = 'userRow' in opts ? opts.userRow : await (async () => baseUserRow({ password_hash: await bcrypt.hash('correct-password', 10) }))()

  const db = createFakeSupabase(q => {
    if (q.table === 'users' && q.op === 'select') return { data: userRow, error: opts.selectError || null }
    if (q.table === 'users' && q.op === 'insert') return { data: opts.insertedRow ?? baseUserRow({ id: 'new1', password_hash: 'x' }), error: opts.insertError || null }
    if (q.table === 'users' && q.op === 'update') {
      state.updates.push({ table: 'users', patch: q.patch, id: eqValue(q, 'id') })
      return { data: opts.updatedUserRow ?? { ...userRow, ...q.patch }, error: null }
    }
    if (q.table === 'scans' && q.op === 'select') {
      // claimScan's lookup uses .maybeSingle() (a single row or null);
      // deleteAccount's uses a plain array select — same table+op, so
      // distinguish by that instead of trying to give them one shared shape.
      if (q.maybe) return { data: 'claimScanResult' in opts ? opts.claimScanResult : null, error: null }
      return { data: opts.scans ?? [], error: null }
    }
    if (q.table === 'scans' && q.op === 'update') { state.updates.push({ table: 'scans', patch: q.patch }); return { error: null } }
    return undefined
  })

  const { mod, restore } = loadWithStubs('controllers/auth.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendWelcome:       async (...a) => { state.emails.push({ type: 'welcome', to: a[2] }) },
      sendVerification:  async (...a) => { state.emails.push({ type: 'verify', to: a[2], raw: a[4] }) },
      sendPasswordReset: async (...a) => { state.emails.push({ type: 'reset', to: a[2], raw: a[4] }) },
    },
    'middleware/rateLimiter.js': {
      checkAccountLockout: async (env, email) => { state.lockoutChecks.push(email); return opts.locked ?? { locked: false, retryAfterSeconds: null } },
      recordLoginFailure:  async (env, email) => { state.failures.push(email) },
      recordLoginSuccess:  async (env, email) => { state.successes.push(email) },
    },
  })

  const env = {
    JWT_SECRET: 'test-secret-at-least-this-long',
    JWT_EXPIRES_IN_SECONDS: '604800',
    RESUMES_BUCKET: { delete: async key => { state.bucketDeletes.push(key) } },
  }
  const c = (over = {}) => ({
    env,
    get: k => ({ user: opts.sessionUser ?? { id: 'u1', tokenVersion: 1, emailVerified: true }, tokenExp: opts.tokenExp }[k]),
    req: {
      json: async () => (over.body ?? {}),
      query: k => (over.query ?? {})[k],
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
  it('on success, marks the account unverified again and emails the NEW address', async () => {
    t = await setup()
    const res = await t.mod.updateEmail(t.c({ body: { newEmail: 'new@example.com', password: 'correct-password' } }))
    expect(res.status).toBe(200)
    const update = t.state.updates.find(u => u.table === 'users')
    expect(update.patch.email_verified).toBe(false)
    expect(t.state.emails).toEqual([{ type: 'verify', to: 'new@example.com', raw: expect.any(String) }])
  })
})

describe('deleteAccount', () => {
  it('400s on an incorrect password, and touches nothing', async () => {
    t = await setup()
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'wrong' } }))
    expect(res.status).toBe(400)
    expect(t.state.updates).toHaveLength(0)
  })
  it('scrubs scan content, deletes R2 files, and anonymizes the user row — but keeps score/fix_tier', async () => {
    t = await setup({
      scans: [{ id: 's1', resume_path: 'r/1.docx', resume_ats_path: 'r/1-ats.docx', resume_pdf_path: null }],
    })
    const res = await t.mod.deleteAccount(t.c({ body: { password: 'correct-password' } }))
    expect(res.status).toBe(200)
    expect(t.state.bucketDeletes.sort()).toEqual(['r/1-ats.docx', 'r/1.docx'])

    const scanUpdate = t.state.updates.find(u => u.table === 'scans')
    expect(scanUpdate.patch.job_description_text).toBeNull()
    expect(scanUpdate.patch).not.toHaveProperty('ats_score')
    expect(scanUpdate.patch).not.toHaveProperty('status')

    const userUpdate = t.state.updates.find(u => u.table === 'users')
    expect(userUpdate.patch.deleted_at).toBeTypeOf('string')
    expect(userUpdate.patch.saved_profile).toBeNull()
    expect(userUpdate.patch.token_version).toBe(2)
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
    expect(update.patch).toEqual({ user_id: 'u1', anon_token: null, anon_expires_at: null })
  })
})
