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

const CRITICAL = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET']

// Needed for a feature, not for the app to answer requests at all.
const FEATURE_SECRETS = {
  RESEND_API_KEY:      'transactional email',
  PAYSTACK_SECRET_KEY: 'payments + webhook signature verification',
  ANTHROPIC_API_KEY:   'resume scoring / rewriting',
  EMAIL_FROM:          'email sender address',
  FRONTEND_URL:        'CORS + every emailed link',
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

  for (const [k, why] of Object.entries(FEATURE_SECRETS))
    if (!env[k]) warnings.push(`${k} is not set — ${why} will not work`)
  for (const [k, why] of Object.entries(BINDINGS))
    if (!env[k]) warnings.push(`binding ${k} is missing — ${why} will not work`)

  const fe = env.FRONTEND_URL
  if (fe) {
    if (!/^https?:\/\//i.test(fe)) warnings.push('FRONTEND_URL must start with http:// or https://')
    else if (/\/$/.test(fe)) warnings.push('FRONTEND_URL has a trailing slash — emailed links would contain "//"')
  }

  if (env.RATE_LIMIT_BYPASS_IPS && env.NODE_ENV === 'production')
    warnings.push('RATE_LIMIT_BYPASS_IPS is set in production — every listed IP skips ALL rate limits (testing only; `wrangler secret delete` it before real traffic)')

  if (env.PROMO_ACTIVE === 'true') {
    const ends = Date.parse(env.PROMO_ENDS_AT || '')
    if (Number.isNaN(ends)) warnings.push('PROMO_ACTIVE is "true" but PROMO_ENDS_AT is missing/unparseable — promo pricing is OFF')
    else if (ends <= Date.now()) warnings.push(`PROMO_ACTIVE is "true" but PROMO_ENDS_AT (${env.PROMO_ENDS_AT}) has passed — standard pricing applies; set PROMO_ACTIVE="false" or extend the date`)
  }

  return { fatal, warnings }
}

module.exports = { validateEnv, CRITICAL }
