// Replaces Express's 4-arg error middleware with Hono's app.onError(err, c)
// handler, registered once in src/index.js. Upload-specific failures (413/415)
// are returned directly by middleware/upload.js rather than thrown. Zod
// validation errors map to a 400 with a per-field list.
//
// Postgres unique-constraint violations arrive as SQLSTATE '23505'
// (unique_violation) via PostgREST, surfaced on error.code by supabase-js.

const { redactPgDetails } = require('../lib/redact')

const validStatus = s => Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500

// A failure of OUR OWN infrastructure that is over in moments — the database did not answer in time or
// dropped the connection, a transaction lost a deadlock/serialization race, PostgREST or its pool was
// momentarily unavailable, the rate-limiter Durable Object timed out. These used to surface as a bare 500
// "An error occurred.", which the SPA never retries; a 503 with Retry-After is what its one automatic
// retry for idempotent GETs (frontend/src/lib/errors.js shouldRetryRequest) and its "try again" copy key
// off. Matched on Postgres/PostgREST codes (kept by lib/db.js toError) and on the runtime's own wording for
// an aborted or dropped fetch (supabase-js folds `${err.name}: ${err.message}` into the message).
const TRANSIENT_DB_CODES = new Set([
  '40001', '40P01',                       // serialization failure, deadlock detected
  '55P03', '57014', '57P01', '57P03',     // lock not available, statement timeout/cancelled, admin shutdown, starting up
  '53300', '53400',                       // too many connections, configuration limit exceeded
  '08000', '08001', '08003', '08004', '08006',   // connection exceptions
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', // PostgREST: cannot connect, schema cache loading, pool timeout
])
const TRANSIENT_MESSAGE = /\b(?:TimeoutError|AbortError)\b|aborted due to timeout|operation was aborted|fetch failed|network connection lost|connection (?:reset|closed|refused)|ECONNRESET|ETIMEDOUT|rate limiter DO/i
const TRANSIENT_RETRY_AFTER_SECONDS = 5

function isTransientFailure(err) {
  if (err.expose === true) return false   // a deliberate, caller-chosen answer
  if (typeof err.code === 'string' && TRANSIENT_DB_CODES.has(err.code)) return true
  return TRANSIENT_MESSAGE.test(String(err.message || ''))
}

function errorHandler(err, ctx) {
  // Anything can be thrown (a string, null) — never let the handler itself crash on it.
  if (!err || typeof err !== 'object') err = new Error(String(err ?? 'Unknown error'))

  if (err.name === 'ZodError')
    return ctx.json({ success: false, message: 'Validation failed',
      errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })) }, 400)

  // Postgres unique_violation — replaces Prisma's P2002.
  // Logged, not just answered: a unique violation raised by INTERNAL code (a bookkeeping insert, a
  // dedupe index) is indistinguishable here from one a user caused, and used to leave no trace at
  // all — a bug reported to the client as a polite 409 and never seen in the logs.
  if (err.code === '23505') {
    const rayId = ctx.req && typeof ctx.req.header === 'function' ? ctx.req.header('cf-ray') : undefined
    console.error(`Unique violation answered 409${rayId ? ` [${rayId}]` : ''}:`, redactPgDetails(err.message), redactPgDetails(err.details))
    return ctx.json({ success: false, message: 'Already exists.' }, 409)
  }

  // Hono's own HTTPException (thrown by its built-in helpers/validators) knows
  // how to render itself with the right status and headers.
  if (typeof err.getResponse === 'function') return err.getResponse()

  // A request body that isn't valid JSON: bodyLimit.js wraps c.req.json() and tags the
  // SyntaxError it throws on an empty or malformed body. That is the CLIENT's mistake — 400.
  // Only the tag counts: an untagged SyntaxError (an internal JSON.parse of a Claude or
  // Paystack reply, a bad migration) is a server fault, and used to be misreported as a 400
  // the caller caused — and never logged.
  if (err instanceof SyntaxError && err.clientBody === true)
    return ctx.json({ success: false, message: 'Invalid request body.' }, 400)

  // Transient infrastructure failure -> 503 + Retry-After (see isTransientFailure). Still logged in full.
  if (isTransientFailure(err)) {
    const rayId = ctx.req && typeof ctx.req.header === 'function' ? ctx.req.header('cf-ray') : undefined
    console.error(`Transient failure answered 503${rayId ? ` [${rayId}]` : ''}:`, err.stack || err.message)
    return ctx.json({ success: false, message: 'Temporarily unavailable. Please try again in a moment.' }, 503,
      { 'Retry-After': String(TRANSIENT_RETRY_AFTER_SECONDS) })
  }

  // Only an error that opts in with `expose` chooses its own status. Any other `err.status` is
  // somebody else's: an upstream HTTP status copied onto a thrown error (Resend answered 401,
  // Anthropic 429) must never become OUR response status — a 401 here reads to the SPA as an
  // expired session and signs the user out over a server-side API-key problem.
  const status = err.expose === true ? validStatus(err.status) : 500

  // The stack is the one thing on `err` that points at where a production
  // incident happened (`wrangler tail` is where it gets root-caused). The
  // cf-ray id ties the log line to the exact failing request.
  const ray = ctx.req && typeof ctx.req.header === 'function' ? ctx.req.header('cf-ray') : undefined
  console.error(`Unhandled error${ray ? ` [${ray}]` : ''}:`, err.stack || err.message)

  // Errors that opt in with `expose` (a deliberate, user-safe message on a 4xx
  // — e.g. "payload too large") are always shown as-is; everything else is masked so internals
  // never leak. The default is MASKED: raw messages (relation names, SQL, upstream bodies) are
  // only shown when NODE_ENV is explicitly 'development' or 'test'. It used to be the reverse
  // (masked only when NODE_ENV === 'production'), so a second deploy target, a preview or a fork
  // that simply lacked the variable leaked internals to every client.
  const env = (ctx && ctx.env) || {}
  const showMessage = env.NODE_ENV === 'development' || env.NODE_ENV === 'test' || (err.expose === true && status < 500)
  return ctx.json({ success: false, message: showMessage ? err.message : 'An error occurred.' }, status)
}

module.exports = errorHandler
module.exports.isTransientFailure = isTransientFailure
