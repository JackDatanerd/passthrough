// Ported from Express to Hono. Key mechanical changes throughout this file:
//   - (req, res, next)        -> async (c) => {...}, return c.json(body, status)
//   - req.body                -> await c.req.json()
//   - req.query.x              -> c.req.query('x')
//   - req.user                 -> c.get('user')  (set by middleware/auth.js)
//   - jwt.sign / crypto.*      -> lib/jwt.js + lib/crypto.js (Web Crypto)
//   - prisma.user.X            -> supabase.from('users').X + lib/mappers.js
//   - { increment: 1 }         -> read the already-fetched row's value + 1
//     (every function below that needs this already fetched the user row
//     for a password check, so no extra read is required)
//   - try/catch + next(err)    -> removed; thrown errors (including Zod's)
//     propagate to the global errorHandler registered via app.onError()
//     in src/index.js — same end result as v8's centralised error handling.
//
// Security properties are unchanged: tokens SHA-256 hashed before storage,
// raw token only ever in the email, tokenVersion bump invalidates all
// sessions on password change/reset, BANNED/deletedAt checks preserved.

const bcrypt = require('bcryptjs')
const { z }  = require('zod')
const jwtLib    = require('../lib/jwt')
const cryptoLib = require('../lib/crypto')
const { getSupabase } = require('../config/supabase')
const { userRowToCamel, scanRowToCamel } = require('../lib/mappers')
const emailService = require('../services/email.service')
const constants     = require('../config/constants')
const { checkAccountLockout, recordLoginFailure, recordLoginSuccess, LOCKOUT_MINUTES } = require('../middleware/rateLimiter')

// FEATURE (Auth section round 2): fires the one-time lockout email exactly
// when recordLoginFailure() reports the transition into a lock, from any of
// the four call sites below that have a real user row in hand (the
// no-such-account branch in login() never reaches this — there's no inbox
// to notify). waitUntil, not fire-and-forget — see register()'s comment.
function maybeSendLockoutAlert(c, result, user) {
  if (result?.justLocked) {
    c.executionCtx.waitUntil(
      emailService.sendAccountLockoutAlert(c.env, getSupabase(c.env), user.email, user.name, LOCKOUT_MINUTES)
        .catch(e => console.error('Lockout alert email:', e.message))
    )
  }
}

// AUDIT FIX (bug — account-lockout DoS): recordLoginFailure now needs the
// requester's IP (see rateLimiter.js's LOCKOUT_MIN_DISTINCT_IPS comment) —
// same header precedence scan.controller.js's quota-bypass check already
// uses, centralized here since four handlers in this file need it.
function clientIp(c) {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'
}

async function issueJWT(env, user) {
  const expiresIn = parseInt(env.JWT_EXPIRES_IN_SECONDS, 10) || 604800 // 7 days default
  return jwtLib.sign({ userId: user.id, tokenVersion: user.tokenVersion }, env.JWT_SECRET, expiresIn)
}

function safeUser(user) {
  const {
    passwordHash, paystackAuthCode, paystackCustomerCode,
    resetToken, emailVerifyToken, resetTokenExpiry, emailVerifyExpiry,
    savedProfile, ...safe
  } = user
  return safe
}

