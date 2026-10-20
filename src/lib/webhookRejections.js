// Webhooks round 17 (G1): rejected deliveries used to leave no durable trace. A request that failed the signature check,
// the IP allow-list or the size cap was logged and (at most once per 30 minutes) emailed — nothing was stored, so Admin →
// Webhooks could not say "Paystack IS reaching you but every delivery is being refused". A rotated or wrong signing key is the
// most likely real-world webhook outage, and until now it only showed up indirectly (a paid sale with no event on record).
//
// One system_state row per provider (no migration: the table exists and Resend's stamp already uses it). Written at most once a
// minute per provider through the same atomic quota the alerts use, so a flood of junk requests cannot become a flood of writes.
// Never stores the source IP or any request content. Best-effort: never allowed to affect the HTTP answer.
const { hitQuota } = require('../middleware/rateLimiter')

const KEY_PREFIX = 'webhook_rejected:'
// Webhooks round 18 (B1): the newest refusal of ANY kind used to overwrite the one stamp, so a scanner's 'unsigned' request (routine on a
// public URL) replaced a real provider's 'signature' refusal and the admin notice never showed. Flagged refusals now have their own stamp
// (and their own once-a-minute quota) that unflagged ones can never touch.
const FLAGGED_KEY_PREFIX = 'webhook_rejected_flagged:'
const PROVIDERS = ['paystack', 'resend']
// 'signature' / 'ip' are rejections of requests that LOOK like the provider (signature headers present, well-formed); the rest are
// kept for context but are also what internet scanners produce, so they never raise the admin warning on their own.
const REASONS = ['signature', 'ip', 'unsigned', 'too-large', 'not-configured', 'unreadable']
const FLAGGED_REASONS = new Set(['signature', 'ip', 'not-configured'])
const STAMP_WINDOW_SECONDS = 60
const FLAG_WINDOW_MS = 7 * 24 * 3600 * 1000
// Webhooks round 24 (B3): Paystack's "last delivery that got through" is read from the inbox and is exact. Resend's is a system_state stamp the
// handler writes at most once per RESEND_STAMP_WINDOW_SECONDS (a verified delivery inside the window leaves the stamp behind). A refusal newer
// than the stamp could therefore sit BEHIND a delivery that did get through, and the notice said "nothing has got through since". For Resend a
// refusal only counts once it is newer than the stamp by more than the window: a genuine outage shows after at most that long (the refusal
// stamp keeps moving), a stale stamp can no longer raise a false one.
const RESEND_STAMP_WINDOW_SECONDS = 10 * 60
const STAMP_LAG_MS = { resend: RESEND_STAMP_WINDOW_SECONDS * 1000 }

// Paystack: x-paystack-signature is a 128-char hex HMAC-SHA512. Anything else is not a Paystack delivery.
const looksLikePaystackSignature = sig => /^[0-9a-f]{128}$/i.test(String(sig || '').trim())
// Resend/Svix: all three svix-* headers present.
// Webhooks round 21 (B2): "has the headers" let ANY request with a made-up 128-hex signature (or three arbitrary svix-* values) raise the
// admin "deliveries are being refused" notice, which stays up until the next real delivery. A signature cannot prove who sent it - a wrong
// key and a forged one fail identically - so the shape is checked harder instead: a real Svix delivery has an msg_ id, an epoch-seconds
// timestamp and a `v1,<base64>` signature; a real Paystack delivery has a JSON body with a string `event` and an object `data`.
const looksLikeSvixDelivery = headers => !!(headers && typeof headers.id === 'string' && /^msg_\w+$/.test(headers.id.trim())
  && /^\d{9,11}$/.test(String(headers.timestamp || '').trim())
  && /(^|\s)v1,[A-Za-z0-9+/]{20,}={0,2}(\s|$)/.test(String(headers.signature || '')))
function looksLikePaystackEvent(bytes) {
  try {
    const e = JSON.parse(new TextDecoder().decode(bytes))
    return !!e && typeof e.event === 'string' && !!e.data && typeof e.data === 'object'
  } catch (_) { return false }
}

async function recordRejection(env, provider, reason, supabase) {   // `supabase`: the caller's client (this module holds no config of its own)
  try {
    if (!PROVIDERS.includes(provider)) return false
    const why = REASONS.includes(reason) ? reason : 'signature'
    const flagged = FLAGGED_REASONS.has(why)
    if (!(await hitQuota(env, `webhook-reject-stamp${flagged ? '-flagged' : ''}:${provider}`, 1, STAMP_WINDOW_SECONDS))) return false
    const at = new Date().toISOString()
    const { error } = await supabase.from('system_state')
      .upsert({ key: (flagged ? FLAGGED_KEY_PREFIX : KEY_PREFIX) + provider, value: { last_at: at, last_reason: why }, updated_at: at }, { onConflict: 'key' })
    if (error) throw error
    return true
  } catch (err) {
    console.error('webhook rejection stamp failed:', err && err.message)
    return false
  }
}

// { paystack: { at, reason } | null, resend: { at, reason } | null }. Never throws (a missing row/table reads as "none").
// A provider's FLAGGED refusal (signature / ip / not-configured) wins over an unflagged one whenever both exist: the flagged one is what
// the admin notice is about, and scanner-shaped refusals must not be able to hide it. (Round 18, B1.)
async function readRejections(supabase) {
  const out = { paystack: null, resend: null }
  try {
    const keys = PROVIDERS.flatMap(p => [KEY_PREFIX + p, FLAGGED_KEY_PREFIX + p])
    const { data, error } = await supabase.from('system_state').select('key, value').in('key', keys)
    if (error) throw error
    const plain = {}, flagged = {}
    for (const row of data || []) {
      const key = String(row.key || '')
      const isFlagged = key.startsWith(FLAGGED_KEY_PREFIX)
      const provider = key.slice((isFlagged ? FLAGGED_KEY_PREFIX : KEY_PREFIX).length)
      if (!PROVIDERS.includes(provider)) continue
      const at = row.value && typeof row.value.last_at === 'string' ? row.value.last_at : null
      if (at && Number.isFinite(Date.parse(at))) (isFlagged ? flagged : plain)[provider] = { at, reason: row.value.last_reason || 'signature' }
    }
    for (const provider of PROVIDERS) out[provider] = flagged[provider] || plain[provider] || null
  } catch (err) { console.error('webhook rejection read failed:', err && err.message) }
  return out
}

// Providers whose latest FLAGGED refusal is newer than the last delivery they got through (or that never got one through),
// within the last 7 days. That is the case worth an admin's attention: refusals with nothing accepted since.
function rejectedSinceLastEvent(rejections, lastAcceptedAt, now = Date.now()) {
  const out = []
  for (const provider of PROVIDERS) {
    const r = rejections && rejections[provider]
    if (!r || !FLAGGED_REASONS.has(r.reason)) continue
    const at = Date.parse(r.at)
    if (!Number.isFinite(at) || now - at > FLAG_WINDOW_MS) continue
    const ok = Date.parse((lastAcceptedAt || {})[provider])
    if (Number.isFinite(ok) && ok + (STAMP_LAG_MS[provider] || 0) >= at) continue
    out.push(provider)
  }
  return out
}

module.exports = { RESEND_STAMP_WINDOW_SECONDS, recordRejection, readRejections, rejectedSinceLastEvent, looksLikePaystackSignature, looksLikePaystackEvent, looksLikeSvixDelivery, KEY_PREFIX, FLAGGED_KEY_PREFIX, REASONS }
