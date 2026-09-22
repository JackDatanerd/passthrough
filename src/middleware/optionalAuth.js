// Same logic as auth.js, ported to Hono — but every failure path falls
// through to next() instead of returning an error response. Mounted
// app-wide in index.js so c.get('user') is available (or undefined) on
// every route without requiring login.
//
// It also records WHY there is no user, in c.get('authError'), because the two
// causes need opposite handling downstream:
//   'expired' | 'invalid' | 'inactive' — the caller's credentials are bad
//   'unavailable'                      — OUR lookup failed (database blip)
// Treating both as "anonymous" is fine for a public page, but not for a route
// that needs to know: an admin whose request lands during a database hiccup
// must be told "try again" (503 — see adminOnly.js), not "log in" (401 —
// which the SPA reads as a dead session and signs them out); and a signed-in
// user's scan must not be silently created as an anonymous one that expires
// in a day (see scan.controller.js's createScan).

const jwtLib = require('../lib/jwt')
const { getSupabase } = require('../config/supabase')
const { userRowToCamel } = require('../lib/mappers')

async function optionalAuth(c, next) {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) return next()

  try {
    const decoded = await jwtLib.verify(header.slice(7), c.env.JWT_SECRET)
    try {
      const supabase = getSupabase(c.env)
      const { data: row, error } = await supabase
        .from('users').select('*').eq('id', decoded.userId).maybeSingle()
      if (error) throw error

      const user = userRowToCamel(row)
      if (!user || user.deletedAt || user.status === 'BANNED' || user.tokenVersion !== decoded.tokenVersion) {
        c.set('authError', 'inactive')
      } else {
        const { passwordHash, paystackAuthCode, paystackCustomerCode, resetToken, resetTokenExpiry, emailVerifyToken, emailVerifyExpiry, savedProfile, ...safe } = user
        c.set('user', safe)
        // AUDIT FIX (bug — redundant double auth check): middleware/auth.js
        // runs on every protected route AFTER this one and used to redo the
        // exact same JWT verify + full user-row fetch from scratch. Stashing
        // tokenExp here too (not just user) is what lets auth.js's own
        // fast-path skip straight to reusing both.
        c.set('tokenExp', decoded.exp)
      }
    } catch (err) {
      console.error('optionalAuth user lookup failed:', err.message)
      c.set('authError', 'unavailable')
    }
  } catch (err) {
    c.set('authError', err && err.name === 'TokenExpiredError' ? 'expired' : 'invalid')
  }
  return next()
}

module.exports = optionalAuth
