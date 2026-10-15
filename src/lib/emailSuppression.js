// Addresses that mailbox providers told us (via the Resend webhook) permanently bounce or complain
// about our mail. Stored as a hash only (email_suppressions, migration 0059). send() consults it.
//
// WHAT STILL GOES OUT: security and payment mail — verification and reset links, sign-in and
// credential-change notices, receipts. A person must be able to reach their own account, and a
// notice that someone changed the password is not optional. Everything else (welcome, scan results,
// partner and lead notifications, …) is skipped: mailing an address that bounces or reported us as
// spam again only damages the sending domain the security mail goes out from.
//
// Every function here is best-effort and NEVER throws: a missing table (migration not applied yet)
// or a database blip must not stop an email, or break the webhook that feeds this.

// Webhooks round 14 (B3): hashes come from lib/mailbox (keyed HMAC when SUPPRESSION_HASH_KEY is set, like the employer
// do-not-contact list; canonical mailbox so bob+x@ and b.o.b@gmail.com are the inbox that bounced). Rows written before this
// (unsalted SHA-256 of the typed address) are still READ, and re-keyed the next time they are hit.
const { suppressionHashes, canonicalMailbox } = require('./mailbox')

const ALWAYS_SEND_TEMPLATES = new Set([
  'email_verification', 'password_reset', 'password_changed',
  'email_change_confirm', 'email_changed_old_address', 'email_change_completed',
  'account_deleted', 'account_lockout_alert', 'new_login_alert',
  'payment_receipt', 'payment_reversed',
  // Partner account security: a changed payout destination / email, and the links that are a partner's only way in.
  'partner_payout_details_changed', 'partner_email_changed', 'partner_link_regenerated',
  'partner_dashboard_link_regenerated', 'partner_links_recovery', 'partner_links_self_reset',
  'partner_payout_details_request',
])


const isMissingColumn = err => !!err && (err.code === '42703' || err.code === 'PGRST204' || /column .* (does not exist|of relation)|could not find the '[^']+' column/i.test(err.message || ''))

// `env` is optional only so a caller without one still works (plain hashes, as before).
async function recordSuppression(supabase, email, reason, env) {
  try {
    const { store } = await suppressionHashes(env, email)
    // Webhooks round 15 (B4): a spam complaint is the stronger reason and must survive a later hard bounce for the same address
    // (the employer-lead removal already works this way). A bounce is written only if nothing is recorded yet; a complaint always wins.
    const isComplaint = reason === 'complaint'
    const { error } = await supabase.from('email_suppressions')
      .upsert({ email_hash: store[0], reason: isComplaint ? 'complaint' : 'bounce' }, isComplaint ? { onConflict: 'email_hash' } : { onConflict: 'email_hash', ignoreDuplicates: true })
    if (error) throw error
    return true
  } catch (err) {
    console.error('email suppression write failed:', err.message)
    return false
  }
}

// Returns the suppression row ({ reason, created_at }) or null. Null on any error (fail open).
async function getSuppression(supabase, email, env) {
  try {
    const { read, store } = await suppressionHashes(env, email)
    const { data, error } = await supabase.from('email_suppressions').select('email_hash, reason, created_at').in('email_hash', read)
    if (error) throw error
    const rows = data || []
    if (!rows.length) return null
    // A complaint outranks a bounce; otherwise the oldest entry.
    rows.sort((x, y) => (x.reason === 'complaint' ? 0 : 1) - (y.reason === 'complaint' ? 0 : 1) || String(x.created_at).localeCompare(String(y.created_at)))
    const hit = rows[0]
    // Opportunistic re-key: an entry under a legacy (unsalted) hash moves to the keyed canonical one once a key exists.
    if (env && env.SUPPRESSION_HASH_KEY && hit.email_hash !== store[0]) rekey(supabase, hit, store[0])
    return { reason: hit.reason, created_at: hit.created_at }
  } catch (err) {
    console.error('email suppression lookup failed (sending anyway):', err.message)
    return null
  }
}

