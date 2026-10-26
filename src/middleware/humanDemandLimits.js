// Per-IP rate limits for the Human rewrite demand test routes. Built from the limiter primitives middleware/rateLimiter.js already
// exports (runOp, clientIp, rateKeyIp, isBypassed), so that file stays untouched: same backend (Durable Object, or KV in dev), same
// bypass list, same fail-open rule (a limiter outage must not become an outage of the offer card).

const rl = require('./rateLimiter')

function limiter({ windowSeconds, max, keyPrefix, message }) {
  return async (c, next) => {
    const ip = rl.clientIp(c)
    if (rl.isBypassed(c.env, ip)) return next()
    const key = `${keyPrefix}:${rl.rateKeyIp(ip, 64)}`
    let slot
    try {
      slot = await rl.runOp(c.env, 'consume', { key, windowSeconds, max })
    } catch (err) {
      console.error(`rate limiter (${keyPrefix}) backend error — failing open:`, err.message)
      return next()
    }
    if (!slot.allowed) return c.json({ success: false, message }, 429, { 'Retry-After': String(slot.retryAfter) })
    return next()
  }
}

// Reading the config: once per tab session in practice (the SPA caches the answer).
const config = limiter({ windowSeconds: 10 * 60, max: 60, keyPrefix: 'rl:hdconfig', message: 'Too many requests. Please wait a few minutes.' })
// Funnel events: a few per visit (shown, click, tier, toggles, dismiss). Sized for a shared office or campus address.
const events = limiter({ windowSeconds: 60 * 60, max: 120, keyPrefix: 'rl:hdevent', message: 'Slow down.' })
// Joining the waitlist: a person does this once or twice.
const waitlist = limiter({ windowSeconds: 60 * 60, max: 10, keyPrefix: 'rl:hdwaitlist', message: 'Too many attempts. Please wait a while and try again.' })

module.exports = { config, events, waitlist, limiter }
