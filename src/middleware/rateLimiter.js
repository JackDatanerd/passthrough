// Replaces express-rate-limit's in-memory store with Cloudflare KV. Same
// windows/maxes/messages, keyed per client IP.
//
// IMPORTANT CAVEAT (flagged, not silently glossed over): this is a best-effort
// fixed-window counter, not a perfectly atomic one. KV's get-then-put is not
// transactional — under a concurrent burst at the exact same second, two
// requests can both read the same count and both increment from it, letting
// a couple of extra requests through right at the boundary. It's fine for
// abuse mitigation at this traffic level, but if precise enforcement ever
// matters (e.g. metered billing), upgrade to a Durable Object counter — KV is
// not the right primitive for that.
//
// FAILS OPEN. KV is a dependency of *every* /api request through the `general`
// limiter, and it is documented to throttle writes to a single key (~1/second)
// and to return transient 5xx. A limiter whose storage error propagated used
// to turn any of those into a 500 for the whole API. A rate limiter is an
// abuse backstop, not an availability dependency: on any KV error we log and
// let the request through. (The credential-guessing surface is additionally
// protected by bcrypt cost and the account lockout below, both fail-open for
// the same reason — an outage must never become a login outage.)
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

const { clientIp, rateKeyIp } = require('../lib/clientIp')
const { isTrustedPreview } = require('../lib/verification')
const core = require('../lib/rateLimitCore')
const constants = require('../config/constants')
const { runInBackground } = require('../lib/background')

// ── Storage backend ───────────────────────────────────────────────────────
// With a RATE_LIMIT_DO binding (production) every counter lives in a Durable
// Object addressed by its key, so read-modify-write is ATOMIC (see
// lib/rateLimitCore.js for why KV could not give that). Without the binding
// (local dev, unit tests) the SAME algorithms run against RATE_LIMIT_KV — the
// old best-effort behaviour — so nothing here needs a DO to be developed.
// `op` names an entry of core.OPS; args are plain JSON.
const DO_URL = 'https://rate-limiter.internal/op'

function backendName(env) { return env && env.RATE_LIMIT_DO ? 'RATE_LIMIT_DO' : 'RATE_LIMIT_KV' }
function hasBackend(env) { return !!(env && (env.RATE_LIMIT_DO || env.RATE_LIMIT_KV)) }

async function runOp(env, op, args) {
  if (env.RATE_LIMIT_DO) {
    const ns = env.RATE_LIMIT_DO
    const stub = ns.get(ns.idFromName(args.key))
    const res = await stub.fetch(DO_URL, { method: 'POST', body: JSON.stringify({ op, args }) })
    if (!res.ok) throw new Error(`rate limiter DO ${res.status}`)
    return res.json()
  }
  return core.OPS[op](env.RATE_LIMIT_KV, args)
}

// ── Outage alerting ───────────────────────────────────────────────────────
// Every fail-open path in this file is a deliberate availability tradeoff —
// but "fail open" and "tell nobody" are two separate decisions. A sustained
// backend outage silently disables every limiter, the account lockout and the
// verify-code enumeration guard, so it emails the owner.
//
// sendOwnerAlert's own de-dupe is a hitQuota() call against this SAME backend,
// so during a real outage it fails open and would send one email per failed
// request. Throttle with plain in-process state instead (never touches the
// backend). Deliberately NOT wired into hitQuota()'s own catch block: hitQuota
// is what sendOwnerAlert calls internally, so alerting from there would
// re-enter this function on every alert attempt.
//
// Two traps this avoids:
//  * The send used to be a floating promise. Workers may cancel unawaited work
//    once the response is out, and the cooldown was armed BEFORE the send — so
//    a cancelled send muted alerts for 10 minutes. It now runs under waitUntil
//    when a request context exists, and the cooldown starts only when the send
//    has actually finished (an attempt that never finishes expires on its own).
//  * Workers KV answers a 2nd write to one key inside a second with
//    "429 Too Many Requests". That is contention, not an outage: it is logged,
//    never emailed.
let lastBackendAlertAt = 0
let alertStartedAt = 0
const BACKEND_ALERT_COOLDOWN_MS = 10 * 60 * 1000
const BACKEND_ALERT_STALE_MS = 60 * 1000

function isContention(err) {
  return /\b429\b|too many requests/i.test(String(err && err.message))
}

function alertKvOutage(env, where, err, c) {
  if (isContention(err)) return
  const now = Date.now()
  if (now - lastBackendAlertAt < BACKEND_ALERT_COOLDOWN_MS) return
  if (alertStartedAt && now - alertStartedAt < BACKEND_ALERT_STALE_MS) return
  alertStartedAt = now
  // Lazy require — email.service.js requires hitQuota from this same file,
  // so a top-level require here would be circular.
  const emailService = require('../services/email.service')
  const name = backendName(env)
  const done = Promise.resolve()
    .then(() => emailService.sendOwnerAlert(env,
      `${name} outage — rate limiting and account lockout are failing open`,
      `${where}: ${err && err.message}\n\n` +
      'Every rate limiter, the login-lockout guard, and the verify-code miss ' +
      'counter fail open on a backend error by design — right now they are all ' +
      'effectively disabled. This message is throttled in-process (not via the ' +
      'backend) so a sustained outage cannot also become an email flood; expect at ' +
      'most one of these per Worker isolate per 10 minutes while it persists.'))
    .catch(alertErr => console.error('Rate-limit outage alert failed to send:', alertErr && alertErr.message))
    .finally(() => { lastBackendAlertAt = Date.now(); alertStartedAt = 0 })
  if (c) runInBackground(c, done)
}

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

