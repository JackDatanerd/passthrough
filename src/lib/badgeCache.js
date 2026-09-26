// Shared badge edge-cache key + purge helpers (Section 7).
//
// Split out of verify.controller.js so revoke/restore (lib/verification.js —
// called from admin.controller.js, scan.controller.js, and
// fulfillment.service.js's reversePayment) can purge a code's cached badge
// the instant its state changes, without a circular require on the controller
// (verify.controller.js already requires lib/verification.js for STATUS/
// normalizeCode/etc).
//
// SECTION 7 AUDIT FIX (bug): the embeddable badge (verify.controller.js's
// getBadge) is cached at Cloudflare's edge via the Cache API with a 5-minute
// TTL (60s when the integrity check couldn't run) — a deliberate cost
// ceiling, not a correctness problem BY ITSELF. The problem was that nothing
// ever invalidated it: a refund, a dispute reversal, an admin/ban revoke, or
// the owner's own unpublish/republish all flip verification_status in the DB
// immediately (and the JSON page is `no-store`, so it reflects that
// instantly) but the cached SVG badge — the one surface a viewer sees
// WITHOUT clicking through — could keep answering "Passthrough Verified
// 85/100" for up to 5 minutes after a page was revoked. That directly
// violates this file's own stated invariant ("the badge's claim must satisfy
// passed AND integrity-verified AND not-revoked, same as the page
// headline") for as long as the stale cache entry lives.
//
// The cache key used to be built from the live request's own origin
// (`new URL(c.req.url)`) — fine for getBadge() itself, but it meant nothing
// OUTSIDE a request (a revoke, which runs from a webhook, an admin action, a
// cron sweep, or the owner's own unpublish button) could ever reconstruct
// the same key to purge it: wrangler.toml pins no custom domain, so the real
// origin is whichever *.workers.dev name happens to be serving that
// particular request — a background job has no way to know it and no
// business depending on it. The Cache API key only needs to be stable and
// collision-free within this Worker's own cache namespace, not a fetchable
// URL, so it is now built purely from the normalized code on a fixed
// synthetic authority. That is what actually makes purge-on-revoke possible.
function badgeCache() {
  try { return typeof caches !== 'undefined' && caches.default ? caches.default : null } catch (_) { return null }
}

// `code` must already be normalized/canonical. Every caller satisfies this for free:
// verify.controller.js's getBadge normalizes via lib/verification's normalizeCode before
// calling in, and every purge call site (lib/verification.js's revoke/restore functions)
// reads the code straight off scans.verification_code, which badge.service.js's
// generateShortCode draws only from SHORT_CODE_CHARS (already all-uppercase) and never
// lowercases at rest — so no second normalization pass is needed here, which keeps this
// module free of any dependency on lib/verification.js and safe for that file to depend on.
function badgeCacheKeyForCode(code) {
  return new Request(`https://verify-badge.passthrough.internal/${code}`)
}

// Best-effort, like every other cache operation here — a purge failure must never fail (or
// even slow down) the revoke/restore it rides along with. Missing code, missing Cache API
// (e.g. local dev/tests with no `caches` global) and a thrown delete() are all silent no-ops;
// worst case is the pre-existing 5-minute-TTL staleness window this exists to close, not a
// new failure mode.
async function purgeBadgeCache(code) {
  if (!code) return
  const cache = badgeCache()
  if (!cache) return
  try { await cache.delete(badgeCacheKeyForCode(code)) } catch (err) { console.error('[verify] badge cache purge failed:', err.message) }
}

module.exports = { badgeCache, badgeCacheKeyForCode, purgeBadgeCache }
