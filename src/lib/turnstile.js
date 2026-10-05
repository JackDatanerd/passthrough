// Cloudflare Turnstile verification for the public employer-lead form.
//
// That form is the one unauthenticated endpoint here that makes us email an address a
// stranger typed, so a honeypot plus a per-IP limit was the only thing standing between it
// and being used to mail third parties. Turnstile adds a real challenge.
//
// Opt-in by configuration: with no TURNSTILE_SECRET_KEY the check is skipped and the form
// behaves exactly as before — the frontend renders the widget only when
// VITE_TURNSTILE_SITE_KEY is set, so a deployment turns this on by setting BOTH keys.
//
// Policy:
//   * Cloudflare says the token is bad (success: false)       -> reject
//   * secret configured but no token sent                      -> reject
//   * Cloudflare unreachable / timed out / unreadable reply    -> ALLOW, and log. An outage at
//     the challenge provider must not turn into lost leads (the same stance every limiter in
//     this app takes); the per-IP limit and the honeypot still apply.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIMEOUT_MS = 4000

async function verifyTurnstile(env, token, ip) {
  const secret = env && env.TURNSTILE_SECRET_KEY
  if (!secret) return true
  if (!token || typeof token !== 'string') return false

  const form = new URLSearchParams({ secret, response: token })
  if (ip && ip !== 'unknown') form.set('remoteip', ip)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form, signal: controller.signal })
    if (!res.ok) {
      console.error(`Turnstile siteverify answered HTTP ${res.status} — allowing the submission.`)
      return true
    }
    const result = await res.json()
    if (typeof result.success !== 'boolean') {
      console.error('Turnstile siteverify returned an unreadable reply — allowing the submission.')
      return true
    }
    return result.success
  } catch (err) {
    console.error('Turnstile siteverify unreachable — allowing the submission:', err.message)
    return true
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { verifyTurnstile, SITEVERIFY_URL }