// The fixed-window / refund algorithms live in lib/rateLimitCore.js (shared with
// the Durable Object). These KV-level exports stay for callers and tests that
// drive a store directly.
const consumeSlot = core.consumeSlot
const refundSlot  = core.refundSlot

// Generic keyed fixed-window quota for things that aren't a per-IP request
// limit (e.g. "at most 3 verification emails per hour to one address"). Fails
// open (returns true) if the backend is unavailable.
async function hitQuota(env, key, max, windowSeconds) {
  try {
    const r = await runOp(env, 'consume', { key, windowSeconds, max })
    return r.allowed
  } catch (err) {
    console.error(`quota (${key.split(':').slice(0, 2).join(':')}) backend error — failing open:`, err.message)
    return true
  }
}

// Gives a quota slot back (see email.service.js's refundOnFailure). Never throws.
async function refundQuota(env, key, windowSeconds, maxRefunds) {
  try { await runOp(env, 'refund', { key, windowSeconds, maxRefunds }) }
  catch (err) { console.error(`quota (${key.split(':').slice(0, 2).join(':')}) refund failed:`, err.message) }
}

// The anonymous-scan limiter's bucket for this request, and the way to hand its slot back
// LATER. The refund inside makeLimiter only covers a request that failed while it was being
// answered; an anonymous scan that fails afterwards (the background job could not structure or
// score it — our fault, not the visitor's) used to keep the slot, so "try again" answered 429
// for an hour. createScan passes the key to the job; the job gives the slot back through this.
const ANON_SCAN_WINDOW_SECONDS = 60 * 60
const ANON_SCAN_MAX_REFUNDS = 10
function anonScanSlotKey(c) { return `rl:anonscan:${rateKeyIp(clientIp(c))}` }
async function refundAnonScanSlot(env, key) {
  if (!key || typeof key !== 'string' || !key.startsWith('rl:anonscan:')) return
  return refundQuota(env, key, ANON_SCAN_WINDOW_SECONDS, ANON_SCAN_MAX_REFUNDS)
}

// `refund: { maxRefunds }` — the request is counted up front (so concurrent
// bursts can't slip past), but if the downstream handler then answers with a
// 4xx/5xx the slot is handed back, up to maxRefunds per window. Used by
// anonScan: a wrong file type, an oversized upload, or a server hiccup must not
// burn the one anonymous scan an hour that the visitor never actually got.
// byAccount — the keyBy for anything behind `auth` that is genuinely
// per-account. Falls back to the IP (null) when no user is on the context.
const byAccount = (c) => { const id = c.get && c.get('user')?.id; return id ? `u:${id}` : null }

