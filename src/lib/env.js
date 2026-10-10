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
  // Without these two nothing stops the Worker, but the failure is silent: alerts (failed jobs, payment
  // mismatches, schema behind, webhook signature failures) are written to alert_logs and emailed to nobody,
  // and Paystack redirects buyers to whatever callback the dashboard has instead of this app's success page.
  OWNER_ALERT_EMAIL:   'owner alert emails (alerts are only stored in alert_logs)',
  PAYSTACK_CALLBACK_URL: 'the post-payment redirect (Paystack falls back to its dashboard setting)',
}
const BINDINGS = { RATE_LIMIT_KV: 'rate limiting', RESUMES_BUCKET: 'resume storage (R2)', FIX_QUEUE: 'fix generation queue' }

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

  if (env.NODE_ENV !== 'production')
    warnings.push(`NODE_ENV is ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'not set'}, not "production" — fine for local dev, but a deployed Worker without it is treated as a non-production target (error detail is not masked, and x-forwarded-for is honoured for client IPs when NODE_ENV is set to anything other than "production")`)

  if (env.RATE_LIMIT_BYPASS_IPS && env.NODE_ENV === 'production')
    warnings.push('RATE_LIMIT_BYPASS_IPS is set in production — every listed IP skips ALL rate limits (testing only; `wrangler secret delete` it before real traffic)')

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

  if (env.PROMO_ACTIVE === 'true') {
    const ends = Date.parse(env.PROMO_ENDS_AT || '')
    if (Number.isNaN(ends)) warnings.push('PROMO_ACTIVE is "true" but PROMO_ENDS_AT is missing/unparseable — promo pricing is OFF')
    else if (ends <= Date.now()) warnings.push(`PROMO_ACTIVE is "true" but PROMO_ENDS_AT (${env.PROMO_ENDS_AT}) has passed — standard pricing applies; set PROMO_ACTIVE="false" or extend the date`)
  }

  return { fatal, warnings }
}

module.exports = { validateEnv, CRITICAL }
