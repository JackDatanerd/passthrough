// Experts Phase 1: per-ACCOUNT rate limits for the human order routes (built on the primitives rateLimiter.js already exports, so
// that file stays untouched). Same backend, same bypass list, same fail-open rule as middleware/humanDemandLimits.js.
const rl = require('./rateLimiter')

function limiter({ windowSeconds, max, keyPrefix, message, keyOf }) {
  return async (c, next) => {
    const ip = rl.clientIp(c)
    if (rl.isBypassed(c.env, ip)) return next()
    const who = keyOf ? keyOf(c) : null
    const key = `${keyPrefix}:${who ? String(who) : rl.rateKeyIp(ip, 64)}`
    let slot
    try { slot = await rl.runOp(c.env, 'consume', { key, windowSeconds, max }) }
    catch (err) { console.error(`rate limiter (${keyPrefix}) backend error  failing open:`, err.message); return next() }
    if (!slot.allowed) return c.json({ success: false, message }, 429, { 'Retry-After': String(slot.retryAfter) })
    return next()
  }
}
const userKey = c => { const u = c.get && c.get('user'); return u && u.id ? `u:${u.id}` : null }

// Starting an order creates a payment row and calls Paystack: tight, like /api/payments/initialize.
const order = limiter({ windowSeconds: 60, max: 3, keyPrefix: 'rl:horder', message: 'Too many attempts. Please wait a minute and try again.', keyOf: userKey })
// Everything else a customer does on an order (read, answer, accept, rate, upload).
const act = limiter({ windowSeconds: 10 * 60, max: 60, keyPrefix: 'rl:hact', message: 'Too many requests. Please wait a few minutes.', keyOf: userKey })
const upload = limiter({ windowSeconds: 60 * 60, max: 12, keyPrefix: 'rl:hup', message: 'Too many uploads. Please wait a while and try again.', keyOf: userKey })
// Expert sign-in: per IP, tight (the second factor is only a 6-digit code).
const expertLogin = limiter({ windowSeconds: 15 * 60, max: 10, keyPrefix: 'rl:hexlogin', message: 'Too many sign-in attempts. Please wait and try again.' })
const expertAct = limiter({ windowSeconds: 10 * 60, max: 600, keyPrefix: 'rl:hexact', message: 'Too many requests. Please wait a few minutes.', keyOf: c => { const e = c.get && c.get('expert'); return e && e.id ? `e:${e.id}` : null } })

module.exports = { order, act, upload, expertLogin, expertAct, limiter }
