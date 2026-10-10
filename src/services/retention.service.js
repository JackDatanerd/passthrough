// Scheduled data hygiene, run from the hourly cron in index.js.
//
// Everything here exists because a table or field otherwise grows — and holds
// personal data — forever:
//   * anonymous scans   — resume text/files of people who never signed up
//   * email_logs        — every recipient address + subject we ever mailed
//   * alert_logs        — operational history; useful for weeks, not years
//   * spent auth tokens — hashed reset/verify tokens that outlive their expiry
//   * dismissed employer leads — a stranger's name/company/email, archived by an
//                           admin, kept until someone remembered to delete it
//   * never-confirmed employer leads — an address a stranger typed that nobody has ever
//                           confirmed or touched, kept forever (fresh audit pass 2, Section 5)
//
// Each step is independent and never throws (one failing purge must not stop
// the others, or the rest of the cron). All return counts for the cron's log.

const c = require('../config/constants')
const { suppressionHashes, canonicalMailbox } = require('../lib/mailbox')

const mailboxForms = (emails) => [...new Set(emails.flatMap(e => [e, canonicalMailbox(e)]))]

const EMAIL_LOG_RETENTION_DAYS = 90
const ALERT_LOG_RETENTION_DAYS = 180
const ANON_BATCH = 500
// An ARCHIVED lead is one the admin decided not to pursue (spam, wrong fit).
// It is kept for a while so a resubmission is still recognised as the same
// dismissed lead, then removed. Any resubmission bumps updated_at, so a lead
// that keeps coming back is never purged out from under the dedupe.
const ARCHIVED_LEAD_RETENTION_DAYS = 90
// A lead that is still NEW, never confirmed, carries no admin notes and has not been
// resubmitted for this long was never going to be confirmed: the acknowledgement asked
// the address owner to confirm (or remove it) and nothing came back. Anything an admin
// has touched is safe — CONTACTED/CONVERTED/ARCHIVED status or a note keeps the row —
// and a person who keeps resubmitting keeps last_submitted_at fresh.
const UNCONFIRMED_LEAD_RETENTION_DAYS = 90

// A rejected partner application keeps the applicant's name, email, audience and message. They were emailed the
// decision, and the re-apply cooldown is 30 days, so the row has done its job well before this (Section 4 round 7).
const REJECTED_APPLICATION_RETENTION_DAYS = 90

const DAY = 24 * 60 * 60 * 1000

// Anonymous scans past their TTL. `anon_expires_at` IS the deadline — this
// used to compare against (now - 24h), so a scan promised for 24 hours was
// really kept for ~48. Rows whose R2 object could not be deleted are KEPT, so
// the next run retries them rather than orphaning the file forever.
async function purgeExpiredAnonScans(env, supabase, now = Date.now()) {
  try {
    const { data: expired, error } = await supabase
      .from('scans')
      .select('id, resume_path')
      .is('user_id', null)
      .lt('anon_expires_at', new Date(now).toISOString())
      .limit(ANON_BATCH)
    if (error) return { deleted: 0, error: error.message }

    const deletable = []
    for (const s of expired || []) {
      if (s.resume_path) {
        try { await env.RESUMES_BUCKET.delete(s.resume_path) } catch (_) { continue }
      }
      deletable.push(s.id)
    }
    if (deletable.length) {
      const { error: delErr } = await supabase.from('scans').delete().in('id', deletable)
      if (delErr) return { deleted: 0, error: delErr.message }
    }
    return { deleted: deletable.length }
  } catch (err) {
    return { deleted: 0, error: err.message }
  }
}

async function purgeOldLogs(supabase, now = Date.now()) {
  const out = { emailLogs: 0, alertLogs: 0, errors: [] }
  for (const [table, col, days, key] of [
    ['email_logs', 'sent_at',    EMAIL_LOG_RETENTION_DAYS, 'emailLogs'],
    ['alert_logs', 'created_at', ALERT_LOG_RETENTION_DAYS, 'alertLogs'],
  ]) {
    try {
      const { data, error } = await supabase.from(table).delete().lt(col, new Date(now - days * DAY).toISOString()).select('id')
      if (error) out.errors.push(`${table}: ${error.message}`)
      else out[key] = data?.length || 0
    } catch (err) { out.errors.push(`${table}: ${err.message}`) }
  }
  return out
}

// A reset / verification token past its expiry can never be redeemed (every
// lookup filters on expiry) — but the hash sits in the row. Clear it.
async function clearExpiredTokens(supabase, now = Date.now()) {
  const nowIso = new Date(now).toISOString()
  const out = { resetTokens: 0, verifyTokens: 0, pendingEmailTokens: 0, errors: [] }
  for (const [patch, expiryCol, key] of [
    [{ reset_token: null }, 'reset_token_expiry', 'resetTokens'],
    [{ email_verify_token: null }, 'email_verify_expiry', 'verifyTokens'],
    // BUG FIX (Section 6, second fixing-time pass): pending_email_token
    // (auth.controller.js's updateEmail/confirmEmailChange) is the same
    // shape as the two above — a hashed, expiring, single-use token — and
    // was missing from this sweep entirely, since the column didn't exist
    // yet when this file was written. Unlike the other two, this one also
    // clears pending_email itself: that's the value Settings.jsx's "email
    // change pending" banner keys off, and leaving it set with no live
    // token behind it would show a banner for a change that can never be
    // completed or canceled through the normal flow again.
    [{ pending_email: null, pending_email_token: null }, 'pending_email_expiry', 'pendingEmailTokens'],
  ]) {
    try {
      const { data, error } = await supabase.from('users')
        .update({ ...patch, [expiryCol]: null })
        .lt(expiryCol, nowIso).select('id')
      if (error) out.errors.push(`${expiryCol}: ${error.message}`)
      else out[key] = data?.length || 0
    } catch (err) { out.errors.push(`${expiryCol}: ${err.message}`) }
  }
  return out
}

