// The one place that decides (a) which users columns an authenticated request
// loads and (b) which fields are safe to attach to the request as c.get('user').
//
// AUDIT FIX (Auth section round 1): middleware/auth.js and optionalAuth.js each
// did `select('*')` on EVERY authenticated request — dragging password_hash and
// the entire saved_profile resume JSON (plus every token column) out of the
// database and through the Worker, only to strip them again a line later — and
// each carried its own copy of the strip list, kept "in lockstep" by comments
// alone. The column list below is exactly the non-secret fields the request
// user exposes plus the three the checks need (deleted_at, status,
// token_version); nothing else is fetched, so a secret column can't leak by
// being forgotten in a strip list.
//
// If a new users column must be visible on the request user, add it here AND
// to userRowToCamel(); tests/authUser.test.js fails if the two drift apart.

const { userRowToCamel } = require('./mappers')
const constants = require('../config/constants')

const AUTH_USER_COLUMNS = [
  'id', 'email', 'name', 'role', 'status', 'token_version', 'email_verified',
  'pending_email', 'deleted_at', 'scans_today', 'free_fix_credits', 'scans_day_reset',
  'terms_accepted_at', 'terms_version',
  'last_login_at', 'last_login_ip', 'previous_login_at', 'previous_login_ip',
  'created_at', 'updated_at',
].join(', ')

// Camel-cased fields that must NEVER reach c.get('user') (and so never the
// client through getMe). Kept as data so the drift test can check it.
const SECRET_USER_FIELDS = [
  'passwordHash', 'paystackAuthCode', 'paystackCustomerCode',
  'resetToken', 'resetTokenExpiry', 'emailVerifyToken', 'emailVerifyExpiry',
  'pendingEmailToken', 'pendingEmailExpiry', 'savedProfile', 'lastLoginAlertAt',
]

/**
 * toRequestUser(row) -> { user, requestUser }
 *   user        — the full camel-cased row (or null/undefined) for the checks
 *   requestUser — what c.set('user', …) gets: secrets removed, termsCurrent added
 *
 * termsCurrent: null terms_version (an account created before terms were
 * recorded) counts as current — see safeUser() in auth.controller.js.
 * tokenVersion stays on requestUser for server-side use only; anything that
 * serializes the user to a client must strip it (getMe and safeUser do).
 */
function toRequestUser(row) {
  const user = userRowToCamel(row)
  if (!user) return { user, requestUser: null }
  const safe = { ...user }
  for (const k of SECRET_USER_FIELDS) delete safe[k]
  return {
    user,
    requestUser: { ...safe, termsCurrent: user.termsVersion == null || user.termsVersion === constants.TERMS_VERSION },
  }
}

module.exports = { AUTH_USER_COLUMNS, SECRET_USER_FIELDS, toRequestUser }
