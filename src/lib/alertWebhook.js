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

// VERIFY ROUND 11 (bug): an alert body can carry text a STRANGER typed (the public "report this page" note, a
// lead's name, an error message that echoes a request). The e-mail copy is HTML-escaped, but this copy went out raw,
// and a chat webhook treats raw text as markup: Slack's `<!channel>` / `<!here>` / `<@U…>` ping people and
// `<https://evil|Passthrough sign-in>` renders a link with any label; Discord's `@everyone` / `@here` / `<@&role>`
// ping and `[label](url)` makes a masked link; Mattermost's `@channel` / `@all` ping. Anyone could therefore page the
// whole operations channel, or plant a trusted-looking link in it, with one anonymous POST.
// One neutralisation serves every platform (the same text goes out as `text` and `content`): a zero-width space after
// `<` breaks every angle-bracket token, after `@` in a broadcast mention breaks that, and between `]` and `(` breaks a
// masked link. The text still reads the same to a person. Discord is additionally told to parse no mentions at all.
const ZWSP = '\u200b'
function neutralizeChatMarkup(input) {
  return String(input == null ? '' : input)
    .replace(/</g, `<${ZWSP}`)
    .replace(/@(?=(?:everyone|here|channel|all)\b)/gi, `@${ZWSP}`)
    .replace(/\]\(/g, `]${ZWSP}(`)
}

// -> true when the webhook answered 2xx, false when it is unset, unusable or failed.
async function postAlertWebhook(env, subject, message) {
  const url = webhookUrl(env)
  if (!url) return false
  // Neutralised BEFORE truncating, so the cut can never be what leaves a token whole.
  let text = neutralizeChatMarkup(`[Passthrough Alert] ${subject}\n\n${message}`)
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 1)}…`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is Slack/Teams/Mattermost, `content` is Discord; extra keys are ignored by both.
      body: JSON.stringify({ text, content: text, allowed_mentions: { parse: [] }, subject: neutralizeChatMarkup(subject), message: neutralizeChatMarkup(message) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) { console.error(`Alert webhook answered ${res.status}`); return false }
    return true
  } catch (err) {
    console.error('Alert webhook failed:', err.message)
    return false
  }
}

module.exports = { webhookUrl, postAlertWebhook, neutralizeChatMarkup }
