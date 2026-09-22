// Scheduled data hygiene, run from the hourly cron in index.js.
//
// Everything here exists because a table or field otherwise grows — and holds
// personal data — forever:
//   * anonymous scans   — resume text/files of people who never signed up
//   * email_logs        — every recipient address + subject we ever mailed
//   * alert_logs        — operational history; useful for weeks, not years
//   * spent auth tokens — hashed reset/verify tokens that outlive their expiry
//
// Each step is independent and never throws (one failing purge must not stop
// the others, or the rest of the cron). All return counts for the cron's log.

const c = require('../config/constants')

const EMAIL_LOG_RETENTION_DAYS = 90
const ALERT_LOG_RETENTION_DAYS = 180
const ANON_BATCH = 500

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
  const out = { resetTokens: 0, verifyTokens: 0, errors: [] }
  for (const [tokenCol, expiryCol, key] of [
    ['reset_token', 'reset_token_expiry', 'resetTokens'],
    ['email_verify_token', 'email_verify_expiry', 'verifyTokens'],
  ]) {
    try {
      const { data, error } = await supabase.from('users')
        .update({ [tokenCol]: null, [expiryCol]: null })
        .lt(expiryCol, nowIso).select('id')
      if (error) out.errors.push(`${tokenCol}: ${error.message}`)
      else out[key] = data?.length || 0
    } catch (err) { out.errors.push(`${tokenCol}: ${err.message}`) }
  }
  return out
}

async function runRetention(env, supabase, now = Date.now()) {
  const [anon, logs, tokens] = await Promise.all([
    purgeExpiredAnonScans(env, supabase, now),
    purgeOldLogs(supabase, now),
    clearExpiredTokens(supabase, now),
  ])
  return { anon, logs, tokens }
}

module.exports = {
  runRetention, purgeExpiredAnonScans, purgeOldLogs, clearExpiredTokens,
  EMAIL_LOG_RETENTION_DAYS, ALERT_LOG_RETENTION_DAYS, ANON_SCAN_TTL_HOURS: c.ANON_SCAN_TTL_HOURS
}
