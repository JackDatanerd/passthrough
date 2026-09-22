// Same logic as auth.js, ported to Hono — but every failure path falls
// through to next() instead of returning an error response. Mounted
// app-wide in index.js so c.get('user') is available (or undefined) on
// every route without requiring login.

const jwtLib = require('../lib/jwt')
const { getSupabase } = require('../config/supabase')
const { userRowToCamel } = require('../lib/mappers')

async function optionalAuth(c, next) {
  try {
    const header = c.req.header('Authorization')
    if (!header?.startsWith('Bearer ')) return next()

    const decoded = await jwtLib.verify(header.slice(7), c.env.JWT_SECRET)
    const supabase = getSupabase(c.env)
    const { data: row, error } = await supabase
      .from('users').select('*').eq('id', decoded.userId).maybeSingle()
    if (error) throw error

    const user = userRowToCamel(row)
    if (!user || user.deletedAt || user.status === 'BANNED') return next()
    if (user.tokenVersion !== decoded.tokenVersion) return next()

    const { passwordHash, paystackAuthCode, paystackCustomerCode, resetToken, resetTokenExpiry, emailVerifyToken, emailVerifyExpiry, savedProfile, ...safe } = user
    c.set('user', safe)
    // AUDIT FIX (bug — redundant double auth check): middleware/auth.js runs
    // on every protected route AFTER this one (mounted app-wide) and used to
    // redo the exact same JWT verify + full user-row fetch from scratch,
    // even though this middleware just did identical work moments earlier
    // in the same request. Stashing tokenExp here too (not just user) is
    // what lets auth.js's own fast-path below skip straight to reusing both
    // instead of re-deriving tokenExp via a second decode.
    c.set('tokenExp', decoded.exp)
  } catch (_) {}
  return next()
}

module.exports = optionalAuth
