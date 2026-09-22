// Baseline security headers for every API response — including 404s, 429s and
// error responses, since this wraps the whole app (see index.js).
//
// This service only ever returns JSON or an `attachment` download, never HTML
// a browser should render, so the policy can be maximally strict:
//   * nosniff       — a download can never be re-interpreted as HTML/script
//   * CSP           — default-src 'none': even if a response were rendered, it
//                     could load and run nothing; frame-ancestors 'none' blocks
//                     embedding
//   * HSTS          — the API is HTTPS-only; pin it
//   * no-store      — responses carry account data, tokens and payment state;
//                     shared caches and the browser back/forward cache must
//                     not keep them. (A handler that sets its own
//                     Cache-Control keeps it.)
async function securityHeaders(c, next) {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
}

module.exports = securityHeaders
