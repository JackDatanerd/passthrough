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
const { must, warnOnError } = require('../lib/db')
const sessionsLib = require('../lib/sessions')
const { isPwnedPassword } = require('../lib/pwned')
const { nameSchema } = require('../lib/text')
const emailService = require('../services/email.service')
const constants     = require('../config/constants')
const { recordTombstones } = require('../lib/verification')
const { verifyTurnstile } = require('../lib/turnstile')
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

// FEATURE (Auth section, feature-gap-closing pass): a failed login that
// trips the lockout gets the owner an email (maybeSendLockoutAlert above),
// but a SUCCESSFUL one — the one that matters if a password actually
// leaked — left no trace anywhere the owner could see, and "Sign out other
// sessions" (Settings) had nothing behind it to tell them WHY they might
// want to click it. (This predates server-side sessions: migration 0047 added
// the user_sessions table, per-device listing and revoke — see lib/sessions.js
// — and these columns now sit alongside it.) Migration 0040's columns:
//   - previousLoginAt/previousLoginIp: shown in Settings as "your previous
//     sign-in" — deliberately the login BEFORE this one, not this one, since
//     "last sign-in: just now" (which is what showing the current session's
//     own values would always read) tells you nothing.
//   - a "new sign-in" email when the incoming IP's network genuinely looks
//     different from last time, throttled to at most one per
//     NEW_LOGIN_ALERT_THROTTLE_HOURS (constants.js) regardless of how many
//     times the IP flips inside that window — a phone changing cell towers
//     gets a new IP on nearly every handoff, and alerting on each one trains
//     the owner to ignore the one that eventually matters.
// rateKeyIp is reused here for the "different network" comparison for the
// same reason rateLimiter.js/scan.controller.js already use it: an IPv6
// client rotates its low bits on every connection under privacy extensions,
// so a raw string compare would call that "new" on nearly every login too.
//
// Called fire-and-forget from login() (not awaited) but the DB write is NOT
// truly fire-and-forget — like every other background task in this file, it
// has to be wrapped in waitUntil() or Workers can cancel it mid-flight the
// instant the response is sent (see register()'s comment). It's also not
// awaited before responding: this is bookkeeping for NEXT time, not
// something the current login should be slowed down by or fail over if it
// errors — a DB hiccup here must never turn into "couldn't sign in".
function recordLoginMetadata(c, user) {
  const supabase = getSupabase(c.env)
  const newIp = clientIp(c)
  const prevIp = user.lastLoginIp
  // No prevIp means either this account has never logged in through this
  // code path before (pre-migration-0040 account, or the very next login
  // after register() seeded it) — never alert off a null baseline, or every
  // existing account would get a "new sign-in" email the moment this ships.
  // AUDIT FIX (Auth round 2, B4): 'unknown' is clientIp()'s "couldn't see an
  // address" sentinel, not a network. Treating it as a real baseline meant the
  // first sign-in after a request with no cf-connecting-ip (or the reverse)
  // looked like a "new network" and mailed a false new-sign-in alert.
  const isNewNetwork = !!prevIp && prevIp !== 'unknown' && newIp !== 'unknown' &&
    rateKeyIp(prevIp) !== rateKeyIp(newIp)
  const throttleMs = constants.NEW_LOGIN_ALERT_THROTTLE_HOURS * 60 * 60 * 1000
  const alertDue = isNewNetwork &&
    (!user.lastLoginAlertAt || Date.now() - new Date(user.lastLoginAlertAt).getTime() > throttleMs)
  const now = new Date().toISOString()

  c.executionCtx.waitUntil((async () => {
    try {
      must(await supabase.from('users').update({
        previous_login_at:   user.lastLoginAt,
        previous_login_ip:   user.lastLoginIp,
        last_login_at:       now,
        last_login_ip:       newIp,
        ...(alertDue ? { last_login_alert_at: now } : {})
      }).eq('id', user.id), 'record login metadata')
    } catch (err) {
      console.error('record login metadata:', err.message)
    }
    if (alertDue) {
      try {
        await emailService.sendNewSignInAlert(c.env, supabase, user.email, user.name, { ip: newIp, when: now })
      } catch (err) {
        console.error('New sign-in alert email:', err.message)
      }
    }
  })())

  // AUDIT FIX (bug — Auth section round 1): login() used to serialize the row
  // it read BEFORE this write, so the response carried previousLoginAt/Ip from
  // TWO logins ago (and the previous sign-in Settings shows stayed wrong until
  // the next /auth/me). Returning what the write above is about to store lets
  // login() answer with the same values the database will hold.
  return { lastLoginAt: now, lastLoginIp: newIp, previousLoginAt: user.lastLoginAt, previousLoginIp: user.lastLoginIp }
}

// AUDIT FIX (bug — account-lockout DoS): recordLoginFailure now needs the
// requester's IP (see rateLimiter.js's LOCKOUT_MIN_DISTINCT_IPS comment) —
// same header precedence scan.controller.js's quota-bypass check already
// uses, centralized here since four handlers in this file need it.
// clientIp() itself now lives in lib/clientIp.js (shared with
// rateLimiter.js/scan.controller.js): it only trusts x-forwarded-for outside
// production, so a spoofable header can't pick its own lockout-tracking IP
// in prod, which a local copy of this helper would not have gotten right.
const { clientIp, rateKeyIp } = require('../lib/clientIp')

// `session` is the { id, expiresAtMs } from lib/sessions.js's createSession(),
// or null/undefined for a sessionless token (what every token was before
// migration 0047, and what sign-in falls back to if the session row can't be
// created). A session-bound token carries `sid` and never outlives the
// session's absolute expiry.
async function issueJWT(env, user, session) {
  const payload = { userId: user.id, tokenVersion: user.tokenVersion }
  if (session) payload.sid = session.id
  return jwtLib.sign(payload, env.JWT_SECRET, sessionsLib.tokenLifetimeSeconds(env, session))
}

// Creates a fresh server-side session for `user` (recording this request's IP
// and user-agent) and returns a token bound to it.
async function issueSessionToken(c, user) {
  const session = await sessionsLib.createSession(c, getSupabase(c.env), user.id)
  return issueJWT(c.env, user, session)
}

