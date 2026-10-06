// Replaces Express's 4-arg error middleware with Hono's app.onError(err, c)
// handler, registered once in src/index.js. Upload-specific failures (413/415)
// are returned directly by middleware/upload.js rather than thrown. Zod
// validation errors map to a 400 with a per-field list.
//
// Postgres unique-constraint violations arrive as SQLSTATE '23505'
// (unique_violation) via PostgREST, surfaced on error.code by supabase-js.

const validStatus = s => Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500

function errorHandler(err, ctx) {
  // Anything can be thrown (a string, null) — never let the handler itself crash on it.
  if (!err || typeof err !== 'object') err = new Error(String(err ?? 'Unknown error'))

  if (err.name === 'ZodError')
    return ctx.json({ success: false, message: 'Validation failed',
      errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })) }, 400)

  // Postgres unique_violation — replaces Prisma's P2002
  if (err.code === '23505')
    return ctx.json({ success: false, message: 'Already exists.' }, 409)

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
  // — e.g. "payload too large") are shown as-is even in production; everything
  // else is masked there so internals never leak.
  const showMessage = ctx.env.NODE_ENV !== 'production' || (err.expose === true && status < 500)
  return ctx.json({ success: false, message: showMessage ? err.message : 'An error occurred.' }, status)
}

module.exports = errorHandler
