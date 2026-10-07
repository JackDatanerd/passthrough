// App-wide CORS, mounted right after securityHeaders and BEFORE envCheck and
// bodyLimit — those two can answer early (503 broken config, 413 oversized
// body), and an early answer without CORS headers reaches the browser as an
// opaque network error instead of the JSON message the SPA knows how to show.
//
// Allowed origins: FRONTEND_URL plus an optional comma-separated
// CORS_EXTRA_ORIGINS (the www variant, a staging site, a Pages preview).
// Trailing slashes are stripped — "https://x.dev/" would otherwise silently
// match nothing — and a missing FRONTEND_URL now means "no origin allowed"
// instead of an exception on every request.
const { cors } = require('hono/cors')

// A cross-origin response hides every header outside the CORS-safelisted set
// unless it is listed here (API and site are different origins in production):
//  - X-Export-Parts:      how many parts the account's data export has
//  - X-Export-Cursor:     where the next part of that export starts (keyset paging; survives deletions)
//  - Retry-After:         sent on every 429/503; the SPA's one automatic retry and
//                         its "wait N seconds" copy key off it
//  - Content-Disposition: the server's chosen filename for downloads
//  - X-Export-Truncated / X-Export-Rows: the employer-leads CSV says whether it hit its row cap
const EXPOSED_HEADERS = ['X-Export-Parts', 'Retry-After', 'Content-Disposition', 'X-Export-Truncated', 'X-Export-Rows', 'X-Export-Cursor']

// Browsers cap this themselves (Chrome 2h, Firefox 24h). Without it every
// credentialed API call re-sent a preflight on top of itself.
const PREFLIGHT_MAX_AGE_SECONDS = 86400

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function allowedOrigins(env) {
  const list = [env && env.FRONTEND_URL, ...String((env && env.CORS_EXTRA_ORIGINS) || '').split(',')]
  return list.map(normalizeOrigin).filter(Boolean)
}

module.exports = async function corsMiddleware(c, next) {
  const allowed = allowedOrigins(c.env)
  return cors({
    origin: origin => (allowed.includes(origin) ? origin : ''),
    credentials: true,
    exposeHeaders: EXPOSED_HEADERS,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  })(c, next)
}
module.exports.EXPOSED_HEADERS = EXPOSED_HEADERS
module.exports.PREFLIGHT_MAX_AGE_SECONDS = PREFLIGHT_MAX_AGE_SECONDS
module.exports.allowedOrigins = allowedOrigins
module.exports.normalizeOrigin = normalizeOrigin
