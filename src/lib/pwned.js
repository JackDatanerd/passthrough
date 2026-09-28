// Breached-password check via the Have I Been Pwned "range" API (k-anonymity).
//
// Only the first 5 hex characters of the password's SHA-1 ever leave the
// Worker; HIBP answers with every known suffix in that bucket and the match is
// made here, so neither the password nor its full hash is disclosed. Requests
// carry `Add-Padding` so the response size doesn't reveal whether a hit exists.
//
// FAILS OPEN: a slow or unreachable HIBP must never stop someone registering or
// resetting a password. The local deny-list (validatePassword) is the floor;
// this is a best-effort raise of it. Set PWNED_PASSWORDS_CHECK=off to disable.

const { sha1Hex } = require('./crypto')

const RANGE_URL  = 'https://api.pwnedpasswords.com/range/'
const TIMEOUT_MS = 2000
// Padding rows come back with a count of 0; a genuine breach hit is >= 1.
const MIN_BREACH_COUNT = 1

/** pwnedCount(password, env) -> number of breaches seen (0 = clean), or null if the check couldn't run. */
async function pwnedCount(password, env, fetchImpl = fetch) {
  if (env && env.PWNED_PASSWORDS_CHECK === 'off') return null
  try {
    const hash   = await sha1Hex(password)
    const prefix = hash.slice(0, 5)
    const suffix = hash.slice(5)
    const res = await fetchImpl(RANGE_URL + prefix, {
      headers: { 'Add-Padding': 'true' },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    for (const line of (await res.text()).split('\n')) {
      const [candidate, count] = line.trim().split(':')
      if (candidate === suffix) return Number.parseInt(count, 10) || 0
    }
    return 0
  } catch {
    return null
  }
}

/** true only when HIBP positively reports this password in a breach. */
async function isPwnedPassword(password, env, fetchImpl) {
  const n = await pwnedCount(password, env, fetchImpl)
  return n !== null && n >= MIN_BREACH_COUNT
}

module.exports = { pwnedCount, isPwnedPassword, MIN_BREACH_COUNT }