// `suppress` (env ARCHIVED_LEAD_PURGE_SUPPRESSES=true; off by default) — independent audit round 8,
// Section 5. Purging forgets the address entirely, so a dismissed spammer who comes back after
// the window arrives as a brand-new lead and notifies the owner again. With it on, each purged
// address goes onto the do-not-contact list (hash only) and its employer mail history is cleared,
// so the dismissal outlives the row. Off by default because the list answers the public form
// with a silent "success": an employer who was merely not a fit would never be able to sign up again.
async function purgeArchivedLeads(supabase, now = Date.now(), { suppress = false, env = null } = {}) {
  try {
    const cutoff = new Date(now - ARCHIVED_LEAD_RETENTION_DAYS * DAY).toISOString()
    const { data, error } = await supabase.from('employer_leads')
      .delete().eq('status', 'ARCHIVED').lt('updated_at', cutoff).select(suppress ? 'id, email' : 'id')
    if (error) return { deleted: 0, error: error.message }
    const out = { deleted: data?.length || 0 }
    if (suppress && data?.length) {
      const emails = [...new Set(data.map(r => r.email).filter(Boolean))]
      // Round 11: keyed hashes (SUPPRESSION_HASH_KEY) for the address and its mailbox form, with the reason
      // recorded; falls back to hash-only rows when migration 0068 has not run.
      const hashes = [...new Set((await Promise.all(emails.map(e => suppressionHashes(env, e)))).flatMap(h => h.write))]
      const upsert = (rows) => supabase.from('employer_lead_suppressions').upsert(rows, { onConflict: 'email_hash', ignoreDuplicates: true })
      let { error: supErr } = await upsert(hashes.map(h => ({ email_hash: h, reason: 'purge' })))
      if (supErr && ['42703', 'PGRST204'].includes(supErr.code)) ({ error: supErr } = await upsert(hashes.map(h => ({ email_hash: h }))))
      if (supErr) return { ...out, error: `suppression: ${supErr.message}` }
      const { error: logErr } = await supabase.from('email_logs').delete()
        .in('to', mailboxForms(emails)).in('template', ['employer_lead_ack', 'employer_candidates_available', 'employer_lead_rejoin'])
      if (logErr) return { ...out, error: `mail log: ${logErr.message}` }
      out.suppressed = emails.length
    }
    return out
  } catch (err) {
    return { deleted: 0, error: err.message }
  }
}

async function purgeStaleUnconfirmedLeads(supabase, now = Date.now()) {
  try {
    const cutoff = new Date(now - UNCONFIRMED_LEAD_RETENTION_DAYS * DAY).toISOString()
    const { data, error } = await supabase.from('employer_leads')
      .delete().eq('status', 'NEW').is('confirmed_at', null).is('notes', null)
      .lt('last_submitted_at', cutoff)
      // Round 10 (Section 5): only a lead that was actually asked to confirm (or that the
      // acknowledgement sweep has given up on, or that is very old regardless) may go. One whose
      // email never went out has not had its chance.
      .or(`last_ack_at.not.is.null,ack_attempts.gte.${c.LEAD_ACK_MAX_ATTEMPTS},created_at.lt.${new Date(now - 2 * UNCONFIRMED_LEAD_RETENTION_DAYS * DAY).toISOString()}`)
      .select('id')
    if (error) return { deleted: 0, error: error.message }
    return { deleted: data?.length || 0 }
  } catch (err) {
    return { deleted: 0, error: err.message }
  }
}

// Never throws; returns a count like the other steps.
async function purgeRejectedPartnerApplications(supabase, now = Date.now()) {
  try {
    const cutoff = new Date(now - REJECTED_APPLICATION_RETENTION_DAYS * DAY).toISOString()
    const { data, error } = await supabase.from('partner_applications')
      .delete().eq('status', 'REJECTED').lt('reviewed_at', cutoff).select('id')
    if (error) return { deleted: 0, error: error.message }
    return { deleted: (data || []).length }
  } catch (err) {
    return { deleted: 0, error: err.message }
  }
}

async function runRetention(env, supabase, now = Date.now()) {
  const [anon, logs, tokens, leads, staleLeads, applications] = await Promise.all([
    purgeExpiredAnonScans(env, supabase, now),
    purgeOldLogs(supabase, now),
    clearExpiredTokens(supabase, now),
    purgeArchivedLeads(supabase, now, { suppress: !!env && String(env.ARCHIVED_LEAD_PURGE_SUPPRESSES).toLowerCase() === 'true', env }),
    purgeStaleUnconfirmedLeads(supabase, now),
    purgeRejectedPartnerApplications(supabase, now),
  ])
  return { anon, logs, tokens, leads, staleLeads, applications }
}

module.exports = {
  runRetention, purgeExpiredAnonScans, purgeOldLogs, clearExpiredTokens, purgeArchivedLeads, purgeStaleUnconfirmedLeads, purgeRejectedPartnerApplications,
  REJECTED_APPLICATION_RETENTION_DAYS, EMAIL_LOG_RETENTION_DAYS, ALERT_LOG_RETENTION_DAYS, ARCHIVED_LEAD_RETENTION_DAYS, UNCONFIRMED_LEAD_RETENTION_DAYS, ANON_SCAN_TTL_HOURS: c.ANON_SCAN_TTL_HOURS
}