// `keyBy(c)` (optional) names who the budget belongs to when that should not be
// the network address — a falsy return falls back to the IP. Anything behind
// `auth` that is genuinely per-account (a heavy personal export) should key on
// the account: on carrier-grade NAT, campus and office networks many unrelated
// people share one IP and would otherwise share (and exhaust) one budget.
// `ipBits` (64 default, 48 for the public verify lookups) is how much of an IPv6 address the
// bucket keys on — see rateKeyIp.
function makeLimiter({ windowSeconds, max, keyPrefix, message, skip, refund, keyBy, ipBits = 64 }) {
  return async (c, next) => {
    if (skip && skip(c)) return next()

    const ip = clientIp(c)
    if (isBypassed(c.env, ip)) return next()

    const key = `${keyPrefix}:${(keyBy && keyBy(c)) || rateKeyIp(ip, ipBits)}`

    let slot
    try {
      slot = await runOp(c.env, 'consume', { key, windowSeconds, max })
    } catch (err) {
      console.error(`rate limiter (${keyPrefix}) backend error — failing open:`, err.message)
      alertKvOutage(c.env, `rate limiter (${keyPrefix})`, err, c)
      return next()
    }

    if (!slot.allowed) {
      return c.json({ success: false, message }, 429, { 'Retry-After': String(slot.retryAfter) })
    }

    if (!refund) return next()

    // AUDIT FIX (Section 9/10 pass — bug): this used to be a bare
    // `await next()` with the refund check immediately after it. Hono only
    // registers ONE app-level app.onError (src/index.js) — its internal
    // compose() wraps the WHOLE middleware chain in a single try/catch at
    // the outermost layer, so an exception thrown downstream (createScan has
    // several plain `throw insertErr`/`throw quotaErr` DB-error paths)
    // propagates straight up through this `await next()`, completely
    // unguarded, before the status check below ever runs. The refund never
    // fired for exactly the case its own comment names as the reason it
    // exists — "a wrong file type, an oversized upload, or a server hiccup
    // must not burn the one anonymous scan an hour" — a thrown server hiccup
    // burned it anyway, silently, every time. A response returned via
    // ctx.json(...) (never thrown) still hits the status check exactly as
    // before; this only adds the previously-missing thrown-error path, then
    // re-throws so errorHandler.js still produces the same response it
    // always did — this change is refund bookkeeping only, never a change in
    // what the client receives.
    //
    // `refund.on` (AUDIT FIX, Auth section round 1): 'failure' (the default, and
    // what anonScan uses) hands the slot back for a 4xx/5xx or a throw;
    // 'success' does the opposite — it hands it back for a 2xx/3xx and never for
    // an error. /auth/login uses 'success': the limiter exists to bound
    // CREDENTIAL GUESSING, so a sign-in that worked isn't a guess and shouldn't
    // eat the budget of everyone else behind the same NAT/carrier IP. It stays
    // bounded by maxRefunds, so "successes don't count" can't become unlimited
    // guesses for someone alternating them with failures.
    const refundOnSuccess = refund.on === 'success'
    try {
      await next()
    } catch (err) {
      if (!refundOnSuccess) {
        try { await runOp(c.env, 'refund', { key, windowSeconds, maxRefunds: refund.maxRefunds }) }
        catch (refundErr) { console.error(`rate limiter (${keyPrefix}) refund failed:`, refundErr.message) }
      }
      throw err
    }
    const status = c.res && c.res.status
    const shouldRefund = typeof status === 'number' && (refundOnSuccess ? status >= 200 && status < 400 : status >= 400)
    if (shouldRefund) {
      try { await runOp(c.env, 'refund', { key, windowSeconds, maxRefunds: refund.maxRefunds }) }
      catch (err) { console.error(`rate limiter (${keyPrefix}) refund failed:`, err.message) }
    }
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
  //
  // ROUND-2 AUDIT FIX (bug, Section 7): /api/verify/* is skipped here too. It has
  // its own, purpose-built limits (verifyRead, the scoped miss counters, the
  // badge quota) — but this generic 100-per-15-min bucket ALSO applied, keyed by
  // IP, to a public endpoint whose real callers are shared IPs: image proxies
  // (GitHub camo, LinkedIn) fetching every embedded badge, and office NATs full
  // of hiring managers. The miss-limiter comment below promised those were never
  // punished for each other's lookups; this bucket quietly did exactly that.
  skip: c => c.req.path.startsWith('/api/webhooks') || c.req.path.startsWith('/api/verify') || isScanPollRequest(c)
})

// Scan-status polling: the SPA polls GET /api/scan/:id every ~2.5s while a
// scan or a fix is generating (a fix can take a minute or two). Counted
// against the generic 100-per-15-min bucket, one scan + one fix alone
// (~60 polls) plus normal browsing could exhaust it, after which EVERY
// endpoint for that IP — login included — 429'd for up to 15 minutes. On
// carrier-grade NAT / campus / office networks that hit unrelated users
// too. Polling now has its own, much larger, bucket (see `scanPoll`).
// /history is a real list query, not a poll, so it stays on `general`.
function isScanPollRequest(c) {
  if (c.req.method !== 'GET') return false
  const m = /^\/api\/scan\/(?:status\/)?([^/]+)\/?$/.exec(c.req.path)
  return !!m && m[1] !== 'history' && m[1] !== 'status'
}

// Dedicated webhook limiter — much higher ceiling than `general` since this
// route's real protection is the HMAC signature check inside the handler,
// not this counter. This exists purely as a backstop against a genuine
// flood (not normal retry/burst traffic), still keyed by IP.
const webhook = makeLimiter({
  windowSeconds: 5 * 60, max: 300, keyPrefix: 'rl:webhook',
  message: msg('Too many requests.')
})

// Dedicated polling limiter — ~1 request / 1.5s sustained, per IP. Still a
// real ceiling (a runaway client or a scraper can't hammer the DB with
// unbounded reads), just sized for how the app legitimately behaves.
const scanPoll = makeLimiter({
  windowSeconds: 15 * 60, max: 600, keyPrefix: 'rl:scanpoll',
  message: msg('Too many requests.')
})

// Public verification pages + downloads (see routes/verify.routes.js). Each hit
// costs an R2 read + SHA-256 of up to two files, so this is a cost ceiling per
// IP — sized well above what a person (or a shared NAT) does, and far below a
// scraper. The Pages Function's link-preview fetches carry the shared secret and
// bypass it (isTrustedPreview).
const verifyRead = makeLimiter({
  windowSeconds: 5 * 60, max: 240, keyPrefix: 'rl:verifyread',
  message: msg('Too many lookups. Please wait a few minutes.'),
  skip: c => isTrustedPreview(c),
  ipBits: 48   // bucket a whole /48, not a /64 — see rateKeyIp
})