function rekey(supabase, hit, to) {
  Promise.resolve(supabase.from('email_suppressions').upsert({ email_hash: to, reason: hit.reason, created_at: hit.created_at }, { onConflict: 'email_hash' }))
    .then(({ error }) => error ? null : supabase.from('email_suppressions').delete().eq('email_hash', hit.email_hash))
    .catch(() => {})
}

// Which of these addresses are blocked (the input spelling comes back) — one grouped lookup for an import. Fails open.
async function suppressedAmong(supabase, emails, env, chunk = 80) {
  const hit = new Set()
  try {
    const byHash = new Map()
    for (const e of emails) for (const h of (await suppressionHashes(env, e)).read) byHash.set(h, e)
    const hashes = [...byHash.keys()]
    for (let i = 0; i < hashes.length; i += chunk) {
      const { data, error } = await supabase.from('email_suppressions').select('email_hash').in('email_hash', hashes.slice(i, i + chunk))
      if (error) throw error
      for (const r of data || []) if (byHash.has(r.email_hash)) hit.add(byHash.get(r.email_hash))
    }
  } catch (err) { console.error('email suppression bulk lookup failed (continuing):', err.message) }
  return hit
}

async function liftSuppression(supabase, email, env) {
  const { read } = await suppressionHashes(env, email)
  const { data, error } = await supabase.from('email_suppressions').delete().in('email_hash', read).select('email_hash')
  if (error) throw error
  await clearAccountBounce(supabase, { emails: [...new Set([normalizeAddr(email), canonicalMailbox(email)])] })
  return !!(data && data.length)
}

// true -> do NOT send this template to this address.
async function isSuppressedFor(supabase, email, template, env) {
  if (ALWAYS_SEND_TEMPLATES.has(template)) return false
  return !!(await getSuppression(supabase, email, env))
}

// ── account visibility (webhooks round 14, G1) ────────────────────────────────────────────────────────────────────
// Security / payment mail still goes to a bounced address and keeps failing; the account's owner and the admin should know.
// users.email_bounced_at / email_bounce_type (migration 0086) — a class and a time, never the address. Best effort, never throws.
const normalizeAddr = email => String(email || '').trim().toLowerCase()

// Marks the account(s) that use this exact address; returns their ids (also when the columns are not there yet).
async function flagAccountBounce(supabase, email, type) {
  try {
    const addr = normalizeAddr(email)
    if (!addr) return []
    const kind = type === 'complaint' || type === 'suppressed' ? type : 'bounce'
    // Webhooks round 15 (B4): an account already flagged for a complaint keeps that flag when a bounce / suppression follows.
    let { data: found, error } = await supabase.from('users').select('id, email_bounce_type').eq('email', addr)
    let data = found
    if (error && isMissingColumn(error)) ({ data, error } = await supabase.from('users').select('id').eq('email', addr))
    else if (!error) {
      const ids = (found || []).filter(r => kind === 'complaint' || r.email_bounce_type !== 'complaint').map(r => r.id)
      if (ids.length) {
        const upd = await supabase.from('users').update({ email_bounced_at: new Date().toISOString(), email_bounce_type: kind }).in('id', ids)
        if (upd.error && !isMissingColumn(upd.error)) error = upd.error
      }
    }
    if (error) { console.error('account bounce flag failed:', error.message); return [] }
    return (data || []).map(r => r.id)
  } catch (err) { console.error('account bounce flag failed:', err && err.message); return [] }
}

// { emails: [...] } or { userId } — after the person changed their address, or an admin lifted the suppression.
async function clearAccountBounce(supabase, { emails = null, userId = null } = {}) {
  try {
    let q = supabase.from('users').update({ email_bounced_at: null, email_bounce_type: null })
    if (userId) q = q.eq('id', userId)
    else if (emails && emails.length) q = q.in('email', emails)
    else return false
    q = q.not('email_bounced_at', 'is', null)
    const { error } = await q
    if (error) { if (!isMissingColumn(error)) console.error('account bounce flag clear failed:', error.message); return false }
    return true
  } catch (err) { console.error('account bounce flag clear failed:', err && err.message); return false }
}

module.exports = { recordSuppression, getSuppression, liftSuppression, isSuppressedFor, suppressedAmong, flagAccountBounce, clearAccountBounce, ALWAYS_SEND_TEMPLATES }
