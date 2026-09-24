// Signed, stateless links for the two things an employer lead can do from the
// email we send them: CONFIRM that the address is theirs, and REMOVE it.
//
// Stateless on purpose. The lead form is public and the address on it is
// whatever a stranger typed, so the proof that "this click came from the
// inbox owner" has to survive the lead being deleted, re-created or purged —
// a stored random token would not (delete the row and the removal link in an
// old email stops working, which is exactly when a person most needs it).
// Instead the token is the address itself plus an HMAC over
// `purpose + address` keyed with JWT_SECRET:
//
//   token = base64url(email) + '.' + base64url(HMAC-SHA256(secret, "employer-lead:<purpose>:<email>"))
//
// The purpose is part of the MAC input, so a confirm link can never be
// replayed as a removal link (or the reverse). Nothing here expires: a
// removal link must keep working for as long as the email exists, and a
// confirm link only ever sets a timestamp.

const enc = new TextEncoder()
const dec = new TextDecoder()

const PURPOSES = ['confirm', 'remove']
const MAX_EMAIL_LENGTH = 254   // same bound the lead form enforces

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4)
  const bin = atob(padded)
  return Uint8Array.from(bin, ch => ch.charCodeAt(0))
}

async function mac(secret, purpose, email) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`employer-lead:${purpose}:${email}`))
  return b64url(sig)
}

// Constant-time string comparison (both sides are fixed-length base64url).
function safeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function signLeadToken(secret, purpose, email) {
  if (!secret) throw new Error('JWT_SECRET is not configured — cannot sign an employer-lead link.')
  if (!PURPOSES.includes(purpose)) throw new Error(`Unknown employer-lead link purpose: ${purpose}`)
  const normalized = String(email).trim().toLowerCase()
  return `${b64url(enc.encode(normalized))}.${await mac(secret, purpose, normalized)}`
}

// Returns the (lowercased) address the token was issued for, or null for
// anything that is not a genuine, matching-purpose token.
async function verifyLeadToken(secret, purpose, token) {
  try {
    if (!secret || !PURPOSES.includes(purpose) || typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null
    const email = dec.decode(fromB64url(parts[0]))
    if (!email || email.length > MAX_EMAIL_LENGTH || email !== email.trim().toLowerCase()) return null
    return safeEqual(parts[1], await mac(secret, purpose, email)) ? email : null
  } catch (_) {
    return null   // malformed base64 / bad UTF-8
  }
}

module.exports = { signLeadToken, verifyLeadToken, PURPOSES }
