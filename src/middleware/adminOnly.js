// Gates a route to users with role === 'ADMIN'. Does NOT verify the token
// itself — optionalAuth already runs app-wide (see index.js) and populates
// c.get('user') whenever a valid Bearer token is present, so this only adds
// the role check on top rather than duplicating auth.js's JWT verification.
//
// To make an existing account an admin: update its role in the `users`
// table directly (role_enum already has 'ADMIN' — see supabase/migrations/
// 0001_init.sql) — there's no self-serve promotion endpoint, intentionally.

const { clientIp, rateKeyIp } = require('../lib/clientIp')

// OPTIONAL network allowlist (GAP CLOSED, cross-cutting infra round 1, G5). `ADMIN_ALLOWED_IPS` is a
// comma-separated list of IPs; when it is set, an ADMIN session is honoured only from those
// addresses (IPv6 compared by /64, like every other per-IP bucket here). A stolen admin token —
// 7-day lifetime, and behind it refunds, payout links, bans and webhook replays — is then useless
// from anywhere else. Unset = no restriction (the previous behaviour), so enabling it is a
// deliberate act: set it, and remember it applies to every /api/admin route and every admin-gated
// route elsewhere (payments refunds, partners, employer leads).
function adminIpAllowed(env, ip) {
  const raw = env && env.ADMIN_ALLOWED_IPS
  if (!raw || !String(raw).trim()) return true
  const list = String(raw).split(',').map(x => x.trim()).filter(Boolean).map(x => rateKeyIp(x))
  return list.length === 0 || list.includes(rateKeyIp(ip))
}

async function adminOnly(c, next) {
  const user = c.get('user')
  if (!user) {
    // optionalAuth records why there is no user. If OUR user lookup failed,
    // this is a server-side hiccup, not a bad session: answer 503 so the SPA
    // (which signs the user out on any 401 that carried a token) keeps the
    // admin logged in and simply retries.
    const why = c.get('authError')
    if (why === 'unavailable')
      return c.json({ success: false, message: 'Could not verify your session right now. Please try again.' }, 503)
    if (why === 'expired')
      return c.json({ success: false, message: 'Session expired.', code: 'TOKEN_EXPIRED' }, 401)
    return c.json({ success: false, message: 'Authentication required' }, 401)
  }
  if (user.role !== 'ADMIN')
    return c.json({ success: false, message: 'Admin access required' }, 403)
  if (!adminIpAllowed(c.env, clientIp(c))) {
    console.error(`adminOnly: admin ${user.id} refused from a network outside ADMIN_ALLOWED_IPS`)
    return c.json({ success: false, message: 'Admin access is not allowed from this network.' }, 403)
  }
  await next()
}

module.exports = adminOnly
module.exports.adminIpAllowed = adminIpAllowed
