// The rate-limit / lockout / miss-counter ALGORITHMS, written against a tiny
// `store` interface — { get(key) -> string|null, put(key, value, { expirationTtl }),
// delete(key) } — so the exact same code runs in two places:
//
//   * inside the RateLimiterDO Durable Object (src/lib/rateLimiterDO.js), where
//     every operation on one key is serialized, so a read-modify-write is ATOMIC;
//   * against a Workers KV namespace (the fallback when no RATE_LIMIT_DO binding
//     exists — local dev, tests), where it is the old best-effort get-then-put.
//
// Why a Durable Object: KV is the wrong primitive for counting. Two requests in
// the same instant both read count=N and both write N+1, and KV additionally
// rejects more than one write per second to a key with a 429 — which the limiter
// used to treat as an outage and fail OPEN on. Fifty parallel login guesses
// against a limit of ten all got through, and forty parallel failures recorded a
// failure count of 1 (the account never locked). See DEPLOYMENT.md.
//
// Pure logic, no I/O of its own, no dependencies — safe to bundle into the DO.

const LOCKOUT_MAX_CONSECUTIVE_FAILURES = 8
const LOCKOUT_MINUTES = 15
const LOCKOUT_MIN_DISTINCT_IPS = 2
const LOCKOUT_MAX_TRACKED_IPS = 10
const VERIFY_MISS_WINDOW_SECONDS = 15 * 60

// Fixed-window counter. windowStart is set once, on the first request of the
// window and never moves; each later request increments `count` and re-derives
// the REMAINING ttl from that original windowStart. (Re-arming the TTL on every
// request would let a client that keeps polling ratchet up to the cap and stay
// locked out forever.) KV needs expirationTtl >= 60s, so the TTL is floored; the
// elapsed-time check on read is what actually rolls the window over on time.
async function consumeSlot(store, key, windowSeconds, max, now = Date.now()) {
  const raw = await store.get(key)
  let count = 0
  let windowStart = now
  let refunds = 0
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.count === 'number' && typeof parsed.windowStart === 'number') {
        count = parsed.count
        windowStart = parsed.windowStart
        refunds = typeof parsed.refunds === 'number' ? parsed.refunds : 0
      }
    } catch (_) { /* corrupt value -> fresh window */ }
  }

  let elapsedSeconds = (now - windowStart) / 1000
  if (elapsedSeconds >= windowSeconds) {
    count = 0
    windowStart = now
    refunds = 0
    elapsedSeconds = 0
  }

  if (count >= max) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(windowSeconds - elapsedSeconds)) }
  }

  const remainingTtl = Math.max(Math.ceil(windowSeconds - elapsedSeconds), 60)
  await store.put(key, JSON.stringify({ count: count + 1, windowStart, refunds }), { expirationTtl: remainingTtl })
  return { allowed: true, retryAfter: 0 }
}

// Give back one slot for a request that was counted but then failed. Bounded by
// `maxRefunds` per window so "failures don't count" can never become "unlimited
// free attempts".
async function refundSlot(store, key, windowSeconds, maxRefunds, now = Date.now()) {
  const raw = await store.get(key)
  if (!raw) return { refunded: false }
  let st
  try { st = JSON.parse(raw) } catch (_) { return { refunded: false } }
  if (typeof st.count !== 'number' || typeof st.windowStart !== 'number' || st.count <= 0) return { refunded: false }
  const refunds = typeof st.refunds === 'number' ? st.refunds : 0
  if (refunds >= maxRefunds) return { refunded: false }
  const elapsedSeconds = (now - st.windowStart) / 1000
  if (elapsedSeconds >= windowSeconds) return { refunded: false }
  await store.put(key, JSON.stringify({ count: st.count - 1, windowStart: st.windowStart, refunds: refunds + 1 }), {
    expirationTtl: Math.max(Math.ceil(windowSeconds - elapsedSeconds), 60)
  })
  return { refunded: true }
}

async function lockoutCheck(store, key, now = Date.now()) {
  const raw = await store.get(key)
  if (!raw) return { locked: false, retryAfterSeconds: null }
  let parsed
  try { parsed = JSON.parse(raw) } catch (_) { return { locked: false, retryAfterSeconds: null } }
  if (parsed.lockedUntil && parsed.lockedUntil > now) {
    return { locked: true, retryAfterSeconds: Math.ceil((parsed.lockedUntil - now) / 1000) }
  }
  return { locked: false, retryAfterSeconds: null }
}

