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
//   * user_sessions     — sign-in IP + user-agent of sessions that are long dead (Database audit, 0077)
//   * claude_usage      — the Claude cost ledger; bounded so it cannot grow forever (0077)
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

// A session revoked or past its absolute expiry this long ago is dead for good: longer than any token's lifetime,
// so no live JWT can still point at the row (the same 7 days create_user_session already used, doubled for margin).
const DEAD_SESSION_RETENTION_DAYS = 14
// The Claude cost ledger holds no personal data (a scan id and token counts); 400 days keeps a full year-on-year view.
const CLAUDE_USAGE_RETENTION_DAYS = 400
const PURGE_RPC_BATCH = 5000
const PURGE_RPC_MAX_ROUNDS = 5

const DAY = 24 * 60 * 60 * 1000

// A typed background is kept on its scan only so a scan that failed on OUR side can be retried in place (retry-scan). A
// completed scan drops it (runAtsScan) and a failure retrying cannot fix drops it at once; one that stayed ERROR is a
// retry nobody made, and the full career narrative plus the typed name / email would otherwise sit in the row for the
// life of the account (resume-from-scratch round 2). A week is far past any real "try again".
const FAILED_BACKGROUND_RETENTION_DAYS = 7
async function purgeFailedBackgrounds(supabase, now = Date.now()) {
  try {
    const { data, error } = await supabase.from('scans')
      .update({ raw_brain_dump_text: null })
      .eq('status', 'ERROR').not('raw_brain_dump_text', 'is', null)
      .lt('updated_at', new Date(now - FAILED_BACKGROUND_RETENTION_DAYS * DAY).toISOString())
      .select('id')
    if (error) return { cleared: 0, error: error.message }
    return { cleared: (data || []).length }
  } catch (err) {
    return { cleared: 0, error: err.message }
  }
}

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
      let emails = [...new Set(data.map(r => r.email).filter(Boolean))]
      // Round 16 (B2): blocking an address blocks its whole INBOX. A different spelling of the same inbox that is
      // still a lead (dana@ next to the purged dana+x@) used to be left standing and silently unmailable — never
      // notified, its resubmissions dropped. An inbox that still has a lead is simply not blocked here; the purged
      // row is gone either way, and the admin's own delete-and-block paths remain the way to block a whole inbox.
      const keys = [...new Set(emails.map(canonicalMailbox))]
      const live = new Set()
      const byKey = await supabase.from('employer_leads').select('email, mailbox_key').in('mailbox_key', keys)
      if (!byKey.error) for (const r of byKey.data || []) live.add(r.mailbox_key)
      else if (['42703', 'PGRST204'].includes(byKey.error.code)) {
        // Database without migration 0076: compare the typed forms instead.
        const byForm = await supabase.from('employer_leads').select('email').in('email', mailboxForms(emails))
        if (!byForm.error) for (const r of byForm.data || []) live.add(canonicalMailbox(r.email))
      }
      if (live.size) emails = emails.filter(e => !live.has(canonicalMailbox(e)))
      if (!emails.length) return out
      // Round 11: keyed hashes (SUPPRESSION_HASH_KEY) for the address and its mailbox form, with the reason
      // recorded; falls back to hash-only rows when migration 0068 has not run.
      const hashes = [...new Set((await Promise.all(emails.map(e => suppressionHashes(env, e)))).flatMap(h => h.store))]
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

// Public "report this verification page" rows (Verify round 8). They can hold a reporter's e-mail address
// and free text, so they do not live forever: every status is purged after VERIFY_REPORT_RETENTION_DAYS.
async function purgeOldVerifyReports(supabase, now = Date.now()) {
  try {
    const { data, error } = await supabase.from('verification_reports').delete()
      .lt('created_at', new Date(now - c.VERIFY_REPORT_RETENTION_DAYS * DAY).toISOString()).select('id')
    if (error) return { deleted: 0, error: error.message }
    return { deleted: (data || []).length }
  } catch (err) {
    return { deleted: 0, error: err.message }
  }
}

// Bounded batch deletes done in the database (0077). Each RPC removes at most `batch` rows and returns how many; a
// backlog (first run after the migration) is drained over a few rounds, then left for the next hour.
async function drainPurge(supabase, fn, args, batch) {
  let deleted = 0
  try {
    for (let round = 0; round < PURGE_RPC_MAX_ROUNDS; round++) {
      const { data, error } = await supabase.rpc(fn, { ...args, p_batch: batch })
      if (error) return { deleted, error: error.message }
      const n = Number(data) || 0
      deleted += n
      if (n < batch) break
    }
    return { deleted }
  } catch (err) {
    return { deleted, error: err.message }
  }
}

// Never throws; returns a count like the other steps.
const purgeDeadSessions = (supabase) =>
  drainPurge(supabase, 'purge_dead_sessions', { p_days: DEAD_SESSION_RETENTION_DAYS }, PURGE_RPC_BATCH)
// Partners round 39: terms-acceptance rows logged at application time hold only the applicant's email, IP hash and user agent. Once the
// application is gone (rejected + REJECTED_APPLICATION_RETENTION_DAYS, or the partner was erased) nothing else would ever remove them.
const purgeUnlinkedTermsAcceptances = (supabase) =>
  drainPurge(supabase, 'purge_unlinked_terms_acceptances', {}, PURGE_RPC_BATCH)
const purgeOldClaudeUsage = (supabase) =>
  drainPurge(supabase, 'purge_old_claude_usage', { p_days: CLAUDE_USAGE_RETENTION_DAYS }, PURGE_RPC_BATCH * 4)

async function runRetention(env, supabase, now = Date.now()) {
  const [anon, logs, tokens, leads, staleLeads, applications, reports, sessions, claudeUsage, failedBackgrounds, termsAcceptances] = await Promise.all([
    purgeExpiredAnonScans(env, supabase, now),
    purgeOldLogs(supabase, now),
    clearExpiredTokens(supabase, now),
    purgeArchivedLeads(supabase, now, { suppress: !!env && String(env.ARCHIVED_LEAD_PURGE_SUPPRESSES).toLowerCase() === 'true', env }),
    purgeStaleUnconfirmedLeads(supabase, now),
    purgeRejectedPartnerApplications(supabase, now),
    purgeOldVerifyReports(supabase, now),
    purgeDeadSessions(supabase),
    purgeOldClaudeUsage(supabase),
    purgeFailedBackgrounds(supabase, now),
    purgeUnlinkedTermsAcceptances(supabase),
  ])
  return { anon, logs, tokens, leads, staleLeads, applications, reports, sessions, claudeUsage, failedBackgrounds, termsAcceptances }
}

module.exports = {
  runRetention, purgeFailedBackgrounds, FAILED_BACKGROUND_RETENTION_DAYS, purgeDeadSessions, purgeOldClaudeUsage, DEAD_SESSION_RETENTION_DAYS, CLAUDE_USAGE_RETENTION_DAYS, purgeOldVerifyReports, purgeExpiredAnonScans, purgeOldLogs, clearExpiredTokens, purgeArchivedLeads, purgeStaleUnconfirmedLeads, purgeRejectedPartnerApplications, purgeUnlinkedTermsAcceptances,
  REJECTED_APPLICATION_RETENTION_DAYS, EMAIL_LOG_RETENTION_DAYS, ALERT_LOG_RETENTION_DAYS, ARCHIVED_LEAD_RETENTION_DAYS, UNCONFIRMED_LEAD_RETENTION_DAYS, ANON_SCAN_TTL_HOURS: c.ANON_SCAN_TTL_HOURS
}
