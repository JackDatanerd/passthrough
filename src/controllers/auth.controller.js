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
const { userRowToCamel, scanRowToCamel, camelToSnake, USER_FIELD_MAP, SCAN_FIELD_MAP } = require('../lib/mappers')
const emailService = require('../services/email.service')
const constants     = require('../config/constants')

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

// HARDENING: precomputed at module load so login() can run a bcrypt.compare
// of roughly the same cost against it when no matching user exists. Without
// this, an unknown email short-circuits straight to the 401 while a known
// email always pays the ~100ms+ bcrypt.compare cost first — same response
// body either way ("Invalid credentials"), but the timing difference lets
// an attacker enumerate registered emails by measuring response latency.
// The hash itself is thrown away after use — it never gets compared against
// real user data, it's purely there to burn a comparable amount of CPU time.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('passthrough-timing-equalizer', 10)

// POST /api/auth/register
async function register(c) {
  const body = await c.req.json()
  const { name, email, password } = z.object({
    name:     z.string().min(1).max(100),
    email:    z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters')
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
    email:    z.string().email(),
    password: z.string()
  }).parse(body)

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase
    .from('users').select('*').eq('email', email).is('deleted_at', null).maybeSingle()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!user) {
    // HARDENING: burn a comparable amount of time to the real-user path
    // below (bcrypt.compare against a throwaway hash) before responding,
    // so "no such email" and "wrong password" aren't distinguishable by
    // response latency. See DUMMY_PASSWORD_HASH above.
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH)
    return c.json({ success: false, message: 'Invalid credentials' }, 401)
  }
  if (user.status === 'BANNED')
    return c.json({ success: false, message: 'Account suspended.', code: 'BANNED' }, 403)
  if (!await bcrypt.compare(password, user.passwordHash))
    return c.json({ success: false, message: 'Invalid credentials' }, 401)

  return c.json({ success: true, data: { token: await issueJWT(c.env, user), user: safeUser(user) } })
}

// GET /api/auth/me
async function getMe(c) {
  return c.json({ success: true, data: { user: c.get('user') } })
}

// POST /api/auth/forgot-password
async function forgotPassword(c) {
  const body = await c.req.json()
  const { email } = z.object({ email: z.string().email() }).parse(body)
  const supabase = getSupabase(c.env)

  const { data: row } = await supabase
    .from('users').select('*').eq('email', email).is('deleted_at', null).eq('status', 'ACTIVE').maybeSingle()
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
    newPassword: z.string().min(8)
  }).parse(body)

  const supabase = getSupabase(c.env)
  const stored = await cryptoLib.sha256(token)
  const { data: row, error } = await supabase
    .from('users').select('*').eq('reset_token', stored).gt('reset_token_expiry', new Date().toISOString()).maybeSingle()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!user) return c.json({ success: false, message: 'Reset link invalid or expired.' }, 400)

  await supabase.from('users').update({
    password_hash:      await bcrypt.hash(newPassword, 10),
    reset_token:        null,
    reset_token_expiry: null,
    token_version:       user.tokenVersion + 1  // kills all existing sessions
  }).eq('id', user.id)

  return c.json({ success: true, message: 'Password reset. Please log in.' })
}

// GET /api/auth/verify-email?token=xxx
async function verifyEmail(c) {
  const token = c.req.query('token')
  if (!token) return c.json({ success: false, message: 'Token required.' }, 400)

  const supabase = getSupabase(c.env)
  const stored = await cryptoLib.sha256(token)
  const { data: row, error } = await supabase
    .from('users').select('*').eq('email_verify_token', stored).gt('email_verify_expiry', new Date().toISOString()).maybeSingle()
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
    newPassword:     z.string().min(8)
  }).parse(body)

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('users').select('*').eq('id', sessionUser.id).single()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!await bcrypt.compare(currentPassword, user.passwordHash))
    return c.json({ success: false, message: 'Current password incorrect.' }, 400)

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

  return c.json({ success: true, message: 'Password updated. Other sessions signed out.', data: { token } })
}

// DELETE /api/auth/account
async function deleteAccount(c) {
  const sessionUser = c.get('user')
  const body = await c.req.json()
  const { password } = z.object({ password: z.string() }).parse(body)

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('users').select('*').eq('id', sessionUser.id).single()
  if (error) throw error
  const user = userRowToCamel(row)

  if (!await bcrypt.compare(password, user.passwordHash))
    return c.json({ success: false, message: 'Incorrect password.' }, 400)

  await supabase.from('users').update({
    deleted_at:    new Date().toISOString(),
    email:         `deleted-${user.id}@passthrough.dev`,
    name:          'Deleted User',
    password_hash: 'deleted',
    token_version:  user.tokenVersion + 1
  }).eq('id', user.id)

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
  verifyEmail, resendVerification, changePassword, deleteAccount, claimScan
}
