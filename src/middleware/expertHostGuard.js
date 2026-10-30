// Experts Phase 2A (AUDIT A2, G1): the expert site's host serves ONLY the expert realm.
// The deployment routes experts.usepassthrough.com/api/* to this Worker, which put the whole main API (admin, auth, payments, the Paystack
// webhook, the Phase 1 expert routes) on that host too. The realm already refused every other host; this is the same wall from the other
// side. With EXPERT_SITE_URL set, a request on that host gets the ordinary 404 unless its path is under /api/expert-realm or /api/expert-admin.
// Unset (every deployment before 2A, and the flag-off snapshot): nothing here does anything. Independent of EXPERT_REALM_ENABLED on purpose:
// the host is closed to the main app as soon as the route exists, whether or not the realm is switched on.
const cfg = require('../lib/expertRealm/config')

const ALLOWED_PREFIXES = ['/api/expert-realm', '/api/expert-admin']
const underPrefix = (path, p) => path === p || path.startsWith(p + '/')

function expertHostGuard(c, next) {
  const host = cfg.siteHost(c.env)
  if (!host) return next()
  let reqHost = '', path = ''
  try { const u = new URL(c.req.url); reqHost = u.host.toLowerCase(); path = u.pathname } catch (_) { return next() }
  if (reqHost !== host.toLowerCase()) return next()
  if (c.req.method === 'OPTIONS') return next()      // CORS preflight is answered upstream and carries no data
  if (ALLOWED_PREFIXES.some(p => underPrefix(path, p))) return next()
  return c.notFound()
}
module.exports = expertHostGuard
module.exports.ALLOWED_PREFIXES = ALLOWED_PREFIXES
