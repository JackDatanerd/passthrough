// Experts Phase 2A: hashing and random values for the realm. Web Crypto only (the Worker has no Node crypto). Nothing here logs.
const enc = new TextEncoder()
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)))
}
const sha256Hex = async text => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)))
const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

// Recovery codes: 10 characters from an alphabet with no look-alikes (about 50 bits each), shown as xxxxx-xxxxx, stored only as keyed hashes.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
function newRecoveryCode() {
  const r = crypto.getRandomValues(new Uint8Array(10)); let s = ''
  for (const b of r) s += ALPHABET[b % ALPHABET.length]
  return `${s.slice(0, 5)}-${s.slice(5)}`
}
const normalizeRecovery = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const recoveryHash = (secret, expertId, code) => hmacHex(secret, `recovery:${expertId}:${normalizeRecovery(code)}`)
const tokenHash = (secret, token) => hmacHex(secret, `token:${token}`)
const ipHash = (secret, ip) => hmacHex(secret, `ip:${ip || ''}`).then(h => h.slice(0, 32))

// Constant-time string compare for secrets of equal length.
function safeEqual(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0 }

module.exports = { hmacHex, sha256Hex, randomToken, newRecoveryCode, normalizeRecovery, recoveryHash, tokenHash, ipHash, safeEqual }