function expiry(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

// HARDENING: used so login() can run a bcrypt.compare of roughly the same
// cost against it when no matching user exists. Without this, an unknown
// email short-circuits straight to the 401 while a known email always pays
// the ~100ms+ bcrypt.compare cost first — same response body either way
// ("Invalid credentials"), but the timing difference lets an attacker
// enumerate registered emails by measuring response latency. The hash
// itself is thrown away after use — it never gets compared against real
// user data, it's purely there to burn a comparable amount of CPU time.
//
// Computed lazily on first use (memoized in module scope, not module LOAD)
// rather than as a top-level `const X = bcrypt.hashSync(...)` — Workers
// forbids I/O/randomness-requiring operations at module top level, outside
// a request context. A top-level hashSync() call passes local dev/`wrangler
// dev` (which is more permissive) but hard-fails Cloudflare's deploy-time
// startup validation, which is exactly what happened here: this is a real
// bug that would otherwise have shipped fine locally and only broken in
// production on the actual `wrangler deploy`.
let dummyPasswordHash = null
async function getDummyPasswordHash() {
  if (!dummyPasswordHash) {
    dummyPasswordHash = await bcrypt.hash('passthrough-timing-equalizer', 10)
  }
  return dummyPasswordHash
}

// AUDIT FIX: email was stored and compared case-sensitively everywhere
// except the newer updateEmail() below (which already normalized via
// .toLowerCase()) — the schema's `email text not null unique` constraint
// is case-sensitive Postgres text comparison, and nothing in register/
// login/forgotPassword folded case before reading or writing it. Two
// consequences: "User@Example.com" and "user@example.com" could register
// as two independent accounts sharing one real inbox, and a real user
// whose email got re-cased by autocapitalize/autofill between signup and
// login got an indistinguishable "Invalid credentials". Normalizing here
// at every read/write site closes both; see 0017_case_insensitive_email.sql
// for the matching DB-level backstop against races/other write paths.
const emailSchema = z.string().trim().toLowerCase().email()

// BUG FIX (round 2 of the password-length audit): the earlier `.max(72)` on
// a raw z.string() only bounds JS string length (UTF-16 code units), not the
// UTF-8 byte length bcryptjs actually truncates at. Any password using
// multi-byte characters — accented letters, non-Latin scripts, emoji — can
// have a `.length` of 72 or less while still being well over 72 BYTES, so it
// sails past validation and then gets silently truncated by bcrypt anyway:
// exactly the "false confidence in extra length that does nothing" problem
// the original fix was meant to close, just one level deeper. Verified
// directly against bcryptjs: a password of 72 'é' characters is 144 bytes,
// and two such passwords differing only after the 72-byte mark hash
// identically and both compare as valid.
//
// `min(8)` stays character-based — bcrypt has no equivalent lower-bound
// quirk, and a shorter multi-byte password is never a weaker one, so
// counting characters there is fine. Only the upper bound needs to be
// byte-aware.
const PASSWORD_MAX_BYTES = 72
function passwordSchema(minMessage) {
  return z.string()
    .min(8, minMessage || 'Password must be at least 8 characters')
    .refine(pw => new TextEncoder().encode(pw).length <= PASSWORD_MAX_BYTES, {
      message: 'Password is too long (max 72 bytes — some characters, like emoji or accented letters, count as more than one byte).'
    })
}

// POST /api/auth/register
async function register(c) {
  const body = await c.req.json()
  const { name, email, password } = z.object({
    // BUG FIX: unlike updateName's schema (below), this never trimmed —
    // a name of pure whitespace passed `min(1)` (whitespace still counts
    // toward length) and got stored/emailed verbatim as a blank-looking
    // name. updateName rejects that same input; register let it through.
    name:     z.string().trim().min(1).max(100),
    email:    emailSchema,
    // BUG FIX: no upper bound anywhere a password is set (here, reset,
    // change) — bcryptjs silently truncates at 72 bytes, so anything past
    // that is quietly ignored with no error, giving false confidence in
    // extra length that does nothing. passwordSchema() (see above) turns
    // that into an explicit, honest validation error instead of a silent
    // no-op — byte-aware, not just character-count-aware.
    password: passwordSchema()
  }).parse(body)

  const supabase = getSupabase(c.env)
  const passwordHash = await bcrypt.hash(password, 10)
  const raw    = cryptoLib.randomToken(32)
  const stored = await cryptoLib.sha256(raw)
  const exp    = expiry(constants.EMAIL_TOKEN_EXPIRY_HOURS)

  const { data: row, error } = await supabase
    .from('users')
    .insert({ name, email, password_hash: passwordHash, email_verify_token: stored, email_verify_expiry: exp })
    .select().single()
  if (error) throw error
  const user = userRowToCamel(row)

  // Send both emails without delaying the response — but MUST be wrapped in
  // waitUntil(), not truly fire-and-forget. Once this function returns its
  // Response, Workers can terminate the execution context; any promise not
  // explicitly protected by waitUntil() (or awaited beforehand) can be
  // silently cancelled mid-flight, with no error and no log — which is
  // exactly what was happening here before this fix.
  c.executionCtx.waitUntil(
    emailService.sendWelcome(c.env, supabase, email, name).catch(e => console.error('Welcome email:', e.message))
  )
  c.executionCtx.waitUntil(
    emailService.sendVerification(c.env, supabase, email, name, raw).catch(e => console.error('Verify email:', e.message))
  )

  return c.json({ success: true,
    data: { token: await issueJWT(c.env, user), user: safeUser(user) } }, 201)
}

// POST /api/auth/login
async function login(c) {
  const body = await c.req.json()
  const { email, password } = z.object({
    email:    emailSchema,
    password: z.string()
  }).parse(body)

  // AUDIT FIX (Section 9, feature gap): account-level lockout, independent
  // of and in addition to the IP-keyed `rl.auth` limiter on this route —
  // see rateLimiter.js's checkAccountLockout comment for why the IP limiter
  // alone doesn't cover a distributed attack against one account. Checked
  // before any DB work, and checked identically for every email (real
  // account or not) so a lockout response itself never reveals whether the
  // account exists.
  const lockout = await checkAccountLockout(c.env, email)
  if (lockout.locked) {
    return c.json({ success: false,
      message: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`
    }, 429)
  }

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase
    .from('users').select('*').eq('email', email).is('deleted_at', null).maybeSingle()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!user) {
    // HARDENING: burn a comparable amount of time to the real-user path
    // below (bcrypt.compare against a throwaway hash) before responding,
    // so "no such email" and "wrong password" aren't distinguishable by
    // response latency. See getDummyPasswordHash() above.
    await bcrypt.compare(password, await getDummyPasswordHash())
    await recordLoginFailure(c.env, email, clientIp(c))
    return c.json({ success: false, message: 'Invalid credentials' }, 401)
  }
  // AUDIT FIX: the BANNED check used to run BEFORE the password compare,
  // returning 403 "Account suspended" for ANY password on a banned email —
  // no bcrypt.compare() paid at all. That directly defeated the timing-
  // equalization hardening just above: an attacker could confirm "this
  // email exists and is banned" with a single request and no guessing,
  // via both the distinct message and the near-instant response (versus
  // the ~100ms bcrypt cost every other branch pays). Checking the password
  // first means a wrong guess against a banned account looks identical
  // (message AND timing) to a wrong guess against an active one — status
  // is only revealed once the credential itself has been proven correct.
  if (!await bcrypt.compare(password, user.passwordHash)) {
    const failResult = await recordLoginFailure(c.env, email, clientIp(c))
    maybeSendLockoutAlert(c, failResult, user)
    return c.json({ success: false, message: 'Invalid credentials' }, 401)
  }
  if (user.status === 'BANNED')
    return c.json({ success: false, message: 'Account suspended.', code: 'BANNED' }, 403)

  await recordLoginSuccess(c.env, email)
  return c.json({ success: true, data: { token: await issueJWT(c.env, user), user: safeUser(user) } })
}

// GET /api/auth/me
// AUDIT FIX (feature gap): there was no renewal path on the 7-day JWT at
// all — an active daily user got hard-logged-out the instant it lapsed,
// mid-session, no warning, since nothing ever reissued it early. getMe()
// already runs on every app load and dashboard visit (see AuthContext.jsx/
// dashboard pages' refreshUser() calls), so it's a natural, low-effort
// place to silently top it up: if less than 24h remains on the token that
// authenticated THIS request, mint a fresh 7-day one and hand it back
// alongside the user object. The frontend only needs to notice `token` is
// present and re-store it (see AuthContext.jsx's refreshUser) — no new
// polling, no separate refresh endpoint, no behavior change for a request
// that's already comfortably inside its window.
const TOKEN_RENEW_THRESHOLD_SECONDS = 24 * 60 * 60
async function getMe(c) {
  const user = c.get('user')
  const tokenExp = c.get('tokenExp')
  let token
  if (typeof tokenExp === 'number') {
    const remaining = tokenExp - Math.floor(Date.now() / 1000)
    if (remaining < TOKEN_RENEW_THRESHOLD_SECONDS) {
      token = await issueJWT(c.env, { id: user.id, tokenVersion: user.tokenVersion })
    }
  }
  return c.json({ success: true, data: { user, ...(token ? { token } : {}) } })
}

// POST /api/auth/forgot-password
async function forgotPassword(c) {
  const body = await c.req.json()
  const { email } = z.object({ email: emailSchema }).parse(body)
  const supabase = getSupabase(c.env)

  // BUG FIX: this was the one query in the file that didn't capture/check
  // `error` — every sibling lookup (login, resetPassword, verifyEmail, ...)
  // does `if (error) throw error`. A transient DB failure here took the
  // exact same path as "no such email": `row` stayed undefined, `user`
  // came out null, and the handler returned its normal 200 success message
  // with nothing logged anywhere — a real outage on this endpoint was
  // completely invisible, both to the user (told to check an inbox that
  // was never going to get an email) and to us (no error surfaced at all).
  const { data: row, error } = await supabase
    .from('users').select('*').eq('email', email).is('deleted_at', null).eq('status', 'ACTIVE').maybeSingle()
  if (error) throw error
  const user = userRowToCamel(row)

  if (user) {
    const raw    = cryptoLib.randomToken(32)
    const stored = await cryptoLib.sha256(raw)
    const exp    = expiry(constants.RESET_TOKEN_EXPIRY_HOURS)

    await supabase.from('users').update({ reset_token: stored, reset_token_expiry: exp }).eq('id', user.id)
    // waitUntil, not fire-and-forget — see register()'s comment for why.
    c.executionCtx.waitUntil(
      emailService.sendPasswordReset(c.env, supabase, email, user.name, raw)
        .catch(e => console.error('Reset email:', e.message))
    )
  }

  // Always return same message — don't reveal if email is registered
  return c.json({ success: true, message: 'If that email is registered, check your inbox.' })
}

// POST /api/auth/reset-password
async function resetPassword(c) {
  const body = await c.req.json()
  const { token, newPassword } = z.object({
    token:       z.string(),
    // BUG FIX: see register()'s matching comment and passwordSchema() above —
    // bcryptjs truncates past 72 BYTES, not 72 characters, with no error.
    newPassword: passwordSchema()
  }).parse(body)

  const supabase = getSupabase(c.env)
  const stored = await cryptoLib.sha256(token)
  // AUDIT FIX: this lookup used to match on the token/expiry alone, with no
  // deleted_at/status check — a reset token issued while the account was
  // still ACTIVE could still be "successfully" consumed after the account
  // was later banned or soft-deleted (login() blocks both, so it granted
  // no way back in today, but a token-only flow silently mutating a
  // banned/deleted row is the wrong default, and the "harmless today"
  // argument breaks the moment anything else ever trusts this row's
  // password_hash). Every other mutation in this file already runs behind
  // a live session (auth middleware, which enforces this) — these two
  // token-only flows are the exception, so the check is added explicitly.
  const { data: row, error } = await supabase
    .from('users').select('*').eq('reset_token', stored)
    .gt('reset_token_expiry', new Date().toISOString())
    .is('deleted_at', null).eq('status', 'ACTIVE').maybeSingle()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!user) return c.json({ success: false, message: 'Reset link invalid or expired.' }, 400)

  await supabase.from('users').update({
    password_hash:      await bcrypt.hash(newPassword, 10),
    reset_token:        null,
    reset_token_expiry: null,
    token_version:       user.tokenVersion + 1  // kills all existing sessions
  }).eq('id', user.id)

  // BUG FIX (account lockout, section audit round 2): proving control of the
  // account's inbox — clicking a time-limited, single-use emailed link — is a
  // far stronger identity check than the "8 failed guesses from 2+ IPs" the
  // login lockout gates on, but this endpoint never cleared that lockout.
  // A real owner using the reset flow BECAUSE their account got locked
  // (whether by an actual credential-stuffing attempt or by a run of their
  // own typos) would set a brand-new password and then still be locked out
  // of using it for up to LOCKOUT_MINUTES more — the one flow specifically
  // meant to hand control back to them didn't. Clearing it here is the same
  // call login() makes on a successful password check.
  await recordLoginSuccess(c.env, user.email)

  // FEATURE (Auth section round 2): see sendPasswordChanged's comment —
  // resetPassword is the other of the two paths that leave the password
  // different, so it gets the same confirmation changePassword does.
  c.executionCtx.waitUntil(
    emailService.sendPasswordChanged(c.env, supabase, user.email, user.name)
      .catch(e => console.error('Password-changed email:', e.message))
  )

  return c.json({ success: true, message: 'Password reset. Please log in.' })
}

// GET /api/auth/verify-email?token=xxx
async function verifyEmail(c) {
  const token = c.req.query('token')
  if (!token) return c.json({ success: false, message: 'Token required.' }, 400)

  const supabase = getSupabase(c.env)
  const stored = await cryptoLib.sha256(token)
  // AUDIT FIX: same gap as resetPassword above — add the deleted_at/status
  // check so a link issued before a ban/deletion can't still flip
  // email_verified on that row afterward.
  const { data: row, error } = await supabase
    .from('users').select('*').eq('email_verify_token', stored)
    .gt('email_verify_expiry', new Date().toISOString())
    .is('deleted_at', null).eq('status', 'ACTIVE').maybeSingle()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!user) return c.json({ success: false, message: 'Verification link invalid or expired.' }, 400)

  await supabase.from('users').update({
    email_verified: true, email_verify_token: null, email_verify_expiry: null
  }).eq('id', user.id)

  return c.json({ success: true, message: 'Email verified.' })
}

// POST /api/auth/resend-verification
async function resendVerification(c) {
  const user = c.get('user')
  if (user.emailVerified) return c.json({ success: false, message: 'Already verified.' }, 400)

  const supabase = getSupabase(c.env)
  const raw    = cryptoLib.randomToken(32)
  const stored = await cryptoLib.sha256(raw)
  const exp    = expiry(constants.EMAIL_TOKEN_EXPIRY_HOURS)

  await supabase.from('users').update({ email_verify_token: stored, email_verify_expiry: exp }).eq('id', user.id)
  // waitUntil, not fire-and-forget — see register()'s comment for why. This
  // was the exact cause of "resend verification never arrives": the request
  // returned successfully, but the actual Resend API call was getting
  // silently cancelled before it completed, since nothing protected it.
  c.executionCtx.waitUntil(
    emailService.sendVerification(c.env, supabase, user.email, user.name, raw)
      .catch(e => console.error('Resend verify:', e.message))
  )

  return c.json({ success: true, message: 'Verification email sent.' })
}

// PATCH /api/auth/password
async function changePassword(c) {
  const sessionUser = c.get('user')
  const body = await c.req.json()
  const { currentPassword, newPassword } = z.object({
    currentPassword: z.string(),
    // BUG FIX: see register()'s matching comment and passwordSchema() above —
    // bcryptjs truncates past 72 BYTES, not 72 characters, with no error.
    newPassword:     passwordSchema()
  }).parse(body)

  // FEATURE (account lockout applied here too): checkAccountLockout/
  // recordLoginFailure were built for login() specifically to catch a
  // distributed/rotating-IP credential-stuffing attack that the IP-only
  // `rl.auth` limiter structurally can't — see rateLimiter.js's comment.
  // But login() isn't the only place a request proves a password: this
  // handler runs `bcrypt.compare(currentPassword, ...)` against
  // attacker-supplied input too, and so do updateEmail/deleteAccount below.
  // Anyone holding a stolen/leaked JWT (XSS, a shared computer, a leaked
  // token) who doesn't know the real password can use any of the three as
  // a password-guessing oracle, currently bounded only by the generic
  // per-IP `rl.auth` (10/15min) — exactly the gap account-level lockout
  // exists to close for login. Reusing the same email-keyed lockout here
  // means guesses against this account are counted together regardless of
  // which endpoint they came through.
  const lockout = await checkAccountLockout(c.env, sessionUser.email)
  if (lockout.locked) {
    return c.json({ success: false,
      message: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`
    }, 429)
  }

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('users').select('*').eq('id', sessionUser.id).single()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!await bcrypt.compare(currentPassword, user.passwordHash)) {
    const failResult = await recordLoginFailure(c.env, sessionUser.email, clientIp(c))
    maybeSendLockoutAlert(c, failResult, user)
    return c.json({ success: false, message: 'Current password incorrect.' }, 400)
  }
  await recordLoginSuccess(c.env, sessionUser.email)

  const newTokenVersion = user.tokenVersion + 1  // signs out every existing session, including this one
  await supabase.from('users').update({
    password_hash: await bcrypt.hash(newPassword, 10),
    token_version:  newTokenVersion
  }).eq('id', user.id)

  // BUG FIX: token_version bump above invalidates ALL outstanding JWTs for
  // this user — including the token this very request was authenticated
  // with (auth.js's `user.tokenVersion !== decoded.tokenVersion` check has
  // no notion of "this was the session that triggered the change, let it
  // through"). Previously no new token was returned here, so the response
  // said "Other sessions signed out" while silently killing the CURRENT
  // session too — the frontend held onto the now-dead token, and the next
  // authenticated request anywhere in the app 401'd with SESSION_INVALID,
  // bouncing the user to /login with no indication why. Minting and
  // returning a fresh token (same shape as issueJWT() used by register/
  // login) keeps the current session alive across the change, which is
  // what the message already claimed was happening.
  const token = await issueJWT(c.env, { id: user.id, tokenVersion: newTokenVersion })

  // FEATURE (Auth section round 2): see sendPasswordChanged's comment.
  c.executionCtx.waitUntil(
    emailService.sendPasswordChanged(c.env, supabase, user.email, user.name)
      .catch(e => console.error('Password-changed email:', e.message))
  )

  return c.json({ success: true, message: 'Password updated. Other sessions signed out.', data: { token } })
}

