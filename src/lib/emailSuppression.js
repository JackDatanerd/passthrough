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

const { sha256 } = require('./crypto')

const ALWAYS_SEND_TEMPLATES = new Set([
  'email_verification', 'password_reset', 'password_changed',
  'email_change_confirm', 'email_changed_old_address', 'email_change_completed',
  'account_deleted', 'account_lockout_alert', 'new_login_alert',
  'payment_receipt', 'payment_reversed',
])

const normalize = email => String(email || '').trim().toLowerCase()

async function recordSuppression(supabase, email, reason) {
  try {
    const hash = await sha256(normalize(email))
    const { error } = await supabase.from('email_suppressions')
      .upsert({ email_hash: hash, reason: reason === 'complaint' ? 'complaint' : 'bounce' }, { onConflict: 'email_hash' })
    if (error) throw error
    return true
  } catch (err) {
    console.error('email suppression write failed:', err.message)
    return false
  }
}

// Returns the suppression row ({ reason, created_at }) or null. Null on any error (fail open).
async function getSuppression(supabase, email) {
  try {
    const hash = await sha256(normalize(email))
    const { data, error } = await supabase.from('email_suppressions').select('reason, created_at').eq('email_hash', hash).maybeSingle()
    if (error) throw error
    return data || null
  } catch (err) {
    console.error('email suppression lookup failed (sending anyway):', err.message)
    return null
  }
}

async function liftSuppression(supabase, email) {
  const hash = await sha256(normalize(email))
  const { data, error } = await supabase.from('email_suppressions').delete().eq('email_hash', hash).select('email_hash')
  if (error) throw error
  return !!(data && data.length)
}

// true -> do NOT send this template to this address.
async function isSuppressedFor(supabase, email, template) {
  if (ALWAYS_SEND_TEMPLATES.has(template)) return false
  return !!(await getSuppression(supabase, email))
}

module.exports = { recordSuppression, getSuppression, liftSuppression, isSuppressedFor, ALWAYS_SEND_TEMPLATES }
