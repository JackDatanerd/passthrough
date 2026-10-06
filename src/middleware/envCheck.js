// Runs validateEnv() once per isolate (the environment doesn't change between
// requests), logs what it finds, and — only when the app literally cannot
// work — answers /api/* with 503 instead of failing in some confusing way
// further down (see lib/env.js for what counts as fatal).
const { validateEnv } = require('../lib/env')

// "https://passthrough.dev/" would break CORS and put a double slash in every emailed link —
// strip trailing slashes in place (cron and queue entry points call this too, since they
// build emailed links without ever passing through the HTTP middleware).
function normalizeEnv(env) {
  try {
    if (env && typeof env.FRONTEND_URL === 'string' && /\/+$/.test(env.FRONTEND_URL))
      env.FRONTEND_URL = env.FRONTEND_URL.replace(/\/+$/, '')
  } catch (_) { /* a frozen env object: validateEnv still warns about it */ }
}

let cached = null
function result(env) {
  if (!cached) {
    normalizeEnv(env)
    cached = validateEnv(env)
    for (const f of cached.fatal) console.error(`[CONFIG] FATAL: ${f}`)
    for (const w of cached.warnings) console.error(`[CONFIG] warning: ${w}`)
  }
  return cached
}

async function envCheck(c, next) {
  const r = result(c.env)
  if (r.fatal.length)
    return c.json({ success: false, message: 'Service temporarily unavailable.' }, 503, { 'Retry-After': '60' })
  return next()
}

envCheck.status = env => {
  const r = result(env)
  return { configured: r.fatal.length === 0, warnings: r.warnings.length }
}
envCheck.normalizeEnv = normalizeEnv
envCheck._reset = () => { cached = null }   // tests only

module.exports = envCheck
