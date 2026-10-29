// Experts Phase 2A: the expert realm's request pipeline. Order on every realm route: gate (flag + host) -> csrf -> session (cookie only) ->
// permission (matrix, step-up, reason). Nothing here reads an Authorization header: a bearer token of ANY kind (main user, main admin, Phase 1
// expert) is simply never looked at, and the realm cookie is never looked at by the main app, whose auth reads only Authorization.
const { getSupabase } = require('../config/supabase')
const rl = require('./rateLimiter')
const cfg = require('../lib/expertRealm/config')
const sessions = require('../services/expertSession.service')
const { can } = require('../lib/expertRealm/permissions')
const { audit } = require('../services/expertAudit.service')

const fail = (c, status, message, code, headers) => c.json({ success: false, message, ...(code ? { code } : {}) }, status, headers)

// 1. Flag off, wrong host or no usable secret: the ordinary 404, so a probe learns nothing. (Flag on but misconfigured: 404 too, plus a log line.)
function gate() {
  return async (c, next) => {
    if (!cfg.realmEnabled(c.env)) return c.notFound()
    const host = cfg.siteHost(c.env), secret = cfg.secretOf(c.env)
    if (!host || !secret) { console.error('[CRITICAL] expert realm is on but EXPERT_SITE_URL or EXPERT_REALM_SECRET is missing, short, or equal to another secret: realm refused'); return c.notFound() }
    const reqHost = (c.req.header('host') || new URL(c.req.url).host || '').toLowerCase()
    if (reqHost !== host.toLowerCase()) return c.notFound()      // the realm is reachable ONLY through the expert site's own host
    return next()
  }
}

// 2. State-changing requests must come from the expert site itself (SameSite=Strict already stops cross-site sends; this is the second lock).
function csrf() {
  return async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    if (c.req.header('origin') !== cfg.siteOrigin(c.env)) return fail(c, 403, 'Request not allowed.', 'BAD_ORIGIN')
    return next()
  }
}

// 3. The session. stage: 'public' (none needed), 'pending' (password checked only), 'full' (second factor verified).
function session(stage) {
  return async (c, next) => {
    if (stage === 'public') return next()
    const supabase = getSupabase(c.env)
    const r = await sessions.resolve(c.env, supabase, sessions.readCookie(c.req.header('cookie')))
    const clear = { 'Set-Cookie': sessions.clearCookieHeader() }
    if (r.error) return fail(c, 401, 'Please sign in again.', 'AUTH', r.error === 'NO_SESSION' ? undefined : clear)
    if (r.stage !== stage) return fail(c, 401, stage === 'full' ? 'Finish signing in first.' : 'Not available.', stage === 'full' ? 'MFA_REQUIRED' : 'AUTH')
    c.set('xr', { account: r.account, session: r.session, roles: r.account.roles || [] })
    return next()
  }
}

// 4. The matrix. A denied attempt is itself audited (without any request content).
function requireAction(action) {
  return async (c, next) => {
    const xr = c.get('xr'); const g = can(xr.roles, action)
    if (!g.allowed) {
      await audit(getSupabase(c.env), { actorId: xr.account.id, roles: xr.roles, action: 'realm.denied', targetType: 'route', targetId: action, detail: { method: c.req.method } })
      return fail(c, 403, 'Not allowed.', 'FORBIDDEN')
    }
    if (g.stepUp && !sessions.isElevated(xr.session)) return fail(c, 403, 'Confirm your password to continue.', 'STEP_UP_REQUIRED')
    c.set('grant', g)
    if (g.reason) {
      let body = {}; try { body = await c.req.json() } catch (_) { body = {} }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (reason.length < 5 || reason.length > 300) return fail(c, 400, 'A reason (5 to 300 characters) is required.', 'REASON_REQUIRED')
      c.set('reason', reason)
    }
    return next()
  }
}

// A fresh password check within the last few minutes (the session's elevated_until). For account actions that are not in the matrix.
function requireElevated() {
  return async (c, next) => (sessions.isElevated(c.get('xr').session) ? next() : fail(c, 403, 'Confirm your password to continue.', 'STEP_UP_REQUIRED'))
}

// Rate limits (the same primitives every other limiter here uses; fails open like them if the backend errors).
function limit({ windowSeconds, max, keyPrefix, keyOf, message = 'Too many attempts. Please wait and try again.' }) {
  return async (c, next) => {
    const ip = rl.clientIp(c)
    if (rl.isBypassed(c.env, ip)) return next()
    const who = keyOf ? keyOf(c) : null
    const key = `${keyPrefix}:${who ? String(who) : rl.rateKeyIp(ip, 64)}`
    let slot
    try { slot = await rl.runOp(c.env, 'consume', { key, windowSeconds, max }) }
    catch (err) { console.error(`rate limiter (${keyPrefix}) backend error  failing open:`, err.message); return next() }
    if (!slot.allowed) return fail(c, 429, message, 'RATE_LIMITED', { 'Retry-After': String(slot.retryAfter) })
    return next()
  }
}
const limits = {
  loginIp:   limit({ windowSeconds: 15 * 60, max: 20, keyPrefix: 'rl:xr:login' }),
  secondFactor: limit({ windowSeconds: 10 * 60, max: 10, keyPrefix: 'rl:xr:mfa', keyOf: c => { const x = c.get('xr'); return x ? `s:${x.session.id}` : null } }),
  resetIp:   limit({ windowSeconds: 60 * 60, max: 6, keyPrefix: 'rl:xr:reset' }),
  admin:     limit({ windowSeconds: 60, max: 120, keyPrefix: 'rl:xr:adm', keyOf: c => { const x = c.get('xr'); return x ? `a:${x.account.id}` : null }, message: 'Too many requests. Please wait a moment.' }),
  money:     limit({ windowSeconds: 60 * 60, max: 10, keyPrefix: 'rl:xr:money', keyOf: c => { const x = c.get('xr'); return x ? `a:${x.account.id}` : null }, message: 'Too many refund attempts. Please wait.' }),
}

module.exports = { gate, csrf, session, requireAction, requireElevated, limits, fail }
