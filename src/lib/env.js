// Startup configuration check.
//
// A Worker with a missing or malformed setting doesn't fail at deploy — it
// fails at request time, in ways that look like something else entirely: a
// missing JWT_SECRET makes EVERY request answer "Invalid token" (401 — which
// the SPA reads as "your session expired" and signs everyone out), a
// FRONTEND_URL with a trailing slash silently breaks CORS and every emailed
// link. This turns those into one clear log line (and, for settings the app
// literally cannot run without, an honest 503) at the first request.
//
// Deliberately conservative: only settings whose ABSENCE makes the app
// unusable are fatal. Anything merely suspicious is a warning, so a deployment
// that works today is never taken down by a stricter check.

const { parseIpAllowList } = require('./clientIp')

const CRITICAL = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET']

// Needed for a feature, not for the app to answer requests at all.
const FEATURE_SECRETS = {
  RESEND_API_KEY:      'transactional email',
  PAYSTACK_SECRET_KEY: 'payments + webhook signature verification',
  ANTHROPIC_API_KEY:   'resume scoring / rewriting',
  EMAIL_FROM:          'email sender address',
  FRONTEND_URL:        'CORS + every emailed link',
  RESEND_WEBHOOK_SECRET: 'bounce / spam-complaint handling (Resend webhook)',
  TAX_ID_ENCRYPTION_KEY: 'saving a partner\u2019s tax ID (it is stored encrypted, never in clear)',
  // Without these two nothing stops the Worker, but the failure is silent: alerts (failed jobs, payment
  // mismatches, schema behind, webhook signature failures) are written to alert_logs and emailed to nobody,
  // and Paystack redirects buyers to whatever callback the dashboard has instead of this app's success page.
  OWNER_ALERT_EMAIL:   'owner alert emails (alerts are only stored in alert_logs)',
  PAYSTACK_CALLBACK_URL: 'the post-payment redirect (Paystack falls back to its dashboard setting)',
}
const BINDINGS = { RATE_LIMIT_KV: 'rate limiting', RESUMES_BUCKET: 'resume storage (R2)', FIX_QUEUE: 'fix generation queue',
  BROWSER: 'PDF rendering (paid fixes would ship as DOCX only)' }

const PLACEHOLDER_SECRETS = ['replace_with_minimum_32_char_random_string']

