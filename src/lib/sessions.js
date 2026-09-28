// Server-side sessions (migration 0047).
//
// A JWT used to be the whole session: signing out only deleted the client's
// copy, and getMe()'s silent renewal meant a stolen token could be kept alive
// forever by pinging /auth/me. Every token now carries a `sid` pointing at a
// user_sessions row that can be revoked and has an ABSOLUTE expiry that renewal
// can never extend. token_version remains the "revoke everything" switch, and
// tokens issued before this shipped (no sid) keep working until they expire or
// getMe() upgrades them.
//
// DEGRADATION: if the session row cannot be created (table missing because the
// migration hasn't run yet, a database blip), createSession() returns null and
// the caller issues a sessionless token — exactly how every token behaved
// before. Bookkeeping must not be able to take sign-in down.

const constants = require('../config/constants')
const { clientIp } = require('./clientIp')
const { warnOnError } = require('./db')

const SESSION_COLUMNS = 'id, user_id, created_at, last_seen_at, absolute_expires_at, revoked_at, ip, user_agent'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function userAgentOf(c) {
  const ua = c && c.req && typeof c.req.header === 'function' ? c.req.header('User-Agent') : null
  return ua ? String(ua).slice(0, 300) : null
}

function isSessionId(sid) {
  return typeof sid === 'string' && UUID_RE.test(sid)
}

/**
 * createSession(c, supabase, userId) -> { id, expiresAtMs } | null
 * null means "could not create one" — issue a sessionless token instead.
 */
async function createSession(c, supabase, userId) {
  try {
    const { data, error } = await supabase.rpc('create_user_session', {
      p_user_id:       userId,
      p_ip:            clientIp(c) || null,
      p_user_agent:    userAgentOf(c),
      p_lifetime_days: constants.SESSION_ABSOLUTE_LIFETIME_DAYS,
      p_max_active:    constants.SESSION_MAX_ACTIVE,
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : data
    const expiresAtMs = row ? Date.parse(row.session_expires_at) : NaN
    if (!row || !isSessionId(row.session_id) || !Number.isFinite(expiresAtMs))
      throw new Error('create_user_session returned no usable row')
    return { id: row.session_id, expiresAtMs }
  } catch (err) {
    console.error('createSession failed — issuing a sessionless token:', err && err.message)
    return null
  }
}

/**
 * Seconds a token for this session should live: the configured token lifetime,
 * capped so it never outlives the session's absolute expiry.
 */
function tokenLifetimeSeconds(env, session) {
  const base = parseInt(env.JWT_EXPIRES_IN_SECONDS, 10) || 604800 // 7 days default
  if (!session || !Number.isFinite(session.expiresAtMs)) return base
  const untilAbsolute = Math.floor((session.expiresAtMs - Date.now()) / 1000)
  return Math.max(1, Math.min(base, untilAbsolute))
}

/**
 * loadSession(supabase, sid) -> { data, error }. An id that isn't a UUID can't
 * exist, so it short-circuits to "no row" instead of a Postgres cast error.
 */
async function loadSession(supabase, sid) {
  if (!isSessionId(sid)) return { data: null, error: null }
  return supabase.from('user_sessions').select(SESSION_COLUMNS).eq('id', sid).maybeSingle()
}

/**
 * sessionProblem(row, userId) -> null | 'revoked' | 'expired'
 * An unknown session, or one belonging to someone else, is 'revoked'.
 */
function sessionProblem(row, userId, nowMs = Date.now()) {
  if (!row || row.user_id !== userId || row.revoked_at) return 'revoked'
  if (!(Date.parse(row.absolute_expires_at) > nowMs)) return 'expired'
  return null
}

/**
 * Refresh last_seen_at / ip / user-agent, at most every
 * SESSION_TOUCH_INTERVAL_MINUTES, off the request path. Failure only logs.
 */
function touchSession(c, supabase, row) {
  const intervalMs = constants.SESSION_TOUCH_INTERVAL_MINUTES * 60 * 1000
  const lastSeen = Date.parse(row.last_seen_at)
  if (Number.isFinite(lastSeen) && Date.now() - lastSeen < intervalMs) return
  const work = Promise.resolve(
    supabase.from('user_sessions')
      .update({ last_seen_at: new Date().toISOString(), ip: clientIp(c) || null, user_agent: userAgentOf(c) })
      .eq('id', row.id)
      .is('revoked_at', null)
  ).then(r => warnOnError(r, 'touchSession'), err => console.error('touchSession:', err && err.message))
  try { c.executionCtx.waitUntil(work) } catch { /* no ExecutionContext (tests, local): the promise still runs */ }
}

module.exports = { SESSION_COLUMNS, isSessionId, createSession, tokenLifetimeSeconds, loadSession, sessionProblem, touchSession }