// Marks every live session of `userId` revoked. Best-effort: token_version was
// already bumped by every caller, which is what actually kills the JWTs — this
// keeps the device list in Settings from showing sessions that no longer work.
async function revokeAllSessions(supabase, userId) {
  try {
    warnOnError(await supabase.from('user_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId).is('revoked_at', null), 'revoke all sessions')
  } catch (err) {
    console.error('revoke all sessions:', err.message)
  }
}

// Set PWNED_PASSWORDS_CHECK=off to disable. Fails open — see lib/pwned.js.
async function passwordBreachProblem(env, password) {
  return (await isPwnedPassword(password, env))
    ? 'That password has appeared in a known data breach — please choose a different one.'
    : null
}

// AUDIT FIX (Auth section round 1): the account lockout used to refuse the
// account's real owner exactly like an attacker — even with the right
// password. Since the "2 distinct IPs" bar still lets anyone with two
// connections lock a known email, that made "lock someone out" a standing
// denial-of-service. A locked account now still lets a request through to the
// password check when it comes from the network the account last signed in
// from successfully. The lock stays fully in force for every other network
// (which is where a credential-stuffing attack comes from), and guesses from
// the owner's own network are still bounded by the per-IP `rl.auth` limiter.
//
// 'unknown' is never a match: with no cf-connecting-ip every request shares
// that one bucket (see lib/clientIp.js), so treating it as "the owner's
// network" would hand the bypass to anyone whose address we can't see.
function lockoutBlocks(c, lockout, lastKnownIp) {
  if (!lockout.locked) return false
  const ip = clientIp(c)
  if (lastKnownIp && lastKnownIp !== 'unknown' && ip && ip !== 'unknown' && rateKeyIp(lastKnownIp) === rateKeyIp(ip)) return false
  return true
}

// BUG FIX (Auth round 3, B2): forgotPassword / resendVerification / updateEmail
// reserve the per-recipient email slot BEFORE rotating the stored token. If the
// token write then failed (a database blip), nothing was mailed yet the slot
// stayed spent — three blips and the owner was locked out of the flow for an
// hour. Hands the slot back; the email service bounds refunds per window and
// no-ops for templates that don't allow them. Never throws.
async function refundSlot(c, to, template) {
  try { await emailService.refundReservedSlot(c.env, to, template) }
  catch (e) { console.error(`refund ${template} slot:`, e && e.message) }
}

function lockedResponse(c, lockout) {
  return c.json({ success: false,
    message: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`
  }, 429)
}

// FEATURE GAP CLOSED (Auth round 3, G1): register and forgot-password make us
// email an address a stranger typed (welcome + verification / a reset link), and
// until now were bounded only by per-IP and per-recipient throttles — rotating
// IPs gets unlimited junk accounts and burns the sending domain's reputation.
// Same Cloudflare Turnstile check the employer-lead form uses: opt-in by
// configuration (no TURNSTILE_SECRET_KEY = skipped), and fail-open when
// Cloudflare itself is unreachable (see lib/turnstile.js). Login is deliberately
// NOT challenged: it emails no one, and the per-account lockout already covers it.
// Returns a ready 400 response when the challenge fails, else null.
async function challengeFailure(c, token) {
  if (await verifyTurnstile(c.env, token, clientIp(c))) return null
  return c.json({ success: false, code: 'CHALLENGE_FAILED',
    message: 'Please complete the security check and try again.' }, 400)
}

// FEATURE GAP CLOSED (Auth section, second independent pass): terms_accepted_at
// /terms_version (migration 0038) were written at signup and read back by the
// mapper, but nothing anywhere ever compared a user's accepted version against
// the CURRENT constants.TERMS_VERSION — the versioning existed but had no
// point, since a future Terms/Privacy change would silently leave every
// existing account running on stale consent forever, with no way for the app
// to even notice. `termsCurrent` gives the frontend something to react to
// without needing its own copy of TERMS_VERSION. `null` (an account that
// signed up before the checkbox existed) is deliberately treated as current,
// not stale — 0038's own comment already decided those accounts shouldn't be
// retroactively blocked by a check that didn't exist when they signed up;
// this only flags accounts that DID accept a version, once a newer one ships.
function safeUser(user) {
  const {
    passwordHash, paystackAuthCode, paystackCustomerCode,
    resetToken, emailVerifyToken, resetTokenExpiry, emailVerifyExpiry,
    pendingEmailToken, pendingEmailExpiry,
    // tokenVersion is the server-side revocation counter (AUDIT FIX, Auth
    // section round 1): nothing on the client uses it, and handing out the
    // current value only tells a token-forger which number to sign.
    tokenVersion,
    // lastLoginAlertAt is purely internal throttle bookkeeping for
    // recordLoginMetadata below (migration 0040) — nothing in the frontend
    // has any use for it, unlike previousLoginAt/previousLoginIp, which
    // Settings.jsx shows.
    lastLoginAlertAt,
    savedProfile, ...safe
  } = user
  return {
    ...safe,
    termsCurrent: user.termsVersion == null || user.termsVersion === constants.TERMS_VERSION
  }
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
    .refine(pw => !COMMON_PASSWORDS.has(pw.toLowerCase()), {
      message: 'That password is too common — choose something harder to guess.'
    })
}

// FEATURE GAP CLOSED (Auth/Scan round): the only password rule was "8+
// characters", so "password" / "12345678" were accepted for an account that
// holds a resume, contact details and payment history. A deliberately small
// deny-list of the most-used 8+ character passwords (the ones credential
// stuffing tries first) plus a "not your own email" check — no composition
// rules, which are known to make passwords worse, not better.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '11111111', '00000000', '88888888', '87654321', '123123123',
  'qwertyui', 'qwerty12', 'qwerty123', 'qwertyuiop', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', '1q2w3e4r', '1qaz2wsx',
  'iloveyou', 'iloveyou1', 'letmein1', 'welcome1', 'welcome123', 'admin123', 'administrator', 'changeme', 'trustno1',
  'abc12345', 'abcd1234', 'abcdefgh', 'monkey123', 'dragon123', 'football1', 'baseball1', 'superman1', 'sunshine1',
])
// Returns a user-facing message when the password is just the account's own
// email (or its local part) — checked where the email is known.
function passwordEmailProblem(password, email) {
  if (!email) return null
  const pw = String(password).toLowerCase()
  const e = String(email).trim().toLowerCase()
  const local = e.split('@')[0]
  if (pw === e || (local.length >= 6 && pw === local)) return 'Your password can\'t be your email address.'
  return null
}

// POST /api/auth/register
async function register(c) {
  const body = await c.req.json()
  const { name, email, password, turnstileToken } = z.object({
    // FEATURE GAP CLOSED (Auth/Scan round): sign-up never asked for — or
    // recorded — acceptance of the Terms/Privacy Policy. Required now, and
    // stored with the version accepted so a later terms change can tell who
    // agreed to what (see the 0038 migration).
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms of Service and Privacy Policy to create an account.' }) }),
    // One shared definition with updateName (lib/text.js): control characters
    // and zero-width filler are stripped, and a name with no letter or digit
    // in it ("\u200b", "---") is refused — trim() alone let a name made only
    // of zero-width characters through, which then rendered as a blank
    // "Hi ," in every email and an empty heading in the app.
    name:     nameSchema,
    email:    emailSchema,
    turnstileToken: z.string().max(2048).nullish(),
    // BUG FIX: no upper bound anywhere a password is set (here, reset,
    // change) — bcryptjs silently truncates at 72 bytes, so anything past
    // that is quietly ignored with no error, giving false confidence in
    // extra length that does nothing. passwordSchema() (see above) turns
    // that into an explicit, honest validation error instead of a silent
    // no-op — byte-aware, not just character-count-aware.
    password: passwordSchema()
  }).parse(body)

  const challenge = await challengeFailure(c, turnstileToken)
  if (challenge) return challenge

  const emailProblem = passwordEmailProblem(password, email)
  if (emailProblem) return c.json({ success: false, message: emailProblem }, 400)
  const breachProblem = await passwordBreachProblem(c.env, password)
  if (breachProblem) return c.json({ success: false, message: breachProblem }, 400)

  const supabase = getSupabase(c.env)
  const passwordHash = await bcrypt.hash(password, 10)
  const raw    = cryptoLib.randomToken(32)
  const stored = await cryptoLib.sha256(raw)
  const exp    = expiry(constants.EMAIL_TOKEN_EXPIRY_HOURS)

  const { data: row, error } = await supabase
    .from('users')
    .insert({
      name, email, password_hash: passwordHash, email_verify_token: stored, email_verify_expiry: exp,
      terms_accepted_at: new Date().toISOString(), terms_version: constants.TERMS_VERSION,
      // FEATURE (Auth section, feature-gap-closing pass): seeds last_login_*
      // with THIS request's own sign-up, rather than leaving it null until a
      // separate login() call. Without this, the account's real first
      // login() (which might not be the real owner's, if credentials leaked
      // between registration and their first actual sign-in) would find
      // lastLoginIp null and — per recordLoginMetadata's own comment — never
      // alert off a null baseline. Seeding here closes exactly that window.
      last_login_at: new Date().toISOString(), last_login_ip: clientIp(c),
    })
    .select().single()
  // AUDIT FIX (Auth/Scan round): a duplicate email fell to errorHandler's
  // generic 23505 branch — "Already exists." — which tells a person filling
  // in a sign-up form nothing about WHAT exists or what to do next. This is
  // the same fact updateEmail already reports in plain words (and the
  // unique index makes the response race-free either way).
  if (error && error.code === '23505') {
    return c.json({ success: false, code: 'EMAIL_TAKEN',
      message: 'An account with this email already exists. Try signing in — or reset your password if you have forgotten it.' }, 409)
  }
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
    data: { token: await issueSessionToken(c, user), user: safeUser(user) } }, 201)
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
  // before any DB work in the normal (not locked) case, and answered
  // identically for every email (real account or not) so a lockout response
  // itself never reveals whether the account exists.
  //
  // AUDIT FIX (Auth section round 1): a locked request from the network the
  // account last signed in from is let through to the password check (see
  // lockoutBlocks() above) — that needs the account's last_login_ip, so the
  // row is loaded early, and only, when the account is actually locked. For
  // an unknown email there is no row, no bypass, and the same 429.
  const supabase = getSupabase(c.env)
  const findUser = async () => {
    const { data: row, error } = await supabase
      .from('users').select('*').eq('email', email).is('deleted_at', null).maybeSingle()
    if (error) throw error
    return userRowToCamel(row)
  }

  // BUG FIX (Auth round 3, B7): the dummy hash is built lazily, so the first
  // unknown-email sign-in on a cold isolate paid hash + compare (~2x bcrypt)
  // while a known email paid one compare — a one-off timing tell per isolate.
  // Building it up front, on EVERY path, makes both branches pay the same.
  await getDummyPasswordHash()

  const lockout = await checkAccountLockout(c.env, email)
  let user
  if (lockout.locked) {
    user = await findUser()
    if (lockoutBlocks(c, lockout, user && user.lastLoginIp)) return lockedResponse(c, lockout)
  } else {
    user = await findUser()
  }

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
  // Backgrounded (see recordLoginMetadata's own comment); it hands back the
  // login-metadata values it is about to store so the response below reports
  // the state AFTER this sign-in (previousLoginAt/Ip = the sign-in before this
  // one) rather than the row as it was read.
  const loginMeta = recordLoginMetadata(c, user)
  return c.json({ success: true, data: { token: await issueSessionToken(c, user), user: safeUser({ ...user, ...loginMeta }) } })
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
// Renewing a token that would only live a few minutes longer than the one it
// replaces (which happens as a session nears its absolute expiry) buys
// nothing and just churns tokens on every call.
const TOKEN_MIN_EXTENSION_SECONDS = 60 * 60
async function getMe(c) {
  // AUDIT FIX (Auth section round 1): tokenVersion is server-side bookkeeping;
  // it was being returned to the client verbatim. Pulled out here for renewal
  // and kept out of the response.
  const { tokenVersion, ...user } = c.get('user')
  const identity = { id: user.id, tokenVersion }
  const tokenExp = c.get('tokenExp')
  const sid = c.get('sessionId')
  let token
  if (typeof tokenExp === 'number') {
    const nowSec = Math.floor(Date.now() / 1000)
    const remaining = tokenExp - nowSec
    if (!sid) {
      // A token issued before server-side sessions existed: upgrade it to a
      // real, revocable, absolutely-bounded session the first time it is seen.
      // If the session row can't be created, fall back to the old renewal rule.
      const session = await sessionsLib.createSession(c, getSupabase(c.env), user.id)
      if (session) token = await issueJWT(c.env, identity, session)
      else if (remaining < TOKEN_RENEW_THRESHOLD_SECONDS) token = await issueJWT(c.env, identity, null)
    } else if (remaining < TOKEN_RENEW_THRESHOLD_SECONDS) {
      // AUDIT FIX (Auth section round 1): renewal used to be unbounded — a
      // stolen token that called this once a day never expired. The new token
      // is capped at the session's ABSOLUTE expiry, which renewal can't move.
      const session = { id: sid, expiresAtMs: c.get('sessionExpiresAtMs') }
      const lifetime = sessionsLib.tokenLifetimeSeconds(c.env, session)
      if (nowSec + lifetime - tokenExp > TOKEN_MIN_EXTENSION_SECONDS) token = await issueJWT(c.env, identity, session)
    }
  }
  return c.json({ success: true, data: { user, ...(token ? { token } : {}) } })
}

// POST /api/auth/forgot-password
async function forgotPassword(c) {
  const body = await c.req.json()
  const { email, turnstileToken } = z.object({
    email: emailSchema,
    turnstileToken: z.string().max(2048).nullish()
  }).parse(body)
  // The challenge says nothing about any account, so failing it can't be used to probe for one.
  const challenge = await challengeFailure(c, turnstileToken)
  if (challenge) return challenge
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

  // AUDIT FIX (Auth/Scan round): the per-recipient email throttle (see
  // email.service.js RECIPIENT_LIMITS — 3 reset emails per address per hour)
  // used to be discovered by send() AFTER this handler had already
  // overwritten reset_token. The fourth request in an hour therefore stored
  // a token whose raw value was never mailed: the link already in the
  // owner's inbox died, and the owner's own new request was silently
  // swallowed — and since this endpoint is unauthenticated, four requests
  // from a stranger were enough to do that to anyone. Now the slot is
  // reserved FIRST; a throttled request rotates nothing, so the last link
  // that actually reached the inbox keeps working.
  //
  // Timing: every branch performs one KV slot operation and one users-table
  // UPDATE before answering (the real ones, or no-op equivalents for an
  // unknown email / a throttled one), so none of them is distinguishable by
  // latency.
  const raw    = cryptoLib.randomToken(32)
  const stored = await cryptoLib.sha256(raw)
  const exp    = expiry(constants.RESET_TOKEN_EXPIRY_HOURS)

  let allowed = false
  try {
    allowed = await emailService.reserveRecipientSlot(c.env, user ? email : `${cryptoLib.uuid()}@timing.invalid`, 'password_reset')
  } catch (e) {
    console.error('forgotPassword slot reservation:', e.message)
  }

  if (user && allowed) {
    // Checked: mailing a reset link whose token was never stored gives the user a dead link.
    try {
      must(await supabase.from('users').update({ reset_token: stored, reset_token_expiry: exp }).eq('id', user.id), 'store reset token')
    } catch (err) {
      await refundSlot(c, email, 'password_reset')
      throw err
    }
    // waitUntil, not fire-and-forget — see register()'s comment for why.
    c.executionCtx.waitUntil(
      emailService.sendPasswordReset(c.env, supabase, email, user.name, raw, { slotReserved: true })
        .catch(e => console.error('Reset email:', e.message))
    )
  } else {
    // HARDENING (Auth section audit, fresh pass): login() burns a comparable
    // bcrypt.compare when no matching user exists (see getDummyPasswordHash()
    // above) so "no such email" and "wrong password" can't be told apart by
    // response latency. An equivalent UPDATE filtered on a random uuid that
    // can never match a real row costs the same round trip and index lookup
    // without touching any data — used for an unknown email AND for a
    // throttled real one.
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

  const emailProblem = passwordEmailProblem(newPassword, user.email)
  if (emailProblem) return c.json({ success: false, message: emailProblem }, 400)
  const breachProblem = await passwordBreachProblem(c.env, newPassword)
  if (breachProblem) return c.json({ success: false, message: breachProblem }, 400)

  // Checked (see lib/db.js): supabase-js never throws, so an unchecked failed
  // write here told the user their password was reset when nothing had been
  // written — and left the old password, and every old session, working.
  //
  // AUDIT FIX (Auth section round 1): the write also has to be a
  // compare-and-swap. It filtered on id alone, so two concurrent requests
  // presenting the same single-use token both passed the lookup above and both
  // wrote — and each computed tokenVersion from the row it had read, so one
  // could overwrite the other's bump with a LOWER number and revive revoked
  // tokens. Matching reset_token and token_version in the WHERE clause lets
  // exactly one request win; `.select()` reveals whether a row matched.
  const { data: swapped, error: swapErr } = await supabase.from('users').update({
    password_hash:      await bcrypt.hash(newPassword, 10),
    // Following an emailed single-use link proves control of this inbox —
    // the same fact verification establishes — so the address is verified
    // too (previously someone who reset their password via the link stayed
    // "unverified" and still had to click a second, redundant link).
    email_verified:     true,
    reset_token:        null,
    reset_token_expiry: null,
    token_version:       user.tokenVersion + 1,  // kills all existing sessions
    // BUG FIX (Auth section audit): changePassword already clears a pending
    // email change on the reasoning "shouldn't survive proving you know the
    // current password" — this endpoint proves an even STRONGER form of
    // identity (control of the actual inbox) but never applied the same
    // clearing. Concretely: if an email change was staged in flight (by the
    // real owner, or by whoever got in some other way) and the owner
    // recovers the account via this exact flow, the pending change survived
    // untouched — whoever holds pending_email_token could still confirm it
    // later and take over the account's email, right through the recovery
    // flow that was supposed to lock them out.
    pending_email: null, pending_email_token: null, pending_email_expiry: null
  }).eq('id', user.id).eq('reset_token', stored).eq('token_version', user.tokenVersion).select('id').maybeSingle()
  if (swapErr) throw swapErr
  if (!swapped) return c.json({ success: false, message: 'Reset link invalid or expired.' }, 400)
  await revokeAllSessions(supabase, user.id)

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

// GET /api/auth/reset-password/validate?token=xxx
// FEATURE GAP CLOSED (Auth/Scan round): the reset page couldn't tell a dead
// link from a live one until AFTER the person had typed and submitted a new
// password — the worst place to learn "expired". Read-only and side-effect
// free; the answer is only about the caller's own 256-bit token, so it
// reveals nothing about any account.
async function checkResetToken(c) {
  const token = c.req.query('token')
  if (!token) return c.json({ success: true, data: { valid: false } })
  const supabase = getSupabase(c.env)
  const stored = await cryptoLib.sha256(token)
  const { data: row, error } = await supabase
    .from('users').select('id').eq('reset_token', stored)
    .gt('reset_token_expiry', new Date().toISOString())
    .is('deleted_at', null).eq('status', 'ACTIVE').maybeSingle()
  if (error) throw error
  return c.json({ success: true, data: { valid: !!row } })
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

  if (!user) {
    // AUDIT FIX (Auth/Scan round): the token was single-use AND deleted on
    // success, so a SECOND visit to the same link (a double click, a link
    // scanner or mail client that loads the page first, the SPA effect
    // running twice) got "invalid or expired" for an address that IS
    // verified. The hash is now kept after success, so a replay of an
    // already-used link is answered truthfully. It can only ever report
    // "already verified" — no state changes on this path.
    const { data: doneRow, error: doneErr } = await supabase
      .from('users').select('id').eq('email_verify_token', stored).eq('email_verified', true)
      .is('deleted_at', null).eq('status', 'ACTIVE').maybeSingle()
    if (doneErr) throw doneErr
    if (doneRow) return c.json({ success: true, message: 'Email already verified.' })
    return c.json({ success: false, message: 'Verification link invalid or expired.' }, 400)
  }

  must(await supabase.from('users').update({
    email_verified: true, email_verify_expiry: null
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

  // AUDIT FIX (Auth/Scan round): reserve the per-recipient email slot BEFORE
  // rotating the token — see forgotPassword() for the full reasoning. Here
  // the caller is signed in, so being honest about the limit costs nothing:
  // the alternative was rotating the token, mailing nothing, and leaving the
  // person with only a dead link (their latest email's token was gone).
  if (!(await emailService.reserveRecipientSlot(c.env, user.email, 'email_verification'))) {
    return c.json({ success: false,
      message: 'We\'ve already sent several verification emails to this address in the last hour. Please check your inbox (and spam folder) for the latest one, or try again later.' }, 429)
  }

  try {
    must(await supabase.from('users').update({ email_verify_token: stored, email_verify_expiry: exp }).eq('id', user.id), 'store verify token')
  } catch (err) {
    await refundSlot(c, user.email, 'email_verification')
    throw err
  }
  // waitUntil, not fire-and-forget — see register()'s comment for why. This
  // was the exact cause of "resend verification never arrives": the request
  // returned successfully, but the actual Resend API call was getting
  // silently cancelled before it completed, since nothing protected it.
  c.executionCtx.waitUntil(
    emailService.sendVerification(c.env, supabase, user.email, user.name, raw, { slotReserved: true })
      .catch(e => console.error('Resend verify:', e.message))
  )

  return c.json({ success: true, message: 'Verification email sent.' })
}

// Scan statuses that mean a background job is (or should be) writing to the
// row, and how long without an update before we assume the job is dead.
const IN_FLIGHT_SCAN_STATUSES = ['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING']
const IN_FLIGHT_WINDOW_MS = 60 * 60 * 1000

async function countInFlightScans(supabase, { userId }) {
  const since = new Date(Date.now() - IN_FLIGHT_WINDOW_MS).toISOString()
  const { count, error } = await supabase.from('scans')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).in('status', IN_FLIGHT_SCAN_STATUSES).gt('updated_at', since)
  if (error) throw error
  return count || 0
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
  if (lockoutBlocks(c, lockout, sessionUser.lastLoginIp)) return lockedResponse(c, lockout)

  const supabase = getSupabase(c.env)
  // maybeSingle, not single: the row can vanish between the auth middleware and
  // here (an account deleted from another tab). single() turned that into an
  // unhandled PGRST116 500; it's an authentication answer, not a server fault.
  const { data: row, error } = await supabase.from('users').select('*').eq('id', sessionUser.id).maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)
  const user = userRowToCamel(row)

  if (!await bcrypt.compare(currentPassword, user.passwordHash)) {
    // requireDistinctIps: false — see recordLoginFailure's own comment. This
    // endpoint is authenticated (a stolen JWT, not a stranger, is the threat),
    // so the distinct-IP bar login() needs would just let a single-IP
    // attacker guess forever without ever tripping the lock.
    const failResult = await recordLoginFailure(c.env, sessionUser.email, clientIp(c), { requireDistinctIps: false })
    maybeSendLockoutAlert(c, failResult, user)
    return c.json({ success: false, message: 'Current password incorrect.' }, 400)
  }
  await recordLoginSuccess(c.env, sessionUser.email)

  const emailProblem = passwordEmailProblem(newPassword, user.email)
  if (emailProblem) return c.json({ success: false, message: emailProblem }, 400)
  if (newPassword === currentPassword) {
    return c.json({ success: false, message: 'Your new password must be different from your current one.' }, 400)
  }
  const breachProblem = await passwordBreachProblem(c.env, newPassword)
  if (breachProblem) return c.json({ success: false, message: breachProblem }, 400)

  const newTokenVersion = user.tokenVersion + 1  // signs out every existing session, including this one
  // Checked (see lib/db.js): this write used to be fire-and-forget. If it
  // failed, the handler carried on — reported "Password updated", sent the
  // "your password was changed" email, and minted a token carrying a
  // tokenVersion that was never stored, which killed the user's own session
  // while the password stayed exactly as it was.
  // Compare-and-swap on token_version (AUDIT FIX, Auth section round 1): see
  // resetPassword — a read-then-write of tokenVersion could lose a concurrent
  // bump and lower the counter.
  const { data: swapped, error: swapErr } = await supabase.from('users').update({
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
  }).eq('id', user.id).eq('token_version', user.tokenVersion).select('id').maybeSingle()
  if (swapErr) throw swapErr
  if (!swapped) return c.json({ success: false, message: 'Your account changed while this was being processed. Please try again.' }, 409)
  // Every session is dead now (token_version); mark the rows so the device list
  // is truthful, then start a fresh one for THIS browser below.
  await revokeAllSessions(supabase, user.id)

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
  const token = await issueSessionToken(c, { id: user.id, tokenVersion: newTokenVersion })

  // FEATURE (Auth section round 2): see sendPasswordChanged's comment.
  c.executionCtx.waitUntil(
    emailService.sendPasswordChanged(c.env, supabase, user.email, user.name)
      .catch(e => console.error('Password-changed email:', e.message))
  )

  return c.json({ success: true, message: 'Password updated. Other sessions signed out.', data: { token } })
}

// POST /api/auth/sessions/revoke-others
// FEATURE (Auth section audit): the only way to kill outstanding sessions
// was as a side effect of changing the password, resetting it, or deleting
// the account — someone who just wants to sign a lost/stolen device out
// (nothing else wrong, no reason to also pick a new password) had no way to
// do that. Bumps token_version on its own, same as those flows do as a
// side effect, and reissues a fresh token for THIS session for the same
// reason changePassword's own reissue above does: the tab that clicked the
// button shouldn't get logged out along with everything else. No password
// re-confirmation needed — this only narrows what the caller's own,
// already-verified session can do (sign other copies of itself out), it
// doesn't touch the credential or any other account data.
async function signOutOtherSessions(c) {
  const sessionUser = c.get('user')
  const supabase = getSupabase(c.env)
  const sid = c.get('sessionId') || null

  // AUDIT FIX (Auth section round 1): this used to read tokenVersion, add 1 in
  // JS and write it back — a concurrent bump could be overwritten by a LOWER
  // number, silently un-revoking tokens. revoke_other_sessions (0047) bumps
  // token_version with a single `token_version + 1` UPDATE and revokes every
  // session row except this one, atomically, returning the new version.
  const { data: newTokenVersion, error } = await supabase.rpc('revoke_other_sessions', {
    p_user_id: sessionUser.id, p_keep_session: sid
  })
  if (error) throw error
  if (typeof newTokenVersion !== 'number')
    return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)

  const identity = { id: sessionUser.id, tokenVersion: newTokenVersion }
  const token = sid
    ? await issueJWT(c.env, identity, { id: sid, expiresAtMs: c.get('sessionExpiresAtMs') })
    : await issueSessionToken(c, identity) // a pre-sessions token: start a real session for this browser
  return c.json({ success: true, message: 'Other sessions signed out.', data: { token } })
}

// POST /api/auth/logout
// FEATURE GAP CLOSED (Auth section round 1): "Sign out" only ever deleted the
// browser's copy of the token, so a copied token stayed valid for its full
// lifetime. This revokes the server-side session the token is bound to. A
// pre-sessions token has nothing to revoke server-side (the client still
// discards it); the answer is a success either way so a client can always
// sign out.
async function logout(c) {
  const sid = c.get('sessionId')
  if (sid) {
    const supabase = getSupabase(c.env)
    must(await supabase.from('user_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', sid).eq('user_id', c.get('user').id).is('revoked_at', null), 'revoke session')
  }
  return c.json({ success: true, message: 'Signed out.' })
}

// GET /api/auth/sessions
// The account's live sessions (device list): this one is flagged `current`.
// `currentSessionKnown` is false while the caller is still on a pre-sessions
// token — getMe() upgrades it on its next call, after which it appears here.
async function listSessions(c) {
  const user = c.get('user')
  const sid = c.get('sessionId')
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('user_sessions')
    .select(sessionsLib.SESSION_COLUMNS)
    .eq('user_id', user.id).is('revoked_at', null)
    .gt('absolute_expires_at', new Date().toISOString())
    .order('last_seen_at', { ascending: false })
    .limit(constants.SESSION_MAX_ACTIVE)
  if (error) throw error
  return c.json({ success: true, data: {
    currentSessionKnown: !!sid,
    sessions: (data || []).map(r => ({
      id: r.id, current: r.id === sid,
      createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.absolute_expires_at,
      ip: r.ip ?? null, userAgent: r.user_agent ?? null
    }))
  } })
}

// DELETE /api/auth/sessions/:id
// Signs one device out. Scoped to the caller's own sessions, so another
// account's id is indistinguishable from one that doesn't exist (404 both).
async function revokeSession(c) {
  const id = c.req.param('id')
  if (!sessionsLib.isSessionId(id)) return c.json({ success: false, message: 'Session not found.' }, 404)
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('user_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', c.get('user').id).is('revoked_at', null)
    .select('id').maybeSingle()
  if (error) throw error
  if (!data) return c.json({ success: false, message: 'Session not found.' }, 404)
  const current = id === c.get('sessionId')
  return c.json({ success: true, message: current ? 'Signed out.' : 'Session signed out.', data: { current } })
}

// POST /api/auth/accept-terms
// FEATURE GAP CLOSED (Auth section, second independent pass): the write side
// of safeUser()'s new termsCurrent flag above — once a signed-in account is
// told its accepted Terms/Privacy version is stale, this is what actually
// records fresh acceptance. Deliberately no request body: there is only ever
// one thing to accept — whatever constants.TERMS_VERSION currently is — so
// there's nothing for a caller to get wrong or spoof by passing their own
// version string. No password confirmation needed, same posture as
// updateName: this doesn't change anything security- or identity-adjacent.
async function acceptTerms(c) {
  const sessionUser = c.get('user')
  const supabase = getSupabase(c.env)
  // maybeSingle, not single (Auth round 3, B6): the row can vanish between the auth
  // middleware and here (account deleted in another tab); that is an authentication
  // answer, not an unhandled PGRST116 500 — same as changePassword/updateEmail.
  const { data: row, error } = await supabase.from('users').update({
    terms_accepted_at: new Date().toISOString(),
    terms_version:     constants.TERMS_VERSION
  }).eq('id', sessionUser.id).select().maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)

  return c.json({ success: true, message: 'Terms accepted.', data: { user: safeUser(userRowToCamel(row)) } })
}

// PATCH /api/auth/name
// AUDIT FIX (Section 6): Settings displayed Name as static text with no way
// to ever change it — no endpoint existed anywhere in the app. Low-risk
// field, no password confirmation or re-verification needed.
async function updateName(c) {
  const sessionUser = c.get('user')
  const body = await c.req.json()
  const { name } = z.object({ name: nameSchema }).parse(body)

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase
    .from('users').update({ name }).eq('id', sessionUser.id).select().maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)

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
  if (lockoutBlocks(c, lockout, sessionUser.lastLoginIp)) return lockedResponse(c, lockout)

  const supabase = getSupabase(c.env)
  // maybeSingle, not single: the row can vanish between the auth middleware and
  // here (an account deleted from another tab). single() turned that into an
  // unhandled PGRST116 500; it's an authentication answer, not a server fault.
  const { data: row, error } = await supabase.from('users').select('*').eq('id', sessionUser.id).maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)
  const user = userRowToCamel(row)

  if (!await bcrypt.compare(password, user.passwordHash)) {
    // requireDistinctIps: false — see recordLoginFailure's own comment; same
    // reasoning as changePassword's identical call above.
    const failResult = await recordLoginFailure(c.env, sessionUser.email, clientIp(c), { requireDistinctIps: false })
    maybeSendLockoutAlert(c, failResult, user)
    return c.json({ success: false, message: 'Incorrect password.' }, 400)
  }
  await recordLoginSuccess(c.env, sessionUser.email)

  // AUDIT FIX (Auth round 2, B5): a cancel request carrying some OTHER address
  // used to fall through and silently STAGE a new change to it instead. Cancel
  // is only ever "the account's own current email + cancelPending", so anything
  // else is a malformed request, not a change request.
  if (cancelPending && newEmail !== user.email) {
    return c.json({ success: false, message: 'To cancel a pending email change, submit your current email address.' }, 400)
  }

  if (newEmail === user.email) {
    if (cancelPending && user.pendingEmail) {
      must(await supabase.from('users').update({
        pending_email: null, pending_email_token: null, pending_email_expiry: null
      }).eq('id', user.id), 'cancel pending email change')
      return c.json({ success: true, message: 'Email change canceled.' })
    }
    // Asked to cancel, but nothing is pending (already confirmed, expired and
    // cleared, or canceled from another tab) — say so, rather than the
    // misleading "that is already your email address".
    if (cancelPending) return c.json({ success: false, message: 'There is no pending email change to cancel.' }, 400)
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

  // AUDIT FIX (Auth/Scan round): reserve the per-recipient slot before
  // staging a new confirmation token — same reasoning as forgotPassword():
  // a throttled send must not replace a link that was already mailed.
  if (!(await emailService.reserveRecipientSlot(c.env, newEmail, 'email_change_confirm'))) {
    return c.json({ success: false,
      message: 'Too many confirmation emails have been sent to that address recently. Please check its inbox for the latest one, or try again later.' }, 429)
  }

  const { error: updateErr } = await supabase.from('users').update({
    pending_email:        newEmail,
    pending_email_token:  stored,
    pending_email_expiry: exp
  }).eq('id', user.id)
  if (updateErr) {
    await refundSlot(c, newEmail, 'email_change_confirm')
    throw updateErr
  }

  c.executionCtx.waitUntil(
    emailService.sendEmailChangeConfirmation(c.env, supabase, newEmail, user.name, raw, { slotReserved: true })
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
  if (!user || !user.pendingEmail) {
    // AUDIT FIX (Auth section round 1): this link is single-use, and a SECOND
    // visit (a mail scanner or client that loads it first, a double tap, the
    // back button) answered "invalid or expired" for an address that HAD just
    // been confirmed — verifyEmail got the truthful-replay treatment, this
    // page didn't. email_change_done_token (0047) keeps the hash of the last
    // token consumed, so a replay reads "already updated". It can only ever
    // report that; nothing changes and no session is issued on this path.
    const { data: doneRow, error: doneErr } = await supabase
      .from('users').select('id').eq('email_change_done_token', stored)
      .is('deleted_at', null).eq('status', 'ACTIVE').maybeSingle()
    if (doneErr) throw doneErr
    if (doneRow) return c.json({ success: true, message: 'Email address already updated.', data: { alreadyConfirmed: true } })
    return c.json({ success: false, message: 'Confirmation link invalid or expired.' }, 400)
  }

  // AUDIT FIX (Auth round 2, B1): this link is mailed to the NEW address, and
  // used to be enough on its own: whoever opened it had the change applied AND
  // was handed a live session for the account. When the new address is a typo
  // that happens to be a real stranger's inbox, that stranger became the
  // account's login email and got signed in as its owner. Reading the new
  // inbox proves control of the NEW address, never that the person is the
  // account's owner — so the request must ALSO come from a session of this very
  // account (the browser that asked for the change is the usual one; anyone
  // else signs in first and opens the link again — nothing is consumed here).
  // optionalAuth already resolved the Authorization header app-wide.
  if (c.get('authError') === 'unavailable') {
    // Our lookup failed, not their credentials: a 5xx, never "sign in".
    throw Object.assign(new Error('Could not verify the signed-in session.'), { status: 503, expose: true })
  }
  const caller = c.get('user')
  if (!caller || caller.id !== user.id) {
    // 403, not 401: the SPA reads a 401 on a request that carried a token as "your
    // session is dead" and signs the person out — wrong when they are simply
    // signed in as a different account than the one this link belongs to.
    return c.json({ success: false, code: 'SIGN_IN_REQUIRED', reason: caller ? 'WRONG_ACCOUNT' : 'SIGNED_OUT',
      message: caller
        ? 'You are signed in to a different account. Sign in to the account whose email is changing, then open this link again.'
        : 'Sign in to your account first, then open this link again to confirm the new email.' }, 403)
  }

  // The proactive uniqueness check in updateEmail can't see a SECOND email
  // change (by this account or another) that landed in between — re-check
  // here, right before the write that would otherwise 23505.
  const { data: existing, error: existingErr } = await supabase
    .from('users').select('id').eq('email', user.pendingEmail).neq('id', user.id).is('deleted_at', null).maybeSingle()
  if (existingErr) throw existingErr
  if (existing) {
    must(await supabase.from('users').update({
      pending_email: null, pending_email_token: null, pending_email_expiry: null
    }).eq('id', user.id), 'clear conflicting pending email')
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
  //
  // AUDIT FIX (Auth section round 1): the write is a compare-and-swap on the
  // very token being consumed and on token_version (see resetPassword) — two
  // concurrent requests with the same link can no longer both succeed, and a
  // stale tokenVersion can't overwrite a newer bump with a lower one. A unique-
  // constraint hit (another account took the address after the checks above)
  // is answered like the earlier duplicate case instead of a 500.
  const { data: updatedRow, error: updateErr } = await supabase.from('users').update({
    email:                 user.pendingEmail,
    email_verified:        true,
    pending_email:         null,
    pending_email_token:   null,
    pending_email_expiry:  null,
    token_version:         newTokenVersion,
    // BUG FIX (Auth section audit): the account's identity is changing here,
    // same as a password change — resetPassword's own comment (see above)
    // establishes that a credential left over from BEFORE the identity check
    // shouldn't survive it. A reset_token issued earlier (e.g. from a briefly
    // -compromised old inbox, before the owner moved to a new address) stays
    // valid for its full window even after the email it was tied to has
    // moved on, unless cleared here.
    reset_token: null, reset_token_expiry: null,
    // Remember which token was consumed so a replay can be answered truthfully.
    email_change_done_token: stored
  }).eq('id', user.id).eq('pending_email_token', stored).eq('token_version', user.tokenVersion).select().maybeSingle()
  if (updateErr) {
    if (updateErr.code === '23505') {
      must(await supabase.from('users').update({
        pending_email: null, pending_email_token: null, pending_email_expiry: null
      }).eq('id', user.id), 'clear conflicting pending email')
      return c.json({ success: false, message: 'That email address is already in use.' }, 400)
    }
    throw updateErr
  }
  if (!updatedRow) return c.json({ success: false, message: 'Confirmation link invalid or expired.' }, 400)
  const updated = userRowToCamel(updatedRow)

  // token_version moved, so every session is dead: mark the rows, then start a
  // fresh session for the browser that confirmed.
  await revokeAllSessions(supabase, user.id)
  const newToken = await issueSessionToken(c, { id: user.id, tokenVersion: newTokenVersion })
  // FEATURE (Auth round 2, G3): the old address only ever heard about the
  // REQUEST. The moment the change actually lands is the one it most needs to
  // know about — and the only thing it can still do about it is act fast.
  c.executionCtx.waitUntil(
    emailService.sendEmailChangeCompleted(c.env, supabase, user.email, user.name, updated.email)
      .catch(e => console.error('Email-change completed notice:', e.message))
  )
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
  if (lockoutBlocks(c, lockout, sessionUser.lastLoginIp)) return lockedResponse(c, lockout)

  const supabase = getSupabase(c.env)
  // maybeSingle, not single: the row can vanish between the auth middleware and
  // here (an account deleted from another tab). single() turned that into an
  // unhandled PGRST116 500; it's an authentication answer, not a server fault.
  const { data: row, error } = await supabase.from('users').select('*').eq('id', sessionUser.id).maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)
  const user = userRowToCamel(row)

  if (!await bcrypt.compare(password, user.passwordHash)) {
    // requireDistinctIps: false — see recordLoginFailure's own comment; same
    // reasoning as changePassword/updateEmail's identical calls above.
    const failResult = await recordLoginFailure(c.env, sessionUser.email, clientIp(c), { requireDistinctIps: false })
    maybeSendLockoutAlert(c, failResult, user)
    return c.json({ success: false, message: 'Incorrect password.' }, 400)
  }
  await recordLoginSuccess(c.env, sessionUser.email)

  // A scan or fix still being produced in the background writes its results
  // (structured resume data, report, rewritten files) when it finishes. Run
  // after the scrub below, that job would put personal data straight back onto
  // a deleted account's scan — and re-upload files after the R2 cleanup below
  // has already run — and the retention sweep only ever purges anonymous scans.
  // So: not while work is in flight. Anything untouched for an hour is a job
  // that died (the hourly cron flips those to ERROR), and must never make an
  // account undeletable.
  const inFlight = await countInFlightScans(supabase, { userId: user.id })
  if (inFlight > 0) {
    return c.json({ success: false,
      message: 'One of your scans is still being processed. Please try again in a few minutes.' }, 409)
  }

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
    .select('id, resume_path, resume_ats_path, resume_pdf_path, verification_code, resume_hash, resume_pdf_hash, resume_hash_history')
    .eq('user_id', user.id)
  if (scansErr) throw scansErr

  const { error: scrubErr } = await supabase.rpc('scrub_account_data', { p_user_id: user.id })
  if (scrubErr) throw scrubErr

  // The scrub nulled every verification_code; leave the codes' tombstones so links already
  // in circulation read "removed by its owner" rather than "not found".
  await recordTombstones(supabase, scans || [])

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
    // scrub_account_data has already renamed this account's earlier log rows
    // to the placeholder address (0029), so purging by the real address alone
    // only ever caught the deletion confirmation's own row — everything mailed
    // before it survived under `deleted-<id>@…`, which still ties it to the
    // account's id. Purge both.
    const { error: logErr } = await supabase.from('email_logs').delete()
      .in('to', [preScrubEmail, `deleted-${user.id}@passthrough.dev`])
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
    // anon_token is stored as sha256(token) (migration 0045)
    .eq('anon_token', await cryptoLib.sha256(anonToken))
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
  //
  // AUDIT FIX (bug — Auth section, second independent pass): the SELECT above
  // checks user_id IS NULL, but this UPDATE used to filter on id alone — the
  // anonToken is mailed out as a magic link (sendAnonScanResult) and can be
  // forwarded or intercepted, so two different accounts racing to claim it
  // could both pass the SELECT before either UPDATE committed, and the second
  // write would silently steal the scan out from under the first with no
  // error to either caller (Supabase doesn't report "0 rows matched" on an
  // update with no .select()). Re-asserting user_id IS NULL here makes the
  // claim an atomic compare-and-swap: only the first writer can ever succeed,
  // and .select().maybeSingle() lets the loser find out honestly instead of
  // getting back a false "success".
  const { data: claimed, error: claimErr } = await supabase.from('scans').update({
    user_id: user.id, anon_token: null, anon_expires_at: null,
    contact_name: null, contact_email: null
  }).eq('id', scan.id).is('user_id', null).select('id').maybeSingle()
  if (claimErr) throw claimErr
  if (!claimed) return c.json({ success: false, message: 'Scan not found or expired.' }, 404)

  return c.json({ success: true, data: { scanId: claimed.id } })
}

module.exports = {
  register, login, getMe, forgotPassword, resetPassword, checkResetToken,
  verifyEmail, resendVerification, changePassword, signOutOtherSessions, updateName, updateEmail,
  confirmEmailChange, deleteAccount, claimScan, acceptTerms,
  logout, listSessions, revokeSession
}