// `ip` is already normalised by the caller (rateKeyIp). Locks once BOTH
// LOCKOUT_MAX_CONSECUTIVE_FAILURES is reached AND the failures span at least
// `minDistinctIps` distinct clients (1 for the authenticated password checks).
async function lockoutFail(store, key, ip, minDistinctIps = LOCKOUT_MIN_DISTINCT_IPS, now = Date.now()) {
  const raw = await store.get(key)
  let failCount = 0
  let ips = []
  let wasLocked = false
  let activeLockedUntil = null
  try {
    if (raw) {
      const parsed = JSON.parse(raw)
      failCount = parsed.failCount || 0
      ips = Array.isArray(parsed.ips) ? parsed.ips : []
      wasLocked = !!(parsed.lockedUntil && parsed.lockedUntil > now)
      if (wasLocked) activeLockedUntil = parsed.lockedUntil
      // A lock that already ran its course is stale history, not an ongoing
      // attack: count from zero so the distinct-client bar must be cleared again.
      if (parsed.lockedUntil && parsed.lockedUntil <= now) { failCount = 0; ips = [] }
    }
  } catch (_) { failCount = 0; ips = []; wasLocked = false; activeLockedUntil = null }
  failCount += 1

  if (!ips.includes(ip)) ips.push(ip)
  if (ips.length > LOCKOUT_MAX_TRACKED_IPS) ips = ips.slice(ips.length - LOCKOUT_MAX_TRACKED_IPS)

  // AUDIT FIX (Auth round 6, B3): a failure that lands while a lock is ALREADY running (only a request from
  // the owner's own network can reach this — everyone else is refused before it) used to re-arm the full
  // window, so anyone sharing that network could keep the account locked for every other network forever.
  // A running lock keeps its original end.
  const lockedUntil = activeLockedUntil
    ? activeLockedUntil
    : (failCount >= LOCKOUT_MAX_CONSECUTIVE_FAILURES && ips.length >= minDistinctIps)
      ? now + LOCKOUT_MINUTES * 60 * 1000
      : null

  await store.put(key, JSON.stringify({ failCount, ips, lockedUntil }), {
    expirationTtl: Math.max(LOCKOUT_MINUTES * 60, 60)
  })
  return { justLocked: !!lockedUntil && !wasLocked }
}

async function lockoutClear(store, key) {
  await store.delete(key)
  return { ok: true }
}

async function missRead(store, key, max, now = Date.now()) {
  const raw = await store.get(key)
  if (!raw) return { count: 0, limited: false }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.count === 'number' && typeof parsed.windowStart === 'number'
        && (now - parsed.windowStart) / 1000 < VERIFY_MISS_WINDOW_SECONDS)
      return { count: parsed.count, limited: parsed.count >= max }
  } catch (_) { /* corrupt value -> fresh window */ }
  return { count: 0, limited: false }
}

async function missRecord(store, key, now = Date.now()) {
  let cur = { count: 0, windowStart: now }
  const raw = await store.get(key)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.count === 'number' && typeof parsed.windowStart === 'number'
          && (now - parsed.windowStart) / 1000 < VERIFY_MISS_WINDOW_SECONDS) cur = parsed
    } catch (_) { /* fresh window */ }
  }
  const remaining = Math.max(Math.ceil(VERIFY_MISS_WINDOW_SECONDS - (now - cur.windowStart) / 1000), 60)
  await store.put(key, JSON.stringify({ count: cur.count + 1, windowStart: cur.windowStart }), { expirationTtl: remaining })
  return { ok: true }
}

// Operation table shared by the DO and the KV fallback: { op: (store, args) => Promise }.
const OPS = {
  consume:      (s, a) => consumeSlot(s, a.key, a.windowSeconds, a.max, a.now),
  refund:       (s, a) => refundSlot(s, a.key, a.windowSeconds, a.maxRefunds, a.now),
  lockoutCheck: (s, a) => lockoutCheck(s, a.key, a.now),
  lockoutFail:  (s, a) => lockoutFail(s, a.key, a.ip, a.minDistinctIps, a.now),
  lockoutClear: (s, a) => lockoutClear(s, a.key),
  missRead:     (s, a) => missRead(s, a.key, a.max, a.now),
  missRecord:   (s, a) => missRecord(s, a.key, a.now),
}

module.exports = {
  consumeSlot, refundSlot, lockoutCheck, lockoutFail, lockoutClear, missRead, missRecord, OPS,
  LOCKOUT_MAX_CONSECUTIVE_FAILURES, LOCKOUT_MINUTES, LOCKOUT_MIN_DISTINCT_IPS, LOCKOUT_MAX_TRACKED_IPS, VERIFY_MISS_WINDOW_SECONDS,
}
