// Hand-rolled HS256 JWT using Web Crypto (crypto.subtle) — Workers expose
// this globally, no import needed. Replaces `jsonwebtoken`.
// Payload shape is identical to v8: { userId, tokenVersion, iat, exp }.

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

/**
 * verify(token, secret) -> payload object
 * Throws on invalid signature OR expiry — caller catches and maps to 401,
 * same as v8's `jwt.verify` throwing TokenExpiredError / JsonWebTokenError.
 */
async function verify(token, secret) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed token')
  const [headerB64, payloadB64, sigB64] = parts

  const key = await hmacKey(secret)
  const valid = await crypto.subtle.verify(
    'HMAC', key,
    base64urlToBytes(sigB64),
    utf8ToBytes(`${headerB64}.${payloadB64}`)
  )
  if (!valid) {
    const err = new Error('Invalid signature')
    err.name = 'JsonWebTokenError'
    throw err
  }

  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)))
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp && now > payload.exp) {
    const err = new Error('Token expired')
    err.name = 'TokenExpiredError'
    throw err
  }
  return payload
}

module.exports = { sign, verify }
