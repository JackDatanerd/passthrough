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
  try {
    const header = c.req.header('Authorization')
    if (!header?.startsWith('Bearer '))
      return c.json({ success: false, message: 'Authentication required' }, 401)

    const decoded = await jwtLib.verify(header.slice(7), c.env.JWT_SECRET)
    const supabase = getSupabase(c.env)
    const { data: row, error } = await supabase
      .from('users').select('*').eq('id', decoded.userId).maybeSingle()
    if (error) throw error

    const user = userRowToCamel(row)
    if (!user || user.deletedAt)
      return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)
    if (user.status === 'BANNED')
      return c.json({ success: false, message: 'Account suspended.', code: 'BANNED' }, 403)
    if (user.tokenVersion !== decoded.tokenVersion)
      return c.json({ success: false, message: 'Session expired.', code: 'SESSION_INVALID' }, 401)

    const { passwordHash, paystackAuthCode, paystackCustomerCode, resetToken, resetTokenExpiry, emailVerifyToken, emailVerifyExpiry, savedProfile, ...safe } = user
    c.set('user', safe)
    // AUDIT FIX: the JWT's `exp` claim from THIS request's already-verified
    // token, stashed for getMe() to use for silent renewal (see that
    // handler) — feature gap: the 7-day JWT never renewed itself, so any
    // daily-active user got hard-logged-out mid-session the moment it
    // lapsed, no warning. Exposed via c.set rather than re-decoding: the
    // token is already verified above, no need to parse it twice.
    c.set('tokenExp', decoded.exp)
    await next()
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return c.json({ success: false, message: 'Session expired.', code: 'TOKEN_EXPIRED' }, 401)
    return c.json({ success: false, message: 'Invalid token' }, 401)
  }
}

module.exports = auth
