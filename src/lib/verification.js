// Shared helpers for the public verification page (Section 7).
const constants = require('../config/constants')
const cryptoLib = require('./crypto')

const STATUS = Object.freeze({ ACTIVE: 'ACTIVE', REVOKED: 'REVOKED' })
// Who revoked. OWNER can be undone by the owner; everything else only by an admin.
const REVOKE_REASON = Object.freeze({ OWNER: 'OWNER', REFUND: 'REFUND', DISPUTE: 'DISPUTE', ADMIN: 'ADMIN' })

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
async function visitorKey(code, ip, ua) {
  const h = await cryptoLib.sha256(`${ip}|${ua || ''}`)
  return `vv:${code}:${h.slice(0, 24)}`
}

// Revoke a scan's public verification page.
//   OWNER  — only takes effect on an ACTIVE page, so it can never overwrite a
//            stronger (admin/refund/dispute) revocation
//   others — always win: a refund revocation must stick even if the owner had
//            ALSO unpublished it earlier (which is what lets the owner's
//            "republish" button stop working once the reason is no longer OWNER)
// Returns true when a row changed. Throws on a DB error so callers can retry.
async function revokeVerification(supabase, scanId, reason, now = new Date()) {
  if (!scanId) return false
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

module.exports = {
  STATUS, REVOKE_REASON, CODE_RE,
  normalizeCode, isPlausibleCode, isBotUserAgent, visitorKey,
  revokeVerification, restoreVerification,
}
