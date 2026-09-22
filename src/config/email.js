// Replaces config/email.js (Nodemailer transporter). Resend's HTTP API is a
// single fetch call — no persistent connection/transporter object needed,
// which fits the Workers fetch-per-request model better than SMTP ever did.
//
// Delivery is retried, because the failures that actually happen are
// transient: Resend rate-limits at roughly 2 requests/second (a burst — a
// queue-failure alert storm, a signup spike — trips a 429 that succeeds a
// moment later), and a 5xx or a network blip is over almost as soon as it
// starts. Permanent errors (any other 4xx: bad address, unverified domain,
// invalid key) are NOT retried — repeating them can't help and only delays the
// failure being reported.
//
// Every attempt carries the same Idempotency-Key, so if a timeout hides a
// request that Resend did in fact accept, the retry can never send the same
// email twice.

const DEFAULT_RETRY_DELAYS_MS = [500, 1500]
const ATTEMPT_TIMEOUT_MS = 10_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Seconds → ms from a Retry-After header, capped so a hostile/huge value can't
// stall the request; null when absent/unparseable.
function retryAfterMs(res) {
  const raw = res.headers && res.headers.get && res.headers.get('retry-after')
  const secs = Number(raw)
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, 5000) : null
}

async function sendViaResend(env, { from, to, subject, html, text }, { retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {}) {
  const idempotencyKey = crypto.randomUUID()
  let lastErr

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    let waitMs = retryDelaysMs[attempt]
    let retryable = true
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization':   `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type':    'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify({ from, to, subject, html, ...(text ? { text } : {}) }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
      })
      if (res.ok) return res.json()

      const body = await res.text().catch(() => '')
      lastErr = new Error(`Resend API error (${res.status}): ${body}`)
      lastErr.status = res.status
      retryable = res.status === 429 || res.status >= 500
      const hinted = retryAfterMs(res)
      if (hinted !== null) waitMs = Math.max(waitMs ?? 0, hinted)
    } catch (err) {
      // Network failure / timeout: retryable.
      lastErr = err
    }
    if (!retryable || attempt === retryDelaysMs.length) break
    await sleep(waitMs)
  }
  throw lastErr
}

module.exports = { sendViaResend }
