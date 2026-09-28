// Hono middleware signature: async (c, next) => {...}. c.req.header() for
// headers, c.set/c.get for attaching the user, c.json() for responses, c.env
// for bindings.
//
// Checks, in order: JWT signature + expiry (lib/jwt.js, Web Crypto HS256),
// account exists / not deleted, not BANNED, tokenVersion matches (bulk
// revocation: password change/reset, account delete), and — for tokens that
// carry a `sid` — the server-side session is neither revoked nor past its
// absolute expiry (lib/sessions.js). Tokens issued before sessions existed have
// no sid and skip that last check until they expire or getMe() upgrades them.
//
// What reaches c.get('user') is built by lib/authUser.js (explicit column list,
// secrets never fetched).

const jwtLib = require('../lib/jwt')
const { getSupabase } = require('../config/supabase')
const { AUTH_USER_COLUMNS, toRequestUser } = require('../lib/authUser')
const { loadSession, sessionProblem, touchSession, isSessionId } = require('../lib/sessions')

async function auth(c, next) {
  // optionalAuth (mounted app-wide in index.js, ahead of every route) already
  // ran this exact verification for the request. It only sets BOTH
  // c.get('user') and c.get('tokenExp'), and only after passing every check
  // below — so if both are present, re-verifying would just double the DB
  // round-trip and HMAC cost of every authenticated request. If either is
  // missing (no/invalid/expired token, banned, deleted, stale tokenVersion,
  // revoked session) optionalAuth deliberately swallowed the reason; falling
  // through to the full path recovers the SPECIFIC error code the client keys
  // off (expired vs invalid vs banned vs not-found vs session-invalid).
  if (c.get('user') && c.get('tokenExp') !== undefined) {
    await next()
    return
  }

  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer '))
    return c.json({ success: false, message: 'Authentication required' }, 401)

  // ONLY token problems are an authentication verdict. A transient Supabase
  // failure below must reach app.onError as a 5xx — the client treats a 401 on
  // a request that carried a token as "your session is dead" and signs the user
  // out, so a database blip must never look like one.
  let decoded
  try {
    decoded = await jwtLib.verify(header.slice(7), c.env.JWT_SECRET)
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return c.json({ success: false, message: 'Session expired.', code: 'TOKEN_EXPIRED' }, 401)
    return c.json({ success: false, message: 'Invalid token' }, 401)
  }

  const supabase = getSupabase(c.env)
  const hasSid = decoded.sid !== undefined
  const [userRes, sessionRes] = await Promise.all([
    supabase.from('users').select(AUTH_USER_COLUMNS).eq('id', decoded.userId).maybeSingle(),
    hasSid ? loadSession(supabase, decoded.sid) : Promise.resolve(null),
  ])
  // Infrastructure failure: let it reach app.onError as a 5xx (not an auth failure).
  if (userRes.error) throw userRes.error
  if (sessionRes && sessionRes.error) throw sessionRes.error

  const { user, requestUser } = toRequestUser(userRes.data)
  if (!user || user.deletedAt)
    return c.json({ success: false, message: 'Account not found', code: 'USER_NOT_FOUND' }, 401)
  if (user.status === 'BANNED')
    return c.json({ success: false, message: 'Account suspended.', code: 'BANNED' }, 403)
  if (user.tokenVersion !== decoded.tokenVersion)
    return c.json({ success: false, message: 'Session expired.', code: 'SESSION_INVALID' }, 401)

  if (hasSid) {
    // A token whose sid isn't even a UUID was not minted by us — treat as revoked.
    const problem = isSessionId(decoded.sid) ? sessionProblem(sessionRes.data, user.id) : 'revoked'
    if (problem === 'expired')
      return c.json({ success: false, message: 'Session expired.', code: 'TOKEN_EXPIRED' }, 401)
    if (problem)
      return c.json({ success: false, message: 'Session expired.', code: 'SESSION_INVALID' }, 401)
    c.set('sessionId', decoded.sid)
    c.set('sessionExpiresAtMs', Date.parse(sessionRes.data.absolute_expires_at))
    touchSession(c, supabase, sessionRes.data)
  }

  c.set('user', requestUser)
  // The verified JWT's `exp`, for getMe()'s silent renewal.
  c.set('tokenExp', decoded.exp)
  await next()
}

module.exports = auth
