// BUG FIX (traced out of Section 6's audit of profile.controller.js, but
// cross-cutting): no route anywhere validated that a client-supplied :id
// route param was a well-formed UUID before handing it straight to
// `.eq('id', ...)`. For a table with a `uuid` column, Postgres rejects a
// malformed value with an "invalid input syntax for type uuid" error
// (code 22P02) — supabase-js surfaces that as `{ error }`, not a thrown
// exception, so it flows into the controller's own `if (error) throw error`
// and lands in errorHandler.js's generic branch: an uncaught 500 instead of
// a clean 400, for something as mundane as a typo'd or truncated URL.
//
// It started out scoped to the scan routes that motivated it; it is now the
// shared guard for any route with a `:id` uuid param (scan, admin and
// employer-lead routes all use it).
// profile.controller.js's own scanId (a JSON body field, not a route param)
// is validated inline in saveProfile instead, since this middleware only
// speaks to route params.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateUuidParam(paramName = 'id') {
  return async function (c, next) {
    const value = c.req.param(paramName)
    if (!UUID_RE.test(value))
      return c.json({ success: false, message: 'Invalid ID.' }, 400)
    await next()
  }
}

module.exports = validateUuidParam
module.exports.UUID_RE = UUID_RE
