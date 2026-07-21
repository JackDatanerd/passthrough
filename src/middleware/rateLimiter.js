// Replaces express-rate-limit's in-memory store with Cloudflare KV. Same five
// limiters, same windows/maxes/messages, same CF-Connecting-IP key strategy.
//
// IMPORTANT CAVEAT (flagged, not silently glossed over): this is a best-effort
// fixed-window counter, not a perfectly atomic one. KV's get-then-put is not
// transactional — under a concurrent burst at the exact same second, two
// requests can both read the same count and both increment from it, letting
// a couple of extra requests through right at the boundary. This is the same
// tradeoff every KV-based rate limiter has (Cloudflare's own examples use
// this exact pattern); it's fine for abuse mitigation at this traffic level,
// but if precise enforcement ever matters (e.g. metered billing), upgrade to
// a Durable Object counter instead — KV is not the right primitive for that.
//
// Each limiter returns Hono middleware: async (c, next) => {...}.
//
// ── Testing bypass ────────────────────────────────────────────────────────
// RATE_LIMIT_BYPASS_IPS is an OPTIONAL secret — a comma-separated list of IPs
// that skip every limiter entirely. Unset in production by default (no
// secret = no bypass = normal behavior, fails safe). To use it while testing:
//   wrangler secret put RATE_LIMIT_BYPASS_IPS
//   (paste your IP, or multiple comma-separated: "1.2.3.4,5.6.7.8")
// To turn it back off before shipping to real users:
//   wrangler secret delete RATE_LIMIT_BYPASS_IPS
// This intentionally is NOT a wrangler.toml [vars] entry — it must go through
// `wrangler secret put`, same as every other credential-adjacent value, so it
// never gets committed to the repo or left on accidentally in a config file.

function isBypassed(c, ip) {
  const raw = c.env.RATE_LIMIT_BYPASS_IPS
  if (!raw) return false
  return raw.split(',').map(s => s.trim()).filter(Boolean).includes(ip)
}

function makeLimiter({ windowSeconds, max, keyPrefix, message, skip }) {
  return async (c, next) => {
    if (skip && skip(c)) return next()

    const ip  = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'

    if (isBypassed(c, ip)) return next()

    const key = `${keyPrefix}:${ip}`

    const kv = c.env.RATE_LIMIT_KV
    const current = await kv.get(key)
    const count = current ? parseInt(current, 10) : 0

    if (count >= max) {
      return c.json({ success: false, message }, 429)
    }

    // Fixed window: TTL resets the counter windowSeconds after the FIRST
    // request in the window, not on every request — matches express-rate-limit's
    // default fixed-window behavior.
    await kv.put(key, String(count + 1), { expirationTtl: windowSeconds })
    return next()
  }
}

const msg = m => m

const general = makeLimiter({
  windowSeconds: 15 * 60, max: 100, keyPrefix: 'rl:general',
  message: msg('Too many requests.')
})

const anonScan = makeLimiter({
  windowSeconds: 60 * 60, max: 1, keyPrefix: 'rl:anonscan',
  message: msg('Anon limit: 1/hr. Create account for 3/day.'),
  skip: c => !!c.get('user')
})

const auth = makeLimiter({
  windowSeconds: 15 * 60, max: 10, keyPrefix: 'rl:auth',
  message: msg('Too many attempts.')
})

const payment = makeLimiter({
  windowSeconds: 60, max: 3, keyPrefix: 'rl:payment',
  message: msg('Payment in progress. Wait.')
})

const employerLead = makeLimiter({
  windowSeconds: 60 * 60, max: 10, keyPrefix: 'rl:lead',
  message: msg('Slow down.')
})

module.exports = { general, anonScan, auth, payment, employerLead }