const anonScan = makeLimiter({
  windowSeconds: ANON_SCAN_WINDOW_SECONDS, max: constants.ANON_SCANS_PER_HOUR, keyPrefix: 'rl:anonscan',
  message: msg(`Anon limit: ${constants.ANON_SCANS_PER_HOUR}/hr. Create account for ${constants.FREE_SCANS_PER_DAY}/day.`),
  skip: c => !!c.get('user'),
  // The slot is counted before the upload is validated (so a burst can't race
  // past it), then handed back if the request fails — a wrong file type, an
  // oversized upload or a server error must not burn the one anonymous scan
  // per hour the visitor never actually got. Bounded (10 refunds/hour) so it
  // can't become unlimited free invalid attempts against the upload parser.
  refund: { maxRefunds: ANON_SCAN_MAX_REFUNDS }
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

// POST /auth/login. Shares `auth`'s bucket (same keyPrefix, so login attempts
// still pool with register/forgot/reset from one IP) but gives the slot back for
// a successful sign-in — see makeLimiter's `refund.on`. Before this, the 11th
// legitimate sign-in within 15 minutes from one shared IP (an office, a campus,
// a mobile carrier's NAT) was refused with "Too many attempts" though nobody
// had guessed anything. Capped at 20 refunds per window: worst case for one IP
// is 10 + 20 attempts per 15 minutes, and the per-account lockout (which counts
// failures across every IP) still applies in full.
const authLogin = makeLimiter({
  windowSeconds: 15 * 60, max: 10, keyPrefix: 'rl:auth',
  message: msg('Too many attempts.'),
  refund: { maxRefunds: 20, on: 'success' }
})

const authVerify = makeLimiter({
  windowSeconds: 15 * 60, max: 20, keyPrefix: 'rl:authverify',
  message: msg('Too many attempts. Please wait a few minutes.')
})

// AUDIT FIX (Payments & Pricing pass 1, bug — B1): this and paymentCancel
// below sit behind `auth`, so the user is always known, yet both were keyed by
// IP. The customer base is mobile-money heavy — many unrelated buyers share
// one carrier-grade-NAT address — so a few people checking out at the same
// time on one carrier were ALL answered "Payment in progress. Wait." by a
// 3-per-minute budget that belongs to one person. Per ACCOUNT now (same
// keyBy as dataExport); the IP is only the fallback when no user is set.
const payment = makeLimiter({
  windowSeconds: 60, max: 3, keyPrefix: 'rl:payment',
  keyBy: byAccount,
  message: msg('Payment in progress. Wait.')
})

// AUDIT FIX (Section 3/4 re-audit, bug — no live incident, hardening only):
// payments.routes.js used to run POST /:reference/cancel through this same
// `payment` limiter — same KV bucket (`rl:payment:<ip>`), not just the same
// numbers. That's exactly the fate-sharing anti-pattern already fixed
// elsewhere in this file (`click` vs `employerLead`, `partnerRead` vs
// `partnerWrite`): initializePayment's own comments describe double-click,
// two open tabs, and retrying after a slow Paystack popup as NORMAL usage —
// precisely the traffic pattern that burns through a 3-per-minute budget.
// A customer who used up that budget just trying to check out could then
// find cancelPayment — the self-serve escape hatch initializePayment's 409
// response explicitly points them to — blocked too, with no way to clear
// their own stuck PENDING row for another minute. cancelPayment already
// does its own atomic ownership + status check (UPDATE ... WHERE user_id =
// ... AND status = 'PENDING'), so it isn't the sensitive operation `payment`
// exists to throttle; it just needs its own budget so it can't be starved
// by attempts at the thing it's meant to unstick.
const paymentCancel = makeLimiter({
  windowSeconds: 5 * 60, max: 10, keyPrefix: 'rl:paymentcancel',
  keyBy: byAccount,
  message: msg('Too many requests. Please wait a moment.')
})

// AUDIT FIX (Payments & Pricing pass 1, bug — B2): GET /api/payments/verify had
// no limiter of its own — only the app-wide 100-per-15-minutes-per-IP one —
// yet every call is a live Paystack round trip. Its own per-account bucket
// (separate from `payment`, for the same fate-sharing reason as paymentCancel:
// the success page polls it and must not eat a checkout's budget). The
// success page legitimately makes ~6 calls over half a minute plus manual
// "check again" clicks, so 20 per 5 minutes leaves comfortable headroom.
const paymentVerify = makeLimiter({
  windowSeconds: 5 * 60, max: 20, keyPrefix: 'rl:paymentverify',
  keyBy: byAccount,
  message: msg('Too many payment checks. Please wait a minute and try again.')
})

// FEATURE GAP CLOSED (Payments & Pricing pass 1 — G4): POST
// /api/payments/:reference/receipt re-sends a receipt email. Each call is a
// real outbound email, so it is capped tightly, per account.
const paymentReceipt = makeLimiter({
  windowSeconds: 60 * 60, max: 3, keyPrefix: 'rl:paymentreceipt',
  keyBy: byAccount,
  message: msg('Receipt already sent a few times. Please try again in an hour.')
})

// AUDIT FIX (Payments & Pricing round 4, gap G5): GET /api/pricing is public and, with ?ref=, does a
// referral_codes lookup whose answer (referralApplied true/false) says whether a code exists — a
// code-guessing oracle held back only by the app-wide 100-per-15-minutes limiter. Per IP, and ONLY
// when a code is actually being looked up (a plain quote stays on the general limiter alone).
// Generous for a person typing a few codes; hopeless for enumeration.
const pricingRef = makeLimiter({
  windowSeconds: 10 * 60, max: 30, keyPrefix: 'rl:pricingref',
  skip: c => !c.req.query('ref'),
  message: msg('Too many referral code checks. Please wait a few minutes and try again.')
})

// Backs PATCH /scan/:id/resume-data and GET /scan/:id/download-draft
// (scan.controller.js's updateResumeData/downloadDraft). Reachable by
// anonymous visitors too (ownership is enforced via anon_token, not the
// `auth` middleware — see those routes). NOT free: every PATCH re-renders the
// docx AND makes a Claude scoring call (scoreResumeWithAI), so this is also
// a spend ceiling, not just abuse hygiene — 15 edits per 15 minutes is far
// more than a person genuinely correcting their extracted data needs.
const resumeEdit = makeLimiter({
  windowSeconds: 15 * 60, max: 15, keyPrefix: 'rl:resumeedit',
  message: msg('Too many requests. Please wait a moment.')
})

// BUG FIX (Scan/ATS pass): regenerate-pdf and download-draft shared the
// `resumeEdit` bucket with the resume-data PATCH — three unrelated actions on
// one 15-per-15-minutes budget, the same fate-sharing shape this file has
// already split apart several times. A person who edits their extracted data
// a few times and then downloads their draft could be told "too many
// requests" on the download itself; a PDF regeneration (a Chromium render,
// the most expensive of the three) could be starved by edits or vice versa.
// Each gets its own bucket, sized to what it costs.
const pdfRegen = makeLimiter({
  windowSeconds: 15 * 60, max: 8, keyPrefix: 'rl:pdfregen',
  message: msg('Too many requests. Please wait a moment.')
})
const draftDownload = makeLimiter({
  windowSeconds: 15 * 60, max: 30, keyPrefix: 'rl:draftdownload',
  message: msg('Too many requests. Please wait a moment.')
})

// AUDIT FIX (Section 9/10 pass, bug): redeemCredit and retryFix (scan.routes.js)
// used to run through this exact `payment` limiter instance — same KV bucket
// (`rl:payment:<ip>`), not just the same numbers — as initializePayment. The
// identical fate-sharing mistake this file has already fixed three separate
// times elsewhere (paymentCancel vs payment, click vs employerLead, partnerWrite
// vs partnerRead): two unrelated actions burning one shared 3-per-60s budget,
// so a few legitimate retries could block a real checkout attempt from the same
// IP (or a shared office/NAT IP mixing several people's payment and retry
// traffic) — and vice versa. Split into their own buckets.
//
// retryFix gets the same shape as resumeEdit above — it's the same kind of
// spend ceiling (a Claude rewrite call + a re-render), not a credential- or
// money-adjacent surface, so a generous per-15-min budget is the right fit.
// The DB-level cap (increment_fix_retry_if_available, MAX_FIX_RETRIES) already
// bounds retries per scan; this is just an abuse backstop across scans.
const retryFix = makeLimiter({
  windowSeconds: 15 * 60, max: 15, keyPrefix: 'rl:retryfix',
  keyBy: byAccount,
  message: msg('Too many requests. Please wait a moment.')
})

// redeemCredit spends a scarce, already-earned free_fix_credits row — a much
// rarer action than a resume edit or a retry, so a tighter ceiling than either
// is still generous for genuine use (an account only ever has a handful of
// credits) while keeping it out of `payment`'s tight checkout-specific budget.
// Per account for the same NAT reason as `payment` above (behind `auth`).
const redeemCredit = makeLimiter({
  windowSeconds: 5 * 60, max: 5, keyPrefix: 'rl:redeemcredit',
  keyBy: byAccount,
  message: msg('Too many requests. Please wait a moment.')
})

// Backs GET /api/profile/export — one request reads every scan and payment the
// account has (JD text, structured resumes and all), so it is capped tightly;
// a person downloading their own data needs it a handful of times, not more.
// Per ACCOUNT, not per IP (see makeLimiter's keyBy). Parts of one multi-part
// export are separate requests, so the ceiling leaves room for a large
// account to fetch all of its parts more than once.
const dataExport = makeLimiter({
  windowSeconds: 60 * 60, max: 12, keyPrefix: 'rl:export',
  keyBy: byAccount,
  message: msg('Too many export requests. Please try again later.')
})

// Backs DELETE /api/profile/scans — "delete my whole scan history" runs as a loop of small
// batches (each one deletes up to a few dozen scans and their stored files), so the ceiling is
// per ACCOUNT and sized for a large history being cleared in one sitting, a few times at most.
const historyPurge = makeLimiter({
  windowSeconds: 60 * 60, max: 120, keyPrefix: 'rl:historypurge',
  keyBy: byAccount,
  message: msg('Too many delete requests. Please try again later.')
})

const employerLead = makeLimiter({
  windowSeconds: 60 * 60, max: 10, keyPrefix: 'rl:lead',
  message: msg('Slow down.')
})

// BUG FIX (fresh audit pass, Section 5): confirm/remove used to share this
// exact `employerLead` bucket (`rl:lead:<ip>`) with the public lead FORM —
// the identical fate-sharing mistake diagnosed and fixed for partner
// click-tracking below (`click`). 10/hr is sized for "a stranger filling out
// a form," not "an inbox owner clicking a link in an email" — a shared
// office/NAT IP that fills that quota submitting leads would also start
// getting 429s on unrelated confirm/remove clicks from the same address.
// That's a worse failure mode for `removeLead` specifically: blocking
// someone's one-click opt-out is worse than blocking a form submission.
// Both actions require a valid signed token (leadTokens.js) to do anything
// at all, so this bucket exists for general abuse hygiene, not to stop
// guessing — sized generously relative to `employerLead` accordingly.
const employerLeadLink = makeLimiter({
  windowSeconds: 60 * 60, max: 30, keyPrefix: 'rl:leadlink',
  message: msg('Slow down.')
})

// AUDIT FIX (Payments & Pricing / Partners re-audit, bug — no live incident,
// hardening only): partners.routes.js's three public, TOKEN-gated endpoints
// (GET /payout-details, POST /payout-details, GET /dashboard) had no rate
// limit at all, unlike everything else public in this file — including
// `click` right below, which explicitly got its OWN bucket specifically
// because sharing one was wrong for a different reason. The 32-byte
// payout_details_token (see partners.controller.js) makes brute-forcing the
// token itself infeasible either way, so this was never an auth-bypass
// risk — but a leaked/logged/shoulder-surfed token had zero throttle
// standing between it and unlimited payout-detail-rewrite attempts (each
// one firing two notification emails via submitPayoutDetails) or unlimited
// expensive 3-relation-join dashboard queries. Split into read/write the
// same way `payment` vs. `resumeEdit` are split elsewhere in this file — a
// GET is cheap and legitimately polled more; the POST redirects real money
// and has a real side effect (2 emails) per call, so it gets the tighter
// ceiling.
const partnerRead = makeLimiter({
  windowSeconds: 5 * 60, max: 30, keyPrefix: 'rl:partnerread',
  message: msg('Too many requests. Please wait a moment.')
})
// Round 4: "email me my payout-details link" (POST /api/partners/request-payout-link). Its
// own bucket — the same fate-sharing mistake partnerRead/partnerWrite were split to avoid:
// sharing partnerWrite's 5-per-15-min budget would let a few applications (or payout-detail
// edits) from one office/NAT IP block a partner from getting their own link.
const partnerLinkRequest = makeLimiter({
  windowSeconds: 15 * 60, max: 5, keyPrefix: 'rl:partnerlinkreq',
  message: msg('Too many requests. Please wait a few minutes.')
})
const partnerWrite = makeLimiter({
  windowSeconds: 15 * 60, max: 5, keyPrefix: 'rl:partnerwrite',
  message: msg('Too many attempts. Please wait a few minutes.')
})

// AUDIT FIX (Section 9): partners.routes.js's POST /track-click used to
// share this exact `employerLead` limiter instance — same KV bucket
// (`rl:lead:<ip>`), not just the same numbers. Two problems: (1) 10/hr is
// tuned for lead-form spam, not passive click analytics on a public
// referral link — a single office/campus IP visiting even a mildly
// successful referral link would blow through it and start silently
// under-counting a partner's real traffic; (2) because it was the SAME
// bucket, a burst of referral clicks from one IP could exhaust the quota
// and block a legitimate employer-lead submission from that same IP, and
// vice versa — two functionally unrelated features fate-sharing a rate
// limit neither was designed around. Given its own dedicated bucket and a
// ceiling sized for "passive link visits," not "a human filling out a form."
const click = makeLimiter({
  windowSeconds: 60 * 60, max: 120, keyPrefix: 'rl:click',
  message: msg('Slow down.')
})

// AUDIT FIX (Section 9, feature gap): `auth` above is IP-only. A credential-
// stuffing attempt spread across many IPs (a botnet, a rotating proxy pool)
// against ONE specific account sails straight through it — each individual
// IP stays comfortably under 10/15min while the account itself absorbs
// unlimited guesses. This is a second, independent backstop keyed by the
// *account* (normalized email) instead of the requester, so it catches
// exactly the attack shape the IP limiter structurally cannot.
//
// Deliberately NOT the same primitive as makeLimiter()'s fixed window —
// this tracks CONSECUTIVE failures (reset to zero on any successful login),
// not a request count, and locks out for a cooldown once a threshold is
// hit, rather than just re-arming on a timer. Deliberately applied to every
// email attempted, real account or not: only ever gating on whether an
// account exists (as opposed to gating identically either way) would let an
// attacker fingerprint which emails are registered by noticing which ones
// eventually start returning "too many failed attempts" instead of
// "invalid credentials" — the same non-enumeration property login() already
// protects with its dummy-hash timing match is preserved here the same way.
const LOCKOUT_MAX_CONSECUTIVE_FAILURES = core.LOCKOUT_MAX_CONSECUTIVE_FAILURES
const LOCKOUT_MINUTES = core.LOCKOUT_MINUTES
const LOCKOUT_KEY_PREFIX = 'rl:lockout'
// AUDIT FIX (bug — account-lockout DoS, section audit): failCount alone let
// anyone who merely knows a real user's email lock that account for
// LOCKOUT_MINUTES with LOCKOUT_MAX_CONSECUTIVE_FAILURES trivial requests
// from a single IP — comfortably under `rl.auth`'s own 10/15min budget —
// and repeat indefinitely, fully unauthenticated, with zero credential
// knowledge required. Requiring failures to come from at least this many
// DISTINCT IPs before actually locking preserves the original purpose
// (catching a distributed/rotating-IP credential-stuffing attempt the
// IP-only `rl.auth` limiter structurally can't see — see the comment below)
// while closing the free single-IP DoS: a lone attacker now exhausts
// `rl.auth`'s own IP budget long before an account-level lock can ever
// trigger, since it takes coordinated failures from more than one address.
const LOCKOUT_MIN_DISTINCT_IPS = core.LOCKOUT_MIN_DISTINCT_IPS
// Bounded — recordLoginFailure only needs to know "how many distinct IPs
// have failed," not a full history, so this caps the stored array rather
// than letting it grow unboundedly under a long-running distributed attempt.
const LOCKOUT_MAX_TRACKED_IPS = core.LOCKOUT_MAX_TRACKED_IPS

function lockoutKey(email) {
  return `${LOCKOUT_KEY_PREFIX}:${String(email).trim().toLowerCase()}`
}

// Returns { locked: boolean, retryAfterSeconds: number|null }. Call before
// doing any real work (DB lookup, bcrypt) in the login handler — a locked
// account should short-circuit as cheaply as possible, not just get denied
// at the end of the usual path.
//
// FEATURE: also called (with the session's own email) by changePassword/
// updateEmail/deleteAccount in auth.controller.js — those three also run a
// live bcrypt.compare against attacker-supplied input, which makes each of
// them the same kind of password-guessing oracle login() is, for anyone
// holding a stolen/leaked JWT who doesn't know the real password. Sharing
// this same email-keyed counter means guesses against one account are
// tallied together across every endpoint that can prove its password.
async function checkAccountLockout(env, email) {
  try {
    return await runOp(env, 'lockoutCheck', { key: lockoutKey(email) })
  } catch (err) {
    // FAIL OPEN — see the file-level comment: an outage must never become a login outage.
    console.error('login lockout check backend error — failing open:', err.message)
    alertKvOutage(env, 'account lockout check', err)
    return { locked: false, retryAfterSeconds: null }
  }
}

// Call on every failed login attempt (wrong password OR no such account —
// see the non-enumeration note above). Locks the account once BOTH
// LOCKOUT_MAX_CONSECUTIVE_FAILURES is reached AND those failures span at
// least LOCKOUT_MIN_DISTINCT_IPS distinct IPs (see that constant's comment
// above for why the IP requirement exists). `ip` is required — callers
// extract it the same way scan.controller.js's quota bypass check does
// (`cf-connecting-ip` first, `x-forwarded-for` fallback, else 'unknown').
// Returns { justLocked: boolean } — true only on the specific call whose
// failure is what pushed the account from unlocked into locked, so callers
// with access to the account's name/email can fire a one-time alert rather
// than one per failed attempt (see sendAccountLockoutAlert in
// email.service.js, wired up in auth.controller.js).
//
// AUDIT FIX (bug — Auth section, second independent pass): LOCKOUT_MIN_DISTINCT_IPS
// exists to stop a STRANGER from freely locking a victim out of login() with a
// handful of requests from one IP — a real threat there, since login() is
// fully unauthenticated and anyone can hit it. changePassword/updateEmail/
// deleteAccount reuse this exact function for the same "don't let a stolen
// JWT be used as a password-guessing oracle" reason, but for THOSE three the
// distinct-IP bar actively works against the goal: the caller already holds a
// valid session (XSS, a shared/left-open device, a leaked token) and has no
// need to spread guesses across IPs to avoid a false-lockout concern that only
// ever applied to login()'s unauthenticated attacker. A one-IP attacker
// against those three endpoints could never accumulate the 2nd distinct IP
// needed to trip the lock, leaving them bounded only by rl.auth's generic
// 10-per-15-min-per-IP bucket — which paces but never actually stops or
// alerts anyone. `opts.requireDistinctIps: false` (passed by those three call
// sites only; login() keeps the default) drops the distinct-IP bar to 1 for
// this call, so a single-IP attacker against an authenticated password check
// still gets locked out — and the account owner still gets the lockout email
// — after LOCKOUT_MAX_CONSECUTIVE_FAILURES, exactly the protection the
// comments already claimed these three endpoints had.
async function recordLoginFailure(env, email, ip, opts = {}) {
  try {
    // Tally by the same bucket the limiters use (an IPv6 client owns a whole /64),
    // so "distinct" means distinct clients, not distinct addresses in one subnet.
    const normalizedIp = rateKeyIp(String(ip || 'unknown'))
    const minDistinctIps = opts.requireDistinctIps === false ? 1 : LOCKOUT_MIN_DISTINCT_IPS
    const r = await runOp(env, 'lockoutFail', { key: lockoutKey(email), ip: normalizedIp, minDistinctIps })
    return { justLocked: !!r.justLocked }
  } catch (err) {
    console.error('login failure record backend error (ignored):', err.message)
    return { justLocked: false }
  }
}

// Call on every successful login — clears the failure count so a real user
// who mistypes their password a few times isn't left one mistake away from
// a lockout on their next legitimate attempt days later.
async function recordLoginSuccess(env, email) {
  try { await runOp(env, 'lockoutClear', { key: lockoutKey(email) }) }
  catch (err) { console.error('login success record backend error (ignored):', err.message) }
}

// ── Public verification lookups: miss limiter ───────────────────────────────
// /api/verify/:code is public and unauthenticated, and the codes are only 6
// characters from a 32-symbol alphabet (~1.07 billion combinations).
// `general`'s 100 req / 15 min per IP treats a hiring manager opening a real
// link and a script probing random codes identically. This counts only
// MISSES (unknown code / malformed code) per IP: a real reader never
// produces one, a prober produces nothing but them. Deliberately separate
// from `general` so an office NAT full of legitimate readers is never
// punished for each other's successful lookups.
const VERIFY_MISS_MAX = 30
// The embeddable badge gets its own, much higher ceiling AND its own counter.
// ROUND-2 AUDIT FIX (bug, Section 7): badge misses used to feed the same
// 30-per-15-min counter as page lookups. A stale or typo'd code in a README is
// re-requested on every impression, and any web page can load
// <img src=".../badge.svg"> for random codes — so a proxy IP (or a victim's
// office NAT) could be locked out of EVERY verify lookup, valid ones included,
// for 15 minutes. Reproduced: 30 stale-badge hits made a valid page and a valid
// badge both answer 429. Separate buckets, and a high one for the badge, keep
// the enumeration brake without letting an <img> tag pull it.
const VERIFY_BADGE_MISS_MAX = 300
const VERIFY_MISS_WINDOW_SECONDS = 15 * 60

// SECTION 7 AUDIT FIX (bug): every OTHER limiter in this file keys its KV
// entry off rateKeyIp(ip), which collapses an IPv6 address to its /64 —
// without that, one IPv6 subscriber (who controls billions of addresses,
// often rotated automatically by their own OS for privacy) can mint
// effectively unlimited "different" callers for free. This is the one
// per-IP counter in the file that guards against enumerating the ~1.07
// billion possible verification codes, and it was keying on the raw IP —
// exactly the gap rateKeyIp exists to close, left open on the limiter that
// most needed it.
// AUDIT FIX (bug, verify round 3): keyed on the /48, not the /64 — a single actor with a
// /48 (free from tunnel brokers, standard on hosting plans) owns 65,536 /64s and so
// 65,536 independent budgets under the old key.
function verifyMissKey(ip, scope = 'page') { return `${scope === 'badge' ? 'rl:vmissb' : 'rl:vmiss'}:${rateKeyIp(ip, 48)}` }
const missMax = scope => (scope === 'badge' ? VERIFY_BADGE_MISS_MAX : VERIFY_MISS_MAX)

// true → this IP has already produced too many misses in the window.
// Fails OPEN on any backend problem (same posture as makeLimiter).
async function isVerifyMissLimited(env, ip, now = Date.now(), scope = 'page') {
  if (!hasBackend(env) || isBypassed(env, ip)) return false
  try {
    const r = await runOp(env, 'missRead', { key: verifyMissKey(ip, scope), max: missMax(scope), now })
    return !!r.limited
  } catch (err) {
    console.error('Verify miss limiter read failed — failing open:', err.message)
    alertKvOutage(env, 'verify miss limiter', err)
    return false
  }
}

async function recordVerifyMiss(env, ip, now = Date.now(), scope = 'page') {
  if (!hasBackend(env) || isBypassed(env, ip)) return
  try {
    await runOp(env, 'missRecord', { key: verifyMissKey(ip, scope), now })
  } catch (err) {
    console.error('Verify miss limiter write failed:', err.message)
  }
}

module.exports = {
  general, scanPoll, anonScan, auth, authLogin, authVerify, payment, paymentCancel, paymentVerify, paymentReceipt, pricingRef, resumeEdit, pdfRegen, draftDownload, retryFix, redeemCredit, employerLead, employerLeadLink, dataExport, historyPurge, webhook, click,
  partnerRead, partnerWrite, partnerLinkRequest, verifyRead, isBypassed,
  isScanPollRequest, checkAccountLockout, recordLoginFailure, recordLoginSuccess, LOCKOUT_MINUTES,
  isVerifyMissLimited, recordVerifyMiss, VERIFY_MISS_MAX, VERIFY_BADGE_MISS_MAX, VERIFY_MISS_WINDOW_SECONDS,
  clientIp, rateKeyIp, anonScanSlotKey, refundAnonScanSlot, hitQuota, refundQuota, consumeSlot, refundSlot, runOp, backendName
}
