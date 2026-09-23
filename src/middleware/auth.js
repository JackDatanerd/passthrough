// Hono middleware signature: async (c, next) => {...}. Replaces Express's
// (req, res, next). c.req.header() for headers, c.set/c.get for attaching
// req.user equivalent, c.json() for responses, c.env for bindings (instead
// of process.env), c.executionCtx for waitUntil where needed elsewhere.
//
// Security properties unchanged from v8: JWT verified via lib/jwt.js (Web
// Crypto HS256), tokenVersion checked for session invalidation, deletedAt
// and BANNED status checked, and sensitive fields stripped before attaching
// the user object — paystackAuthCode, paystackCustomerCode, resetToken,
// resetTokenExpiry, emailVerifyToken, emailVerifyExpiry, passwordHash,
// savedProfile. (resetTokenExpiry/emailVerifyExpiry were previously missed
// here — low-severity since they're just timestamps, not secrets, but
// GET /auth/me was leaking them regardless.)

const jwtLib = require('../lib/jwt')
const { getSupabase } = require('../config/supabase')
const { userRowToCamel } = require('../lib/mappers')

async function auth(c, next) {
  // AUDIT FIX (bug — redundant double auth check): optionalAuth (mounted
  // app-wide in index.js, ahead of every route including this one) already
  // ran the exact same JWT verify + full Supabase user-row fetch this
  // request, for every request, authenticated or not. Doing that work AGAIN
  // here doubled the DB round-trip and HMAC verify cost on every single
  // authenticated request app-wide, for no behavioral benefit — a genuinely
  // wasteful default that only got worse at scale.
  //
  // optionalAuth only ever sets BOTH c.get('user') and c.get('tokenExp')
  // together, and only after passing every check this function's full path
  // below also performs (deletedAt, BANNED, tokenVersion match) — see its
  // own logic. So if both are present, this request already passed
  // everything this function would otherwise re-check; reuse that result
  // and skip straight to next() instead of re-verifying and re-fetching.
  //
  // If either is missing — no token, an invalid/expired token, a banned or
  // deleted account, or a stale tokenVersion — optionalAuth deliberately
  // did NOT set them (it swallows all of those into a silent fall-through,
  // by design, since it must never block an anonymous request). Falling
  // through to the full path below is what recovers the SPECIFIC reason
  // (expired vs invalid vs banned vs not-found vs session-invalid) that
  // this function's distinct error codes depend on and optionalAuth never
  // needed to distinguish — that full path is unchanged from before this
  // fix, so behavior on every error case is identical to what it was.
  if (c.get('user') && c.get('tokenExp') !== undefined) {
    await next()
    return
  }

  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer '))
    return c.json({ success: false, message: 'Authentication required' }, 401)

  // ONLY token problems are an authentication verdict. The whole handler used
  // to sit in one try/catch that answered 401 "Invalid token" for ANY thrown
  // error — including a transient Supabase failure on the user lookup below.
  // The client treats a 401 on a request that carried a token as "your session
  // is dead" and signs the user out, so a database blip logged people out.
  let decoded
  try {
    decoded = await jwtLib.verify(header.slice(7), c.env.JWT_SECRET)
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return c.json({ success: false, message: 'Session expired.', code: 'TOKEN_EXPIRED' }, 401)
    return c.json({ success: false, message: 'Invalid token' }, 401)
  }

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase
    .from('users').select('*').eq('id', decoded.userId).maybeSingle()
  // Infrastructure failure: let it reach app.onError as a 5xx (not an auth failure).
  if (error) throw error

  const user = userRowToCamel(row)
  if (!user || user.deletedAt)
    return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)
  if (user.status === 'BANNED')
    return c.json({ success: false, message: 'Account suspended.', code: 'BANNED' }, 403)
  if (user.tokenVersion !== decoded.tokenVersion)
    return c.json({ success: false, message: 'Session expired.', code: 'SESSION_INVALID' }, 401)

  const { passwordHash, paystackAuthCode, paystackCustomerCode, resetToken, resetTokenExpiry, emailVerifyToken, emailVerifyExpiry, pendingEmailToken, pendingEmailExpiry, savedProfile, ...safe } = user
  c.set('user', safe)
  // The JWT's `exp` from THIS request's already-verified token, stashed for
  // getMe() to use for silent session renewal (added upstream; kept here).
  c.set('tokenExp', decoded.exp)
  await next()
}

module.exports = auth
