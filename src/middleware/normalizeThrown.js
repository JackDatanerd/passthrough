// Safety net for anything thrown that is not an Error — above all supabase-js's
// `{ error }` objects, which ~270 controller sites `throw` as they are.
//
// Hono's compose() only hands `instanceof Error` throws to app.onError; any other
// value is re-thrown out of app.fetch, so the Worker answered Cloudflare's own
// 500 page: no JSON, no CORS or security headers, errorHandler's 23505 -> 409
// mapping and its log line never ran. Mounted INNERMOST (just before the routes,
// see index.js) so the real Error it throws is handled by onError at this layer
// and the outer middleware (CORS, security headers) still unwinds normally.

const { toError } = require('../lib/db')

async function normalizeThrown(c, next) {
  try {
    await next()
  } catch (err) {
    throw toError(err)
  }
}

module.exports = normalizeThrown
