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
const { must } = require('../lib/db')
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
// clientIp() itself now lives in lib/clientIp.js (shared with
// rateLimiter.js/scan.controller.js): it only trusts x-forwarded-for outside
// production, so a spoofable header can't pick its own lockout-tracking IP
// in prod, which a local copy of this helper would not have gotten right.
const { clientIp } = require('../lib/clientIp')

async function issueJWT(env, user) {
  const expiresIn = parseInt(env.JWT_EXPIRES_IN_SECONDS, 10) || 604800 // 7 days default
  return jwtLib.sign({ userId: user.id, tokenVersion: user.tokenVersion }, env.JWT_SECRET, expiresIn)
}

function safeUser(user) {
  const {
    passwordHash, paystackAuthCode, paystackCustomerCode,
    resetToken, emailVerifyToken, resetTokenExpiry, emailVerifyExpiry,
    pendingEmailToken, pendingEmailExpiry,
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
// max 254 = the RFC 5321 limit. Without it a multi-KB "email" reaches
// Postgres and blows the unique-index row-size limit as an unhandled 500.
const emailSchema = z.string().trim().toLowerCase().email().max(254)

// Passwords being CHECKED (login, current-password confirmations) get a
// generous but bounded ceiling — hashing a multi-MB string is a free
// CPU-burning request for an attacker, and no legitimately-set password is
// anywhere near this long.
const checkPasswordSchema = z.string().max(1024)

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
    password: checkPasswordSchema
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

    // Checked: mailing a reset link whose token was never stored gives the user a dead link.
    must(await supabase.from('users').update({ reset_token: stored, reset_token_expiry: exp }).eq('id', user.id), 'store reset token')
    // waitUntil, not fire-and-forget — see register()'s comment for why.
    c.executionCtx.waitUntil(
      emailService.sendPasswordReset(c.env, supabase, email, user.name, raw)
        .catch(e => console.error('Reset email:', e.message))
    )
  } else {
    // HARDENING (Auth section audit, fresh pass): login() burns a comparable
    // bcrypt.compare when no matching user exists (see getDummyPasswordHash()
    // above) so "no such email" and "wrong password" can't be told apart by
    // response latency — but this handler's own non-enumeration comment below
    // was only ever true of the response BODY. The `user` branch pays for a
    // full network round-trip to Supabase (the reset-token UPDATE) before
    // responding; this branch previously paid for nothing extra at all, which
    // is a bigger, easier-to-measure tell than the bcrypt gap login() was
    // fixed for. Issuing an equivalent UPDATE here — filtered on a random
    // uuid that can never match a real row, so it's a genuine no-op — costs
    // the same round trip and index lookup without touching any data.
    const raw    = cryptoLib.randomToken(32)
    const stored = await cryptoLib.sha256(raw)
    const exp    = expiry(constants.RESET_TOKEN_EXPIRY_HOURS)
    try {
      await supabase.from('users').update({ reset_token: stored, reset_token_expiry: exp }).eq('id', cryptoLib.uuid())
    } catch (e) {
      console.error('forgotPassword timing-equalizer UPDATE:', e.message)
    }
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

  must(await supabase.from('users').update({
    email_verified: true, email_verify_token: null, email_verify_expiry: null
  }).eq('id', user.id), 'verify email')

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

  must(await supabase.from('users').update({ email_verify_token: stored, email_verify_expiry: exp }).eq('id', user.id), 'store verify token')
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
    currentPassword: checkPasswordSchema,
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
    token_version:  newTokenVersion,
    // BUG FIX (Section 6, second fixing-time pass): token_version above
    // kills every outstanding JWT, but a reset link is a SEPARATE credential
    // (a bare token in reset_token, checked on its own) that survived a
    // password change untouched — someone who reset the password once
    // (a briefly-compromised mailbox, a shoulder-surfed code) could reuse
    // the same link again within its 1-hour window even after the account
    // owner "secures" things by changing the password themselves — and even
    // after the round-2 sendPasswordChanged email below, which confirms the
    // change happened but doesn't invalidate anything left outstanding. A
    // pending email change in flight (see updateEmail/confirmEmailChange) is
    // cleared for the same reason — it shouldn't survive proving you know
    // the current password either. Signup verification (email_verify_token)
    // is left alone: it isn't a bypass of anything password-related, and
    // clearing it would silently break a still-valid, still-wanted
    // verification link for no security benefit.
    reset_token: null, reset_token_expiry: null,
    pending_email: null, pending_email_token: null, pending_email_expiry: null
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
// BUG FIX (Section 6, second fixing-time pass): this used to flip `email`
// the instant a correct password was supplied, to whatever string the
// caller sent — a typo, or someone else's real address — immediately making
// it the account's live login/reset/notification address, and simultaneously
// flipping email_verified to false (which blocks paid downloads until the
// NEW, possibly-wrong address verifies). The round-2 pass (below, kept)
// added a notice to the OLD address, which helps a genuine takeover victim
// notice — but doesn't stop an honest typo, or a not-yet-malicious mistake,
// from taking effect immediately with no way back. This now only STAGES the
// change (pending_email + its own confirmation token) — the current email
// keeps working exactly as before until the new address proves it's real by
// clicking the link confirmEmailChange() below handles. token_version stays
// untouched here, same reasoning as before: nothing about the live account
// has changed yet.
async function updateEmail(c) {
  const sessionUser = c.get('user')
  const body = await c.req.json()
  const { newEmail, password, cancelPending } = z.object({
    newEmail: emailSchema,
    password: checkPasswordSchema,
    // FEATURE GAP CLOSED (Section 6, second fixing-time pass): the pending-
    // email flow above needed a way BACK — a change requested by mistake
    // (or by someone else with a stolen session) had no way to be withdrawn
    // short of waiting out the 1-hour token expiry. Settings.jsx's "cancel"
    // action re-submits this same endpoint with the account's own current
    // email and this flag, rather than a separate endpoint, since the
    // password-confirmation and lookup logic is otherwise identical.
    cancelPending: z.boolean().optional()
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

  if (newEmail === user.email) {
    if (cancelPending && user.pendingEmail) {
      await supabase.from('users').update({
        pending_email: null, pending_email_token: null, pending_email_expiry: null
      }).eq('id', user.id)
      return c.json({ success: true, message: 'Email change canceled.' })
    }
    return c.json({ success: false, message: 'That is already your email address.' }, 400)
  }

  // BUG FIX: proactive check instead of relying solely on the unique-
  // constraint 23505 -> "Already exists." errorHandler branch — that generic
  // message meant "email already exists" and "you're not allowed to do that"
  // were indistinguishable to the person reading it. The 23505 branch stays
  // as defense-in-depth against a race between this check and the eventual
  // confirm; this is the one anybody actually sees.
  const { data: existing, error: existingErr } = await supabase
    .from('users').select('id').eq('email', newEmail).is('deleted_at', null).maybeSingle()
  if (existingErr) throw existingErr
  if (existing) return c.json({ success: false, message: 'That email address is already in use.' }, 400)

  const raw    = cryptoLib.randomToken(32)
  const stored = await cryptoLib.sha256(raw)
  const exp    = expiry(constants.EMAIL_TOKEN_EXPIRY_HOURS)

  const { error: updateErr } = await supabase.from('users').update({
    pending_email:        newEmail,
    pending_email_token:  stored,
    pending_email_expiry: exp
  }).eq('id', user.id)
  if (updateErr) throw updateErr

  c.executionCtx.waitUntil(
    emailService.sendEmailChangeConfirmation(c.env, supabase, newEmail, user.name, raw)
      .catch(e => console.error('Email-change confirm email:', e.message))
  )
  // AUDIT FIX (feature gap, Auth section round 2): the OLD address — the one
  // place a real account-takeover victim can still be reached — previously
  // heard nothing at all about this. Reused here for the pending flow at the
  // moment that actually matters most: the REQUEST, not the eventual
  // confirmation (which an attacker who doesn't control the new inbox will
  // never complete anyway — the owner needs to know now). See
  // sendEmailChangedOldAddress's comment in email.service.js / its template.
  c.executionCtx.waitUntil(
    emailService.sendEmailChangedOldAddress(c.env, supabase, user.email, user.name, newEmail)
      .catch(e => console.error('Email-changed old-address notice:', e.message))
  )

  return c.json({ success: true,
    message: `Confirmation email sent to ${newEmail}. Your current email stays active until you confirm.` })
}

// POST /api/auth/email/confirm  { token }
// The other half of updateEmail's pending-email flow — public (token-gated,
// same posture as resetPassword/verifyEmail), since the confirmation link
// is clicked from an email client that may not carry the original session.
async function confirmEmailChange(c) {
  const body = await c.req.json()
  const { token } = z.object({ token: z.string() }).parse(body)

  const supabase = getSupabase(c.env)
  const stored = await cryptoLib.sha256(token)
  const { data: row, error } = await supabase
    .from('users').select('*').eq('pending_email_token', stored)
    .gt('pending_email_expiry', new Date().toISOString())
    .is('deleted_at', null).eq('status', 'ACTIVE').maybeSingle()
  if (error) throw error
  const user = userRowToCamel(row)
  if (!user || !user.pendingEmail)
    return c.json({ success: false, message: 'Confirmation link invalid or expired.' }, 400)

  // The proactive uniqueness check in updateEmail can't see a SECOND email
  // change (by this account or another) that landed in between — re-check
  // here, right before the write that would otherwise 23505.
  const { data: existing, error: existingErr } = await supabase
    .from('users').select('id').eq('email', user.pendingEmail).neq('id', user.id).is('deleted_at', null).maybeSingle()
  if (existingErr) throw existingErr
  if (existing) {
    await supabase.from('users').update({
      pending_email: null, pending_email_token: null, pending_email_expiry: null
    }).eq('id', user.id)
    return c.json({ success: false, message: 'That email address is already in use.' }, 400)
  }

  // The identity this session's JWTs are bound to is changing here (unlike
  // updateEmail's request step, where nothing live changed yet) — bump
  // token_version so a stale token can't keep acting as the old identity,
  // and mint a fresh one so THIS request's own confirmation doesn't
  // immediately invalidate itself if the browser that clicked the link also
  // happens to be signed in (same reasoning changePassword's own fresh-token
  // reissue above already established for this codebase).
  const newTokenVersion = user.tokenVersion + 1
  const { data: updatedRow, error: updateErr } = await supabase.from('users').update({
    email:                 user.pendingEmail,
    email_verified:        true,
    pending_email:         null,
    pending_email_token:   null,
    pending_email_expiry:  null,
    token_version:         newTokenVersion
  }).eq('id', user.id).select().single()
  if (updateErr) throw updateErr
  const updated = userRowToCamel(updatedRow)

  const newToken = await issueJWT(c.env, { id: user.id, tokenVersion: newTokenVersion })
  return c.json({ success: true, message: 'Email address updated.',
    data: { user: safeUser(updated), token: newToken } })
}

// DELETE /api/auth/account
async function deleteAccount(c) {
  const sessionUser = c.get('user')
  const body = await c.req.json()
  const { password } = z.object({ password: checkPasswordSchema }).parse(body)

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
  //
  // BUG FIX (Auth section audit, fresh pass): this was a waitUntil
  // (fire-and-forget), with the email_logs purge below running synchronously
  // right after it was merely SCHEDULED — not after it finished. send() only
  // inserts this email's own email_logs row once the outbound Resend call
  // completes, and a single Supabase DELETE is essentially always faster
  // than an external Resend round trip (which can take several seconds with
  // retries — see config/email.js's ATTEMPT_TIMEOUT_MS and retry delays). So
  // the purge almost always ran BEFORE this email's own log row existed,
  // leaving exactly the one row the purge exists to prevent: the real,
  // pre-scrub address, in the clear, for the very email announcing its own
  // deletion. Awaiting the send here makes the ordering the purge's comment
  // always assumed actually hold — by the time the purge runs, this email
  // has already been logged (or definitively failed, in which case nothing
  // was written for it at all). Costs the response a little latency; the
  // account is already fully, durably deleted by this point regardless of
  // whether this confirmation email succeeds.
  try {
    await emailService.sendAccountDeleted(c.env, supabase, preScrubEmail, preScrubName)
  } catch (e) {
    console.error('Account-deleted email:', e.message)
  }
  // Purges this address's own mail history too, so no trace of who we
  // emailed and when survives the deletion it's the record of. Safe now:
  // the confirmation email above has already been sent-and-logged or
  // failed outright, so nothing further will be written for this address.
  try {
    const { error: logErr } = await supabase.from('email_logs').delete().eq('to', preScrubEmail)
    if (logErr) console.error('deleteAccount: email_logs purge failed:', logErr.message)
  } catch (e) { console.error('deleteAccount: email_logs purge failed:', e.message) }

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

  // contact_name/contact_email were only ever collected so an ANONYMOUS
  // submitter could be emailed a way back to their scan. Once the scan
  // belongs to an account that purpose is served by the account itself, so
  // the extra copy of their personal details is dropped rather than kept.
  must(await supabase.from('scans').update({
    user_id: user.id, anon_token: null, anon_expires_at: null,
    contact_name: null, contact_email: null
  }).eq('id', scan.id), 'claim scan')

  return c.json({ success: true, data: { scanId: scan.id } })
}

module.exports = {
  register, login, getMe, forgotPassword, resetPassword,
  verifyEmail, resendVerification, changePassword, updateName, updateEmail,
  confirmEmailChange, deleteAccount, claimScan
}
