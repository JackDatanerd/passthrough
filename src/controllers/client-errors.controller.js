// POST /api/client-errors — public, fire-and-forget. The SPA reports a page that crashed in someone's browser (a render
// error caught by the error boundary, an uncaught error, an unhandled promise rejection, a lazy chunk that would not load).
//
// Why it exists: every other failure in the app reaches the owner (sendOwnerAlert -> alert_logs, which Admin > System health
// reads), but a crash in the browser was only ever a console.error on the visitor's own machine — a broken ScanResult page
// right after a payment was invisible until someone complained.
//
// This endpoint is public, so it is built to be harmless when abused:
//   - per-IP rate limit (rl.clientError) and the global body cap, plus a hard clip on every field (lib/clientError.js);
//   - everything is scrubbed of credentials / addresses before it is stored or mailed, and is shown as text only;
//   - one alert per distinct error per day (fingerprint), and a global ceiling of alerts per hour — so neither a bad deploy
//     (thousands of visitors, one bug) nor a script posting random text can flood the owner's inbox or alert_logs;
//   - without a quota backend nothing is mailed at all (only logged): the de-dupe cannot be trusted there.
// A report that is dropped is still logged (Workers Logs), and the answer is always the same quick 200 so a client never
// retries or learns which limit it hit.

const rateLimiter = require('../middleware/rateLimiter')
const { runInBackground } = require('../lib/background')
const { sha256 } = require('../lib/crypto')
const { sanitizeReport, fingerprintInput, formatAlert } = require('../lib/clientError')

const PER_ERROR_WINDOW_SECONDS = 24 * 60 * 60
const GLOBAL_ALERTS_PER_HOUR = 10
// A real report is a few KB (every field is clipped). Anything declared larger is refused before it is read.
const MAX_BODY_BYTES = 16 * 1024

async function reportClientError(c) {
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.json({ success: false, message: 'Report too large.' }, 413)
  let body
  try { body = await c.req.json() } catch (_) { return c.json({ success: false, message: 'Invalid report.' }, 400) }

  const report = sanitizeReport(body)
  if (!report) return c.json({ success: false, message: 'Nothing to report.' }, 400)

  // Always visible in Workers Logs, whatever the alert gate decides below.
  console.error(`[client-error] ${report.kind} ${report.path}: ${report.message.split('\n')[0].slice(0, 200)}`)

  try {
    if (!(c.env.RATE_LIMIT_DO || c.env.RATE_LIMIT_KV)) return c.json({ success: true })
    const fp = (await sha256(fingerprintInput(report))).slice(0, 32)
    // Same error already reported today: nothing more to tell the owner.
    if (!(await rateLimiter.hitQuota(c.env, `rl:clienterr:${fp}`, 1, PER_ERROR_WINDOW_SECONDS))) return c.json({ success: true })
    // Ceiling on distinct alerts, so a stream of made-up errors costs at most this many emails / rows an hour.
    if (!(await rateLimiter.hitQuota(c.env, 'rl:clienterr:all', GLOBAL_ALERTS_PER_HOUR, 60 * 60))) {
      console.error('[client-error] hourly alert ceiling reached — report logged only')
      return c.json({ success: true })
    }
    const email = require('../services/email.service')
    runInBackground(c, email.sendOwnerAlert(c.env, `Frontend error: ${report.kind} on ${report.path}`, formatAlert(report),
      { dedupeKey: `clienterr:${fp}` }))
  } catch (err) {
    console.error('[client-error] alert failed:', err.message)
  }
  return c.json({ success: true })
}

module.exports = { reportClientError, GLOBAL_ALERTS_PER_HOUR, MAX_BODY_BYTES }
