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

// Takes `env` directly (not the full Hono context) so this can be reused
// anywhere a bypass check is needed — not just inside rate-limiter
// middleware. Currently also used by createScan's daily-scan-quota check in
// scan.controller.js, which is a separate DB-tracked limit, not a KV one,
// but conceptually the same "skip this during testing" toggle.
function isBypassed(env, ip) {
  const raw = env.RATE_LIMIT_BYPASS_IPS
  if (!raw) return false
  return raw.split(',').map(s => s.trim()).filter(Boolean).includes(ip)
}

function makeLimiter({ windowSeconds, max, keyPrefix, message, skip }) {
  return async (c, next) => {
    if (skip && skip(c)) return next()

    const ip  = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'

    if (isBypassed(c.env, ip)) return next()

    const key = `${keyPrefix}:${ip}`
    const kv  = c.env.RATE_LIMIT_KV
    const now = Date.now()

    const raw = await kv.get(key)
    let count = 0
    let windowStart = now
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed.count === 'number' && typeof parsed.windowStart === 'number') {
          count = parsed.count
          windowStart = parsed.windowStart
        }
      } catch (_) {
        // Pre-fix value (plain integer string) or corrupt data — treat as
        // the start of a fresh window rather than throwing.
      }
    }

    // Belt-and-suspenders against the 60s KV TTL floor below: if the window
    // has actually elapsed already, start a new one here regardless of
    // whether the key technically still exists in KV.
    const elapsedSeconds = (now - windowStart) / 1000
    if (elapsedSeconds >= windowSeconds) {
      count = 0
      windowStart = now
    }

    if (count >= max) {
      return c.json({ success: false, message }, 429)
    }

    // FIX: true fixed window. windowStart is set once, on the first request
    // of the window, and never moves after that — every subsequent request
    // just increments count and re-derives the REMAINING ttl from that
    // original windowStart, instead of resetting the clock.
    //
    // The previous version called `kv.put(key, ..., { expirationTtl:
    // windowSeconds })` on every request, which means every request reset
    // the key's expiry to windowSeconds from *that moment*. A client making
    // requests faster than windowSeconds apart (e.g. this app's own 2.5s
    // status-polling loop while a fix is generating) kept renewing the key
    // forever — the counter never dropped back to 0 as long as traffic kept
    // coming, so an active-but-under-the-cap client would eventually
    // ratchet all the way up to max and then stay locked out until a full
    // windowSeconds of total silence, instead of getting a fresh budget
    // every window like a real fixed window is supposed to give it.
    //
    // Cloudflare KV requires expirationTtl >= 60s, so it's floored there.
    // That can only ever extend a key's life by at most ~59s past its
    // logical expiry (for a request landing in the final minute of a
    // window) — the elapsedSeconds check above, not this floor, is what
    // actually guarantees correctness in that case.
    const remainingTtl = Math.max(Math.ceil(windowSeconds - elapsedSeconds), 60)
    await kv.put(key, JSON.stringify({ count: count + 1, windowStart }), { expirationTtl: remainingTtl })
    return next()
  }
}

const msg = m => m

const general = makeLimiter({
  windowSeconds: 15 * 60, max: 100, keyPrefix: 'rl:general',
  message: msg('Too many requests.'),
  // /api/webhooks/* gets its own limiter (see `webhook` below) instead of
  // sharing this generic per-IP bucket. Paystack's webhook deliveries all
  // come from the same account, so their volume tracks real payment
  // volume — a launch-day/promo burst, or Paystack's own retry storm after
  // a transient outage, could otherwise 429 legitimate payment webhooks
  // with zero visibility (Paystack's retry logic doesn't surface a 429 to
  // anyone). The route is already protected by HMAC signature verification
  // inside the handler itself, which is a stronger gate than a generic IP
  // counter anyway.
  skip: c => c.req.path.startsWith('/api/webhooks')
})

// Dedicated webhook limiter — much higher ceiling than `general` since this
// route's real protection is the HMAC signature check inside the handler,
// not this counter. This exists purely as a backstop against a genuine
// flood (not normal retry/burst traffic), still keyed by IP.
const webhook = makeLimiter({
  windowSeconds: 5 * 60, max: 300, keyPrefix: 'rl:webhook',
  message: msg('Too many requests.')
})

const anonScan = makeLimiter({
  windowSeconds: 60 * 60, max: 1, keyPrefix: 'rl:anonscan',
  message: msg('Anon limit: 1/hr. Create account for 3/day.'),
  skip: c => !!c.get('user')
})

// HARDENING: previously every auth-adjacent endpoint (register, login,
// forgot-password, reset-password, verify-email, resend-verification,
// change-password, delete-account) shared this ONE 10-per-15-min bucket per
// IP. A normal signup flow — register, open the verification email, click
// the link, maybe hit resend once, then log in again later — could burn
// half that budget on its own, and anyone behind a shared/NAT'd IP (office,
// campus, mobile carrier) compounds it further into false lockouts for
// unrelated users. Split into two buckets:
//   - `auth`: credential-guessing surface (register, login, forgot-password,
//     reset-password, change-password, delete-account) — stays tight, this
//     is exactly what rate limiting here is for.
//   - `authVerify`: link-click / resend flows (verify-email,
//     resend-verification) — same window, more headroom, since these aren't
//     a credential-guessing vector and legitimately get triggered multiple
//     times in a single signup.
const auth = makeLimiter({
  windowSeconds: 15 * 60, max: 10, keyPrefix: 'rl:auth',
  message: msg('Too many attempts.')
})

const authVerify = makeLimiter({
  windowSeconds: 15 * 60, max: 20, keyPrefix: 'rl:authverify',
  message: msg('Too many attempts. Please wait a few minutes.')
})

const payment = makeLimiter({
  windowSeconds: 60, max: 3, keyPrefix: 'rl:payment',
  message: msg('Payment in progress. Wait.')
})

const employerLead = makeLimiter({
  windowSeconds: 60 * 60, max: 10, keyPrefix: 'rl:lead',
  message: msg('Slow down.')
})

module.exports = { general, anonScan, auth, authVerify, payment, employerLead, webhook, isBypassed }
