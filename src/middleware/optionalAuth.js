// Same logic as auth.js, but every failure path falls through to next() instead
// of returning an error response. Mounted app-wide in index.js so c.get('user')
// is available (or undefined) on every route without requiring login.
//
// It also records WHY there is no user, in c.get('authError'), because the two
// causes need opposite handling downstream:
//   'expired' | 'invalid' | 'inactive' — the caller's credentials are bad
//   'unavailable'                      — OUR lookup failed (database blip)
// Treating both as "anonymous" is fine for a public page, but not for a route
// that needs to know: an admin whose request lands during a database hiccup
// must be told "try again" (503 — see adminOnly.js), not "log in" (401 — which
// the SPA reads as a dead session and signs them out); and a signed-in user's
// scan must not be silently created as an anonymous one that expires in a day
// (see scan.controller.js's createScan).
//
// 'inactive' covers: unknown/deleted user, BANNED, stale tokenVersion, and a
// revoked or absolutely-expired server-side session.

const jwtLib = require('../lib/jwt')
const { getSupabase } = require('../config/supabase')
const { AUTH_USER_COLUMNS, toRequestUser } = require('../lib/authUser')
const { loadSession, sessionProblem, touchSession, isSessionId } = require('../lib/sessions')

async function optionalAuth(c, next) {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) return next()

  try {
    const decoded = await jwtLib.verify(header.slice(7), c.env.JWT_SECRET)
    try {
      const supabase = getSupabase(c.env)
      const hasSid = decoded.sid !== undefined
      const [userRes, sessionRes] = await Promise.all([
        supabase.from('users').select(AUTH_USER_COLUMNS).eq('id', decoded.userId).maybeSingle(),
        hasSid ? loadSession(supabase, decoded.sid) : Promise.resolve(null),
      ])
      if (userRes.error) throw userRes.error
      if (sessionRes && sessionRes.error) throw sessionRes.error

      const { user, requestUser } = toRequestUser(userRes.data)
      const sessionBad = hasSid && (!isSessionId(decoded.sid) || sessionProblem(sessionRes.data, user && user.id))
      if (!user || user.deletedAt || user.status === 'BANNED' || user.tokenVersion !== decoded.tokenVersion || sessionBad) {
        c.set('authError', 'inactive')
      } else {
        if (hasSid) {
          c.set('sessionId', decoded.sid)
          c.set('sessionExpiresAtMs', Date.parse(sessionRes.data.absolute_expires_at))
          touchSession(c, supabase, sessionRes.data)
        }
        c.set('user', requestUser)
        // Stashing tokenExp alongside user is what lets auth.js's fast path
        // skip straight to reusing both.
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
