// Gates a route to users with role === 'ADMIN'. Does NOT verify the token
// itself — optionalAuth already runs app-wide (see index.js) and populates
// c.get('user') whenever a valid Bearer token is present, so this only adds
// the role check on top rather than duplicating auth.js's JWT verification.
//
// To make an existing account an admin: update its role in the `users`
// table directly (role_enum already has 'ADMIN' — see supabase/migrations/
// 0001_init.sql) — there's no self-serve promotion endpoint, intentionally.

const { clientIp, parseIpAllowList, ipAllowed } = require('../lib/clientIp')
const jwtLib = require('../lib/jwt')

// OPTIONAL network allowlist (GAP CLOSED, cross-cutting infra round 1, G5). `ADMIN_ALLOWED_IPS` is a
// comma-separated list of IPs and/or CIDR ranges (round 4, G1: "203.0.113.0/24", "2001:db8:abcd::/48");
// when it is set, an ADMIN session is honoured only from those addresses (a bare IPv6 address means its
// /64, like every other per-IP bucket here). A stolen admin token is then useless from anywhere else.
// Unset = no restriction, so enabling it is a deliberate act: set it, and remember it applies to every
// /api/admin route and every admin-gated route elsewhere (payments refunds, partners, employer leads).
function adminIpAllowed(env, ip) {
  const raw = env && env.ADMIN_ALLOWED_IPS
  if (!raw || !String(raw).trim()) return true
  if (!String(raw).split(',').some(x => x.trim())) return true
  // Only real addresses / ranges can match: a typo in the list is ignored (env.js warns about it at start-up).
  return ipAllowed(ip, parseIpAllowList(raw).valid)
}

// Admin sessions are capped in AGE, not just idle time (round 4, G1). A normal session lives 30 days and the
// SPA silently renews its token, so a stolen admin token used to stay good for a month behind refunds, payout
// records and bans. `ADMIN_SESSION_MAX_HOURS` (default 24; 0 disables) is measured from the SESSION's creation,
// so renewal cannot extend it; an admin simply signs in again. Tokens without a session id (issued before
// migration 0047) carry no creation time and are not capped.
const DEFAULT_ADMIN_SESSION_MAX_HOURS = 24
function adminSessionTooOld(c, now = Date.now()) {
  const raw = c.env && c.env.ADMIN_SESSION_MAX_HOURS
  const hours = raw === undefined || raw === '' ? DEFAULT_ADMIN_SESSION_MAX_HOURS : Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return false
  const created = c.get('sessionCreatedAtMs')
  if (!Number.isFinite(created)) return false
  return now - created > hours * 3600 * 1000
}

// ── Step-up for the money / ban actions (round 4, G1) ───────────────────────────────────────────────
// `ADMIN_STEP_UP_MINUTES` (default 0 = off): when > 0, routes wrapped in `stepUp` also need an elevation
// token — POST /api/admin/elevate with the admin's own password mints one (signed with JWT_SECRET, bound to
// this user and this session, valid for that many minutes) and the SPA sends it as `X-Admin-Elevation`. A
// stolen bearer token alone can then read, but cannot refund, record a payout or ban.
const ELEVATION_PURPOSE = 'admin-elevation'
function stepUpMinutes(env) {
  const n = Number(env && env.ADMIN_STEP_UP_MINUTES)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 240) : 0
}
async function mintElevation(env, user, sessionId) {
  const mins = stepUpMinutes(env)
  if (!mins) return null
  return { token: await jwtLib.sign({ userId: user.id, sid: sessionId || null, purpose: ELEVATION_PURPOSE }, env.JWT_SECRET, mins * 60), expiresInSeconds: mins * 60 }
}
async function stepUp(c, next) {
  if (!stepUpMinutes(c.env)) return next()
  const user = c.get('user')
  const presented = c.req.header('X-Admin-Elevation')
  if (user && presented) {
    try {
      const d = await jwtLib.verify(presented, c.env.JWT_SECRET)
      if (d.purpose === ELEVATION_PURPOSE && d.userId === user.id && (d.sid || null) === (c.get('sessionId') || null)) return next()
    } catch { /* fall through to the refusal */ }
  }
  return c.json({ success: false, message: 'Confirm your password to continue.', code: 'ADMIN_STEP_UP_REQUIRED' }, 403)
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
    return c.json({ success: false, message: 'Admin access required', code: 'ADMIN_REQUIRED' }, 403)
  if (!adminIpAllowed(c.env, clientIp(c))) {
    console.error(`adminOnly: admin ${user.id} refused from a network outside ADMIN_ALLOWED_IPS`)
    return c.json({ success: false, message: 'Admin access is not allowed from this network.', code: 'ADMIN_NETWORK_DENIED' }, 403)
  }
  if (adminSessionTooOld(c)) {
    return c.json({ success: false, message: 'Admin sessions last a limited time — please sign in again.', code: 'ADMIN_SESSION_EXPIRED' }, 401)
  }
  await next()
}

module.exports = adminOnly
module.exports.adminSessionTooOld = adminSessionTooOld
module.exports.stepUp = stepUp
module.exports.mintElevation = mintElevation
module.exports.stepUpMinutes = stepUpMinutes
module.exports.adminIpAllowed = adminIpAllowed
