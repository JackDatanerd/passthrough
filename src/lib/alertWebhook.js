// Optional out-of-band channel for owner alerts. AUDIT FIX (Cross-cutting infra round 4, G2): every owner
// alert went through Resend — the same provider whose outage, exhausted quota or bad key is one of the things
// an alert most needs to report. `ALERT_WEBHOOK_URL` (a Slack / Discord / Teams / ntfy-style incoming-webhook
// URL, set as a secret because the URL is the credential) gets the same alert over a path that shares nothing
// with email. Unset = no change. Never throws.

const TIMEOUT_MS = 5000
const MAX_TEXT = 1800   // under Discord's 2000-character limit

function webhookUrl(env) {
  const raw = env && env.ALERT_WEBHOOK_URL ? String(env.ALERT_WEBHOOK_URL).trim() : ''
  if (!raw) return null
  try { const u = new URL(raw); return u.protocol === 'https:' ? u.toString() : null } catch { return null }
}

// -> true when the webhook answered 2xx, false when it is unset, unusable or failed.
async function postAlertWebhook(env, subject, message) {
  const url = webhookUrl(env)
  if (!url) return false
  let text = `[Passthrough Alert] ${subject}\n\n${message}`
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 1)}…`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is Slack/Teams/Mattermost, `content` is Discord; extra keys are ignored by both.
      body: JSON.stringify({ text, content: text, subject, message }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) { console.error(`Alert webhook answered ${res.status}`); return false }
    return true
  } catch (err) {
    console.error('Alert webhook failed:', err.message)
    return false
  }
}

module.exports = { webhookUrl, postAlertWebhook }