// PATCH /api/auth/name
// AUDIT FIX (Section 6): Settings displayed Name as static text with no way
// to ever change it — no endpoint existed anywhere in the app. Low-risk
// field, no password confirmation or re-verification needed.
async function updateName(c) {
  const sessionUser = c.get('user')
  const body = await c.req.json()
  const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(body)

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase
    .from('users').update({ name }).eq('id', sessionUser.id).select().single()
  if (error) throw error

  return c.json({ success: true, message: 'Name updated.', data: { user: safeUser(userRowToCamel(row)) } })
}

// PATCH /api/auth/email
// AUDIT FIX (Section 6): same gap as updateName, but email is identity- and
// security-adjacent, so this follows the pattern already established by
// changePassword: current password required, and — since this reuses the
// existing email-verification machinery rather than inventing a new one —
// the account is marked unverified again and a fresh verification email
// goes to the NEW address. token_version is deliberately left untouched;
// unlike a password change, changing your email address doesn't invalidate
// the credential that proves who's making other requests, so there's no
// reason to sign out other sessions over it.
async function updateEmail(c) {
  const sessionUser = c.get('user')
  const body = await c.req.json()
  const { newEmail, password } = z.object({
    newEmail: z.string().trim().toLowerCase().email(),
    password: z.string()
  }).parse(body)

  // FEATURE: same password-guessing-oracle gap as changePassword — see its
  // comment above for why this reuses the login lockout mechanism.
  const lockout = await checkAccountLockout(c.env, sessionUser.email)
  if (lockout.locked) {
    return c.json({ success: false,
      message: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`
    }, 429)
  }

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('users').select('*').eq('id', sessionUser.id).single()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!await bcrypt.compare(password, user.passwordHash)) {
    const failResult = await recordLoginFailure(c.env, sessionUser.email, clientIp(c))
    maybeSendLockoutAlert(c, failResult, user)
    return c.json({ success: false, message: 'Incorrect password.' }, 400)
  }
  await recordLoginSuccess(c.env, sessionUser.email)

  if (newEmail === user.email)
    return c.json({ success: false, message: 'That is already your email address.' }, 400)

  const raw    = cryptoLib.randomToken(32)
  const stored = await cryptoLib.sha256(raw)
  const exp    = expiry(constants.EMAIL_TOKEN_EXPIRY_HOURS)
  const oldEmail = user.email  // captured before the update below overwrites it

  const { data: updatedRow, error: updateErr } = await supabase.from('users').update({
    email:               newEmail,
    email_verified:      false,
    email_verify_token:  stored,
    email_verify_expiry: exp
  }).eq('id', user.id).select().single()
  // Relies on the same email-unique constraint register() does — a
  // duplicate here surfaces as the errorHandler's 23505 branch ("Already
  // exists."), same as everywhere else in the app.
  if (updateErr) throw updateErr
  const updated = userRowToCamel(updatedRow)

  c.executionCtx.waitUntil(
    emailService.sendVerification(c.env, supabase, newEmail, updated.name, raw)
      .catch(e => console.error('Email-change verify email:', e.message))
  )
  // AUDIT FIX (feature gap, Auth section round 2): the OLD address —
  // the one place a real account-takeover victim can still be reached —
  // previously heard nothing at all about this change. See
  // sendEmailChangedOldAddress's comment in email.service.js.
  c.executionCtx.waitUntil(
    emailService.sendEmailChangedOldAddress(c.env, supabase, oldEmail, updated.name, newEmail)
      .catch(e => console.error('Email-changed old-address notice:', e.message))
  )

  return c.json({ success: true, message: 'Email updated. Please verify your new address.',
    data: { user: safeUser(updated) } })
}

// DELETE /api/auth/account
async function deleteAccount(c) {
  const sessionUser = c.get('user')
  const body = await c.req.json()
  const { password } = z.object({ password: z.string() }).parse(body)

  // FEATURE: same password-guessing-oracle gap as changePassword — see its
  // comment above for why this reuses the login lockout mechanism.
  const lockout = await checkAccountLockout(c.env, sessionUser.email)
  if (lockout.locked) {
    return c.json({ success: false,
      message: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`
    }, 429)
  }

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('users').select('*').eq('id', sessionUser.id).single()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!await bcrypt.compare(password, user.passwordHash)) {
    const failResult = await recordLoginFailure(c.env, sessionUser.email, clientIp(c))
    maybeSendLockoutAlert(c, failResult, user)
    return c.json({ success: false, message: 'Incorrect password.' }, 400)
  }
  await recordLoginSuccess(c.env, sessionUser.email)

  // Captured before scrub_account_data overwrites both columns with
  // placeholder values (see migration 0022) — needed below to send the
  // deletion confirmation to the real address after the scrub commits.
  const preScrubEmail = user.email
  const preScrubName  = user.name

  // BUG FIX (Section 6, fixing-time pass): the scan-content scrub and the
  // user soft-delete used to run as two separate best-effort UPDATEs whose
  // failures were only console.error'd, never surfaced — this fell through
  // to "Account deleted." regardless of whether the scrub actually
  // succeeded. Since deleted_at blocks all future login, that failure mode
  // was unrecoverable: the account was locked, and the user was told their
  // data was gone when it silently wasn't, directly contradicting the
  // Settings.jsx confirmation copy ("...all associated data. This cannot be
  // undone."). scrub_account_data (migration 0022) now runs both updates as
  // one atomic DB transaction; a failure here throws, surfaces as a real
  // error to the caller, and leaves the account untouched so the user can
  // retry instead of being locked out of a half-done deletion.
  //
  // Storage keys are read BEFORE the scrub runs, since the scrub is what
  // nulls the columns that hold them — this is a plain read and, if it
  // fails, aborts loudly (throw) rather than silently skipping R2 cleanup
  // the way the two old error-swallowing branches used to.
  const { data: scans, error: scansErr } = await supabase
    .from('scans')
    .select('id, resume_path, resume_ats_path, resume_pdf_path')
    .eq('user_id', user.id)
  if (scansErr) throw scansErr

  const { error: scrubErr } = await supabase.rpc('scrub_account_data', { p_user_id: user.id })
  if (scrubErr) throw scrubErr

  // R2 cleanup happens only after the DB side has durably committed.
  // Object storage isn't part of that (or any) Postgres transaction, so
  // this half necessarily stays best-effort — but failures are now logged
  // loudly instead of swallowed in an empty catch, so an orphaned file is
  // at least visible to us instead of vanishing with zero trace.
  if (scans?.length > 0) {
    for (const s of scans) {
      for (const key of [s.resume_path, s.resume_ats_path, s.resume_pdf_path]) {
        if (!key) continue
        try {
          await c.env.RESUMES_BUCKET.delete(key)
        } catch (e) {
          console.error(`deleteAccount: failed to delete R2 object ${key} for user ${user.id}:`, e.message)
        }
      }
    }
  }

  // FEATURE (Auth section round 2): sent only after the scrub has durably
  // committed (thrown errors above skip this entirely) — to the address the
  // account actually had a moment ago, since scrub_account_data has already
  // overwritten it with a placeholder by this point. See sendAccountDeleted's
  // comment in email.service.js.
  c.executionCtx.waitUntil(
    emailService.sendAccountDeleted(c.env, supabase, preScrubEmail, preScrubName)
      .catch(e => console.error('Account-deleted email:', e.message))
  )

  return c.json({ success: true, message: 'Account deleted.' })
}

// POST /api/auth/claim-scan
async function claimScan(c) {
  const user = c.get('user')
  const body = await c.req.json()
  const { anonToken } = z.object({ anonToken: z.string() }).parse(body)

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase
    .from('scans').select('*')
    .eq('anon_token', anonToken)
    .gt('anon_expires_at', new Date().toISOString())
    .is('user_id', null)
    .maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan) return c.json({ success: false, message: 'Scan not found or expired.' }, 404)

  await supabase.from('scans').update({
    user_id: user.id, anon_token: null, anon_expires_at: null
  }).eq('id', scan.id)

  return c.json({ success: true, data: { scanId: scan.id } })
}

module.exports = {
  register, login, getMe, forgotPassword, resetPassword,
  verifyEmail, resendVerification, changePassword, updateName, updateEmail,
  deleteAccount, claimScan
}