function validateEnv(env) {
  env = env || {}
  const fatal = []
  const warnings = []

  for (const k of CRITICAL) if (!env[k]) fatal.push(`${k} is not set`)

  const secret = env.JWT_SECRET
  if (secret) {
    if (String(secret).length < 32) warnings.push('JWT_SECRET is shorter than 32 characters (see DEPLOYMENT.md)')
    if (PLACEHOLDER_SECRETS.includes(String(secret))) warnings.push('JWT_SECRET is still the .dev.vars.example placeholder')
  }

  // Employer-lead links (confirm / remove / one-click unsubscribe) are signed with LEAD_LINK_SECRET,
  // falling back to JWT_SECRET — see lib/leadTokens.js leadLinkSecrets.
  for (const k of ['LEAD_LINK_SECRET', 'LEAD_LINK_SECRET_PREVIOUS'])
    if (env[k] && String(env[k]).length < 32) warnings.push(`${k} is shorter than 32 characters (see DEPLOYMENT.md)`)
  if (env.LEAD_LINK_SECRET && env.JWT_SECRET && env.LEAD_LINK_SECRET === env.JWT_SECRET)
    warnings.push('LEAD_LINK_SECRET is the same value as JWT_SECRET — it only helps if it is different')

  if (env.TAX_ID_ENCRYPTION_KEY && !/^[A-Za-z0-9+/]{43}=$/.test(String(env.TAX_ID_ENCRYPTION_KEY).trim()))
    warnings.push('TAX_ID_ENCRYPTION_KEY is not 32 bytes of base64 (generate one with: openssl rand -base64 32) \u2014 tax IDs cannot be saved or read')
  for (const [k, why] of Object.entries(FEATURE_SECRETS))
    if (!env[k]) warnings.push(`${k} is not set — ${why} will not work`)
  for (const [k, why] of Object.entries(BINDINGS))
    if (!env[k]) warnings.push(`binding ${k} is missing — ${why} will not work`)
  if (!env.RATE_LIMIT_DO)
    warnings.push('binding RATE_LIMIT_DO is missing — rate limits and account lockout fall back to best-effort KV counters that a burst of parallel requests can overrun (see DEPLOYMENT.md)')

  const fe = env.FRONTEND_URL
  if (fe) {
    if (!/^https?:\/\//i.test(fe)) warnings.push('FRONTEND_URL must start with http:// or https://')
    else if (/\/$/.test(fe)) warnings.push('FRONTEND_URL has a trailing slash — emailed links would contain "//"')
  }

  // Cross-cutting infra round 6: this used to say error detail "is not masked" for an unset NODE_ENV — it is masked
  // (errorHandler shows raw messages only for "development" / "test"). What a non-production value really changes:
  // a client-supplied x-forwarded-for is trusted for the client IP (so a caller picks its own rate-limit bucket) when
  // NODE_ENV is set to anything but "production", and raw error messages are shown for "development" / "test".
  if (env.NODE_ENV !== 'production')
    warnings.push(`NODE_ENV is ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'not set'}, not "production" — fine for local dev, but on a deployed Worker it must be "production": any other SET value makes the Worker trust a client-supplied x-forwarded-for for rate limiting, and "development" / "test" also show raw error messages`)

  // Cross-cutting infra round 6: DEPLOYMENT.md promises a start-up warning "in every environment"; it was only emitted
  // in production. A bypass list switches every rate limit off for those addresses, so say so wherever it is set.
  if (env.RATE_LIMIT_BYPASS_IPS)
    warnings.push(env.NODE_ENV === 'production'
      ? 'RATE_LIMIT_BYPASS_IPS is set in production — every listed IP skips ALL rate limits (testing only; `wrangler secret delete` it before real traffic)'
      : 'RATE_LIMIT_BYPASS_IPS is set — every listed IP skips ALL rate limits (never carry it to production)')

  // PAYSTACK_WEBHOOK_IPS takes plain addresses (and, since round 10, `address/prefix` ranges); an unusable entry matches nothing,
  // and with the list set every webhook from an unlisted address is refused 403.
  if (env.PAYSTACK_WEBHOOK_IPS && String(env.PAYSTACK_WEBHOOK_IPS).trim()) {
    const { valid, invalid } = require('./clientIp').parseIpAllowList(env.PAYSTACK_WEBHOOK_IPS)
    if (invalid.length) warnings.push(`PAYSTACK_WEBHOOK_IPS has entries that are not IP addresses or address/prefix ranges (${invalid.join(', ')}) — those entries match nothing`)
    if (!valid.length) warnings.push('PAYSTACK_WEBHOOK_IPS has NO usable entry — every Paystack webhook will be refused with 403')
  }
  if (env.PAYSTACK_SECRET_KEY_PREVIOUS && env.PAYSTACK_SECRET_KEY_PREVIOUS === env.PAYSTACK_SECRET_KEY)
    warnings.push('PAYSTACK_SECRET_KEY_PREVIOUS equals PAYSTACK_SECRET_KEY — remove it (it is only for the retry window after a key rotation)')

  // ADMIN_ALLOWED_IPS takes IP addresses and CIDR ranges ("203.0.113.0/24", "2001:db8:abcd::/48"); a bare IPv6
  // address means its whole /64. A typo matches no request at all — and with the list set, a request that
  // matches nothing is REFUSED, so one bad entry beside good ones is harmless but a list with no usable
  // entry locks every admin out.
  if (env.ADMIN_ALLOWED_IPS && String(env.ADMIN_ALLOWED_IPS).trim()) {
    const { valid, invalid } = parseIpAllowList(env.ADMIN_ALLOWED_IPS)
    if (invalid.length)
      warnings.push(`ADMIN_ALLOWED_IPS has ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} that ${invalid.length === 1 ? 'is' : 'are'} not an IP address or CIDR range (${invalid.join(', ')}) and will never match.`)
    if (!valid.length)
      warnings.push('ADMIN_ALLOWED_IPS has no valid IP address or range, so EVERY admin request is refused — fix it or `wrangler secret delete ADMIN_ALLOWED_IPS`')
  }

  // Round 12 (G1): prices exist per currency (constants.js PRICES_BY_CURRENCY). A currency with no row makes
  // every quote and checkout answer 503 rather than charge a USD figure in the wrong currency.
  {
    const c = require('../config/constants')
    if (!c.isSupportedCurrency(env))
      warnings.push(`PAYSTACK_CURRENCY is "${c.activeCurrency(env)}" but constants.js PRICES_BY_CURRENCY has no price table for it — pricing and checkout answer 503 until one is added`)
    else if (env.PAYSTACK_CURRENCY && env.PAYSTACK_CURRENCY !== c.activeCurrency(env))
      warnings.push(`PAYSTACK_CURRENCY "${env.PAYSTACK_CURRENCY}" is not in canonical form — it is used as "${c.activeCurrency(env)}"; set it to exactly that`)
  }

  if (env.PROMO_ACTIVE === 'true') {
    const ends = Date.parse(env.PROMO_ENDS_AT || '')
    if (Number.isNaN(ends)) warnings.push('PROMO_ACTIVE is "true" but PROMO_ENDS_AT is missing/unparseable — promo pricing is OFF')
    else if (ends <= Date.now()) warnings.push(`PROMO_ACTIVE is "true" but PROMO_ENDS_AT (${env.PROMO_ENDS_AT}) has passed — standard pricing applies; set PROMO_ACTIVE="false" or extend the date`)
  }

  {
    const { parseNumEnv, NUMERIC_ENV } = require('./numEnv')
    for (const [k, range] of Object.entries(NUMERIC_ENV)) {
      const r = parseNumEnv(env[k], { integer: k !== 'ADMIN_SESSION_MAX_HOURS', ...range })
      if (r.ok || r.unset) continue
      const effect = k === 'ADMIN_STEP_UP_MINUTES' ? 'password step-up stays ON at 10 minutes'
        : k === 'ADMIN_SESSION_MAX_HOURS' ? 'the default 24-hour admin session cap applies'
        : 'the built-in default is used'
      warnings.push(`${k} is "${env[k]}" — it must be a plain number between ${range.min} and ${range.max} (no units like "h", "m", "s", "d"); ${effect}`)
    }
  }

  return { fatal, warnings }
}

module.exports = { validateEnv, CRITICAL }
