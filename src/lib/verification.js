// Shared helpers for the public verification page (Section 7).
const constants = require('../config/constants')
const cryptoLib = require('./crypto')
const { rateKeyIp } = require('./clientIp')

const STATUS = Object.freeze({ ACTIVE: 'ACTIVE', REVOKED: 'REVOKED' })
// Who revoked. OWNER can be undone by the owner; everything else only by an admin.
const REVOKE_REASON = Object.freeze({ OWNER: 'OWNER', REFUND: 'REFUND', DISPUTE: 'DISPUTE', ADMIN: 'ADMIN', BAN: 'BAN' })

// Codes are generated from SHORT_CODE_CHARS at SHORT_CODE_LENGTH (badge.service).
// Anything else can never match a row, so it is rejected before touching the DB.
const escapeForClass = s => s.replace(/[\\\]\[^-]/g, '\\$&')
const CODE_RE = new RegExp(`^[${escapeForClass(constants.SHORT_CODE_CHARS)}]{${constants.SHORT_CODE_LENGTH}}$`)

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase()
}

function isPlausibleCode(code) {
  return CODE_RE.test(code)
}

// Link-preview fetchers, crawlers, monitors and scripts. A page view is meant
// to mean "a person looked at this" — the owner sees the number as a signal.
const BOT_UA_RE = /bot|crawl|spider|slurp|preview|unfurl|facebookexternalhit|embedly|quora|pinterest|whatsapp|telegram|discord|slack|skype|vkshare|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios|node-fetch|go-http-client|okhttp|java\//i

function isBotUserAgent(ua) {
  // An empty UA is not a browser.
  return !ua || BOT_UA_RE.test(ua)
}

// Same-visitor dedupe key: one count per visitor per code per day. Hashed so
// no raw IP/UA is ever written to KV.
//
// SECTION 7 AUDIT FIX (bug): collapses an IPv6 address to its /64 first,
// same as every rate-limit key in middleware/rateLimiter.js — without it, a
// single IPv6 subscriber (whose OS often rotates their address on its own,
// entirely apart from anyone trying to game this) reliably mints a "new
// visitor" per address, both under- and over-counting genuine views and
// leaving the dedupe trivially bypassable for anyone who'd want to inflate
// the count on purpose. A no-op for IPv4 — see lib/clientIp.js.
async function visitorKey(code, ip, ua) {
  const h = await cryptoLib.sha256(`${rateKeyIp(ip)}|${ua || ''}`)
  return `vv:${code}:${h.slice(0, 24)}`
}

// The Pages Function that builds link-preview meta tags fetches
// /api/verify/:code?preview=1 from Cloudflare's own egress IPs — a small shared
// pool. Without a way to tell it apart from a stranger, every crawler hitting a
// bad /v/<garbage> URL was counted as a "miss" against that shared pool, and the
// pool's legitimate previews were subject to the per-IP limits. Optional shared
// secret: when VERIFY_PREVIEW_KEY is set on the Worker AND the Function sends it
// in x-preview-key, the request is exempt from the per-IP limiters and never
// records a miss. Unset (the default) changes nothing.
function isTrustedPreview(c) {
  try {
    const key = c && c.env && c.env.VERIFY_PREVIEW_KEY
    if (!key || c.req.query('preview') !== '1') return false
    return cryptoLib.timingSafeEqual(String(c.req.header('x-preview-key') || ''), String(key))
  } catch (_) { return false }
}

// Sec-Fetch-* are forbidden headers a page cannot forge: a request the browser
// itself reports as a sub-resource load (<img>, <script>, no-cors fetch) is
// never the SPA's own XHR. Such loads must not be able to spend a visitor's
// "miss" budget — that is how a hostile page could lock an office NAT out of
// verification. Non-browser clients send none of these headers and are counted.
function isBrowserSubresourceLoad(c) {
  const h = n => (c.req.header(n) || '').toLowerCase()
  if (h('sec-fetch-mode') === 'no-cors') return true
  const dest = h('sec-fetch-dest')
  return !!dest && dest !== 'empty' && dest !== 'document'
}

