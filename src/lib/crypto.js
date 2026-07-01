// Web Crypto helpers — replaces Node's `crypto` module usage throughout v8.
// All functions are globally available in Workers with zero import (crypto.subtle,
// crypto.getRandomValues), so this file just wraps them with the same call
// signatures the rest of the codebase expects.

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * randomToken(byteLength) -> hex string
 * Replaces: crypto.randomBytes(32).toString('hex')
 */
function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/**
 * sha256(text) -> hex string
 * Replaces: crypto.createHash('sha256').update(text).digest('hex')
 */
async function sha256(text) {
  const data = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(hash)
}

/**
 * sha256Bytes(arrayBufferOrUint8Array) -> hex string
 * Same as sha256() but for binary data (DOCX file bytes) instead of a string.
 * Replaces: crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex')
 */
async function sha256Bytes(data) {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(hash)
}

/**
 * hmacSha512Hex(secret, bodyText) -> hex string
 * Replaces: crypto.createHmac('sha512', secret).update(body).digest('hex')
 * Used for Paystack webhook signature verification.
 */
async function hmacSha512Hex(secret, bodyText) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText))
  return bytesToHex(sig)
}

/**
 * randomShortCode(length, alphabet) -> string
 * Replaces: crypto.randomInt(0, alphabet.length) loop in badge.service.js
 */
function randomShortCode(length, alphabet) {
  const values = new Uint32Array(length)
  crypto.getRandomValues(values)
  let code = ''
  for (let i = 0; i < length; i++) code += alphabet[values[i] % alphabet.length]
  return code
}

/**
 * uuid() -> v4 UUID string
 * Replaces: uuidv4() from the 'uuid' package — Workers expose crypto.randomUUID() natively.
 */
function uuid() {
  return crypto.randomUUID()
}

module.exports = { randomToken, sha256, sha256Bytes, hmacSha512Hex, randomShortCode, uuid }
