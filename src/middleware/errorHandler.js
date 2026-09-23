// Replaces Express's 4-arg error middleware with Hono's app.onError(err, c)
// handler, registered once in src/index.js. Upload-specific failures (413/415)
// are returned directly by middleware/upload.js rather than thrown. Zod
// validation errors map to a 400 with a per-field list.
//
// Postgres unique-constraint violations arrive as SQLSTATE '23505'
// (unique_violation) via PostgREST, surfaced on error.code by supabase-js.

const validStatus = s => Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500

function errorHandler(err, ctx) {
  if (err.name === 'ZodError')
    return ctx.json({ success: false, message: 'Validation failed',
      errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })) }, 400)

  // Postgres unique_violation — replaces Prisma's P2002
  if (err.code === '23505')
    return ctx.json({ success: false, message: 'Already exists.' }, 409)

  // Hono's own HTTPException (thrown by its built-in helpers/validators) knows
  // how to render itself with the right status and headers.
  if (typeof err.getResponse === 'function') return err.getResponse()

  // A request body that isn't valid JSON: every controller does
  // `await c.req.json()`, which throws a bare SyntaxError on an empty or
  // malformed body. That is the CLIENT's mistake — 400 — not a server fault to
  // page someone about with a stack trace.
  if (err instanceof SyntaxError && /JSON/i.test(err.message || ''))
    return ctx.json({ success: false, message: 'Invalid request body.' }, 400)

  const status = validStatus(err.status)

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