// Revoke a scan's public verification page.
//   OWNER  — only takes effect on an ACTIVE page, so it can never overwrite a
//            stronger (admin/refund/dispute) revocation
//   others — always win: a refund revocation must stick even if the owner had
//            ALSO unpublished it earlier (which is what lets the owner's
//            "republish" button stop working once the reason is no longer OWNER)
// Returns true when a row changed. Throws on a DB error so callers can retry.
//
// SECTION 7/8 AUDIT FIX (bug): the "others always win" rule above is
// intentional — a stronger reason must be able to overwrite a weaker one
// even on an already-revoked row. But with no gate at all on non-OWNER
// reasons, calling this AGAIN with the SAME reason on an already-revoked
// row used to still "succeed": it re-stamped verification_revoked_at to
// now() and reported changed:true every time. A legitimately-redelivered
// refund.processed webhook under a new Paystack event id (fulfillment
// .service.js's reversePayment, called from webhooks.controller.js) does
// exactly this — the redelivery is genuinely new to the inbox dedupe even
// though nothing about the underlying revocation should. That silently
// drifted the publicly-displayed revocation date forward on every retry,
// and made the caller's changed/`revoked` flag unable to ever report
// "already revoked" for this path. Only skip the write when the reason
// isn't actually changing — a different (stronger) reason still wins.
async function revokeVerification(supabase, scanId, reason, now = new Date()) {
  if (!scanId) return false
  if (reason !== REVOKE_REASON.OWNER) {
    const { data: current, error: readErr } = await supabase.from('scans')
      .select('verification_status, verification_revoked_reason').eq('id', scanId).maybeSingle()
    if (readErr) throw readErr
    if (current && current.verification_status === STATUS.REVOKED && current.verification_revoked_reason === reason)
      return false
  }
  let q = supabase.from('scans')
    .update({
      verification_status:         STATUS.REVOKED,
      verification_revoked_at:     now.toISOString(),
      verification_revoked_reason: reason,
    })
    .eq('id', scanId)
  if (reason === REVOKE_REASON.OWNER) q = q.eq('verification_status', STATUS.ACTIVE)
  const { data, error } = await q.select('id')
  if (error) throw error
  return (data || []).length > 0
}

// Undo a revocation. `asAdmin` may lift any reason; the owner may only lift
// their own (reason OWNER) — never a refund/dispute/admin takedown.
async function restoreVerification(supabase, scanId, { asAdmin = false } = {}) {
  if (!scanId) return false
  let q = supabase.from('scans')
    .update({ verification_status: STATUS.ACTIVE, verification_revoked_at: null, verification_revoked_reason: null })
    .eq('id', scanId)
    .eq('verification_status', STATUS.REVOKED)
  if (!asAdmin) q = q.eq('verification_revoked_reason', REVOKE_REASON.OWNER)
  const { data, error } = await q.select('id')
  if (error) throw error
  return (data || []).length > 0
}

// Account ban → take every ACTIVE public page of that user down. ROUND-2 AUDIT
// (feature gap, Section 7): the verify endpoints never look at the owner, so a
// banned user's page, badge and any exposed .docx/PDF stayed public. Only pages
// that are ACTIVE are touched, so a page the owner had already unpublished (or a
// refund/dispute/admin takedown) keeps its own, stronger-or-equal reason and is
// not resurrected by an un-ban. Idempotent; throws on a DB error so the admin
// action can be repeated.
async function revokeUserVerifications(supabase, userId, now = new Date()) {
  if (!userId) return 0
  const { data, error } = await supabase.from('scans')
    .update({ verification_status: STATUS.REVOKED, verification_revoked_at: now.toISOString(), verification_revoked_reason: REVOKE_REASON.BAN })
    .eq('user_id', userId).eq('verification_status', STATUS.ACTIVE).not('verification_code', 'is', null)
    .select('id')
  if (error) throw error
  return (data || []).length
}

// Un-ban: restore exactly what the ban took down (reason BAN) and nothing else.
async function restoreUserVerifications(supabase, userId) {
  if (!userId) return 0
  const { data, error } = await supabase.from('scans')
    .update({ verification_status: STATUS.ACTIVE, verification_revoked_at: null, verification_revoked_reason: null })
    .eq('user_id', userId).eq('verification_status', STATUS.REVOKED).eq('verification_revoked_reason', REVOKE_REASON.BAN)
    .select('id')
  if (error) throw error
  return (data || []).length
}

module.exports = {
  STATUS, REVOKE_REASON, CODE_RE,
  normalizeCode, isPlausibleCode, isBotUserAgent, visitorKey,
  revokeVerification, restoreVerification, revokeUserVerifications, restoreUserVerifications,
  isTrustedPreview, isBrowserSubresourceLoad,
}
