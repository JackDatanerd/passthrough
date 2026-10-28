'use strict'

// RFC 6238 time-based one-time codes (HMAC-SHA1, 6 digits, 30 s) on Web Crypto, for the pilot experts' second factor.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Encode(bytes) {
  let bits = 0, value = 0, out = ''
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0, value = 0; const out = []
  for (const ch of clean) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32')
    value = (value << 5) | i; bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return new Uint8Array(out)
}
const newSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)))

async function hotp(secretB32, counter, digits = 6) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const msg = new Uint8Array(8); let c = counter
  for (let i = 7; i >= 0; i--) { msg[i] = c % 256; c = Math.floor(c / 256) }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
  const o = h[h.length - 1] & 15
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}
const stepOf = (nowMs, period = 30) => Math.floor(nowMs / 1000 / period)

// -> the accepted time step (a number) or null. `lastStep` (the last step already used by this account) makes a code single use:
// a step <= lastStep is refused even when the digits are right. Window +/- 1 step for clock drift.
async function verifyTotp(secretB32, code, { nowMs = Date.now(), lastStep = null, window = 1 } = {}) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return null
  const cur = stepOf(nowMs), want = String(code).trim()
  for (let d = -window; d <= window; d++) {
    const step = cur + d
    if (lastStep != null && step <= lastStep) continue
    if (timingSafeEq(await hotp(secretB32, step), want)) return step
  }
  return null
}
function timingSafeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0 }
const otpauthUrl = (secret, account, issuer = 'Passthrough Experts') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`

module.exports = { base32Encode, base32Decode, newSecret, hotp, stepOf, verifyTotp, otpauthUrl }
