// Verifies a Svix-signed webhook (what Resend uses to sign its bounce / complaint / delivery
// events): https://docs.svix.com/receiving/verifying-payloads/how-manual
//
//   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
//   signature      = base64(HMAC-SHA256(base64decode(secret without "whsec_"), signed content))
//   `svix-signature` is a space-separated list of `v1,<signature>` (several while a secret rotates).
//
// The timestamp is checked against a tolerance so a captured request cannot be replayed later.
const { timingSafeEqual } = require('./crypto')

const enc = new TextEncoder()
const DEFAULT_TOLERANCE_SECONDS = 5 * 60

function base64ToBytes(b64) {
  const bin = atob(b64)
  return Uint8Array.from(bin, ch => ch.charCodeAt(0))
}

function bytesToBase64(bytes) {
  let bin = ''
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function verifySvixSignature({ secret, id, timestamp, signature, body, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, nowMs = Date.now() }) {
  if (!secret || !id || !timestamp || !signature || typeof body !== 'string') return false
  const ts = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(ts) || String(ts) !== String(timestamp).trim()) return false
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false

  let keyBytes
  try { keyBytes = base64ToBytes(String(secret).replace(/^whsec_/, '')) } catch (_) { return false }
  if (!keyBytes.length) return false

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = bytesToBase64(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`)))

  let ok = false
  for (const part of String(signature).split(' ')) {
    const [version, sig] = part.split(',')
    // No early exit: every candidate is compared, whatever matched before.
    if (version === 'v1' && timingSafeEqual(expected, sig || '')) ok = true
  }
  return ok
}

module.exports = { verifySvixSignature }
