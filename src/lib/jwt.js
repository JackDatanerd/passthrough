// Hand-rolled HS256 JWT using Web Crypto (crypto.subtle) — Workers expose
// this globally, no import needed. Replaces `jsonwebtoken`.
// Payload shape: { userId, tokenVersion, sid?, iat, exp } — `sid` (added with
// server-side sessions, migration 0047) is absent on tokens issued before it.

function base64url(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  const bin = atob(str)
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

function utf8ToBytes(str) {
  return new TextEncoder().encode(str)
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', utf8ToBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  )
}

/**
 * sign({ userId, tokenVersion }, secret, expiresInSeconds) -> token string
 */
async function sign(payload, secret, expiresInSeconds) {
  // A NaN/undefined lifetime used to serialize as `"exp":null` — a token that
  // verify() then treated as never-expiring. Refuse to mint one.
  if (typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds))
    throw new TypeError('sign(): expiresInSeconds must be a finite number')
  const header = { alg: 'HS256', typ: 'JWT' }
  const now    = Math.floor(Date.now() / 1000)
  const body   = { ...payload, iat: now, exp: now + expiresInSeconds }

  const headerB64  = base64url(utf8ToBytes(JSON.stringify(header)))
  const payloadB64 = base64url(utf8ToBytes(JSON.stringify(body)))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, utf8ToBytes(signingInput))
  const sigB64 = base64url(sig)

  return `${signingInput}.${sigB64}`
}

function invalid(message) {
  const err = new Error(message)
  err.name = 'JsonWebTokenError'
  return err
}

// Decode one base64url JSON segment; it must be a plain JSON object.
function parseSegment(b64, what) {
  let value
  try {
    value = JSON.parse(new TextDecoder().decode(base64urlToBytes(b64)))
  } catch {
    throw invalid(`Malformed token ${what}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`Malformed token ${what}`)
  return value
}

/**
 * verify(token, secret) -> payload object
 * Throws on invalid signature, unsupported algorithm, missing/invalid `exp`, or
 * expiry — the caller catches and maps to 401 (TokenExpiredError vs the rest).
 *
 * AUDIT FIX (Auth section round 1): verify() used to accept a token whose
 * signature was valid but whose payload had no `exp` (or a non-numeric one) as
 * never-expiring, and never looked at the header at all. Not exploitable
 * without the signing secret, but a token that cannot expire has no business
 * verifying, and the algorithm we accept should be pinned rather than assumed.
 */
async function verify(token, secret) {
  if (typeof token !== 'string') throw invalid('Malformed token')
  const parts = token.split('.')
  if (parts.length !== 3) throw invalid('Malformed token')
  const [headerB64, payloadB64, sigB64] = parts

  let sigBytes
  try {
    sigBytes = base64urlToBytes(sigB64)
  } catch {
    throw invalid('Malformed token signature')
  }

  const key = await hmacKey(secret)
  const valid = await crypto.subtle.verify(
    'HMAC', key,
    sigBytes,
    utf8ToBytes(`${headerB64}.${payloadB64}`)
  )
  if (!valid) throw invalid('Invalid signature')

  // Only parse the (now authenticated) header/payload after the signature holds.
  const header = parseSegment(headerB64, 'header')
  if (header.alg !== 'HS256') throw invalid('Unsupported algorithm')

  const payload = parseSegment(payloadB64, 'payload')
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp))
    throw invalid('Token has no valid expiry')

  const now = Math.floor(Date.now() / 1000)
  if (now > payload.exp) {
    const err = new Error('Token expired')
    err.name = 'TokenExpiredError'
    throw err
  }
  return payload
}

module.exports = { sign, verify }
