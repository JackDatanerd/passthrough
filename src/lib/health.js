// What the Worker knows about ITSELF: is the database migrated as far as this code expects, did the
// hourly cron run recently, are the bindings it needs present. Feeds three places:
//   * GET /api/admin/health            (admin panel / operator)
//   * GET /healthz with X-Health-Key   (an uptime monitor: 503 when anything is wrong)
//   * the hourly cron's heartbeat job  (records the run, alerts the owner on a schema mismatch)
//
// Every read here is best-effort and never throws — a health check that crashes is worse than one
// that reports "unknown".

const c = require('../config/constants')
const { validateEnv } = require('./env')

const SCHEMA_KEY = 'schema_version'
const HEARTBEAT_KEY = 'cron_heartbeat'
// First time anything asked after the cron. A heartbeat that has NEVER been written is only "normal for the
// first hour" — without a starting point, a trigger that was never registered looked healthy forever.
const BASELINE_KEY = 'cron_baseline'
// The cron runs hourly; two missed runs plus slack is "stopped", one slow run is not.
const CRON_STALE_MINUTES = 150

const BINDINGS = ['RATE_LIMIT_DO', 'RATE_LIMIT_KV', 'RESUMES_BUCKET', 'FIX_QUEUE', 'BROWSER']

async function readState(supabase, key) {
  const { data, error } = await supabase.from('system_state').select('value, updated_at').eq('key', key).maybeSingle()
  if (error) throw error
  return data || null
}

// Called by the cron every hour. Never throws.
async function recordCronHeartbeat(supabase, now = new Date()) {
  try {
    const { error } = await supabase.from('system_state')
      .upsert({ key: HEARTBEAT_KEY, value: { at: now.toISOString() }, updated_at: now.toISOString() }, { onConflict: 'key' })
    if (error) throw error
    return true
  } catch (err) {
    console.error('cron heartbeat write failed:', err.message)
    return false
  }
}

// "Migrated as far as this code expects" means AT LEAST the expected version. A database that is AHEAD of
// the code is the normal state for the whole window between applying a migration and deploying the Worker
// that needs it (DEPLOYMENT.md says to migrate FIRST), and again after a rollback — it used to read as a
// failure: a 503 from the deep health check, and an owner email claiming the schema was "behind the
// deployed code" when it was the other way round. Only a database BEHIND the code (or unreadable) is a
// problem; ahead is reported as a note.
async function checkSchema(supabase) {
  const expected = c.EXPECTED_SCHEMA_VERSION
  try {
    const row = await readState(supabase, SCHEMA_KEY)
    const actual = row && row.value && Number.isFinite(Number(row.value.version)) ? Number(row.value.version) : null
    if (actual === null)
      return { expected, actual, ok: false, ahead: false, detail: 'schema_version not recorded — apply migration 0059 and every one after it' }
    if (actual < expected)
      return { expected, actual, ok: false, ahead: false, detail: `the database is at migration ${actual} but this code expects ${expected} — apply every migration above ${actual}, in order` }
    if (actual > expected)
      return { expected, actual, ok: true, ahead: true, detail: `the database is at migration ${actual}, ahead of this code (${expected}) — expected between applying a migration and deploying, or after a rollback` }
    return { expected, actual, ok: true, ahead: false, detail: null }
  } catch (err) {
    // A missing table is exactly "migration 0059 has not been applied".
    return { expected, actual: null, ok: false, ahead: false, detail: `could not read schema_version (${err.message}) — apply migration 0059 and every one after it` }
  }
}

// Remembers when the cron was first looked for (once; later calls leave it alone). Best-effort, never throws.
async function ensureCronBaseline(supabase, nowMs) {
  try {
    const row = await readState(supabase, BASELINE_KEY)
    const at = row && row.value && row.value.at ? Date.parse(row.value.at) : NaN
    if (Number.isFinite(at)) return at
    const iso = new Date(nowMs).toISOString()
    const { error } = await supabase.from('system_state')
      .upsert({ key: BASELINE_KEY, value: { at: iso }, updated_at: iso }, { onConflict: 'key', ignoreDuplicates: true })
    if (error) throw error
    return nowMs
  } catch (_) { return null }
}

async function checkCron(supabase, nowMs = Date.now()) {
  try {
    const row = await readState(supabase, HEARTBEAT_KEY)
    const at = row && row.value && row.value.at ? Date.parse(row.value.at) : NaN
    if (!Number.isFinite(at)) {
      // No heartbeat yet. Normal right after the first deploy — but only for so long.
      const baseline = await ensureCronBaseline(supabase, nowMs)
      const waited = baseline === null ? null : Math.max(0, Math.round((nowMs - baseline) / 60000))
      if (waited !== null && waited > CRON_STALE_MINUTES)
        return { known: false, lastRunAt: null, ageMinutes: null, stale: true, ok: false, waitedMinutes: waited,
          detail: `no cron heartbeat has ever been recorded, ${waited} minutes after this deployment was first checked — the hourly trigger is not running (see [triggers] in wrangler.toml and the Worker's Triggers tab)` }
      return { known: false, lastRunAt: null, ageMinutes: null, stale: false, ok: true, waitedMinutes: waited, detail: 'no heartbeat recorded yet (the first hourly run writes one)' }
    }
    const ageMinutes = Math.round((nowMs - at) / 60000)
    const stale = ageMinutes > CRON_STALE_MINUTES
    return { known: true, lastRunAt: new Date(at).toISOString(), ageMinutes, stale, ok: !stale, detail: stale ? `the hourly cron last ran ${ageMinutes} minutes ago — scheduled sweeps are not running` : null }
  } catch (err) {
    return { known: false, lastRunAt: null, ageMinutes: null, stale: false, ok: true, detail: `could not read cron heartbeat (${err.message})` }
  }
}

// Cross-cutting infra round 4, G2 — probes for the dependencies that used to fail silently.
// Email: the cron and /healthz only proved the DATABASE side. A revoked Resend key, an exhausted quota or an
// unverified domain left every verification / reset / receipt email failing while health read green. The
// provider is not called (that would spend quota and need a full-access key); instead the outcome of the last
// hour's real sends is read from email_logs: several failures and NOT ONE success means delivery is down.
const EMAIL_FAIL_MIN = 5
async function checkEmailDelivery(supabase, nowMs = Date.now()) {
  try {
    const since = new Date(nowMs - 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase.from('email_logs').select('status').gte('created_at', since).limit(500)
    if (error) throw error
    const rows = Array.isArray(data) ? data : []
    const sent = rows.filter(r => r.status === 'sent').length
    const failed = rows.filter(r => r.status === 'failed').length
    const down = failed >= EMAIL_FAIL_MIN && sent === 0
    return { ok: !down, sent, failed, detail: down ? `${failed} emails failed in the last hour and none were delivered — check the Resend key, quota and sending domain` : null }
  } catch (err) { return { ok: true, sent: null, failed: null, detail: `could not read email_logs (${err.message})` } }
}

// R2: a HEAD on a key that does not exist answers null when the bucket is reachable and throws when it is not.
async function checkStorage(env) {
  if (!env || !env.RESUMES_BUCKET || typeof env.RESUMES_BUCKET.head !== 'function') return { ok: true, skipped: true }
  try {
    await Promise.race([
      env.RESUMES_BUCKET.head('__healthcheck__'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 3s')), 3000)),
    ])
    return { ok: true }
  } catch (err) { return { ok: false, detail: `resume storage (R2) is not answering: ${err.message}` } }
}

async function computeHealth(env, supabase, { nowMs = Date.now() } = {}) {
  const config = validateEnv(env)
  const bindings = Object.fromEntries(BINDINGS.map(b => [b, !!(env && env[b])]))
  // Both rate-limit backends missing means no limiting at all; the DO alone missing is the degraded KV fallback.
  const bindingsOk = bindings.RESUMES_BUCKET && bindings.FIX_QUEUE && (bindings.RATE_LIMIT_DO || bindings.RATE_LIMIT_KV)

  let db = { ok: true }
  try {
    const { error } = await supabase.from('system_state').select('key').limit(1)
    // A missing system_state table is reported by the schema check; anything else is a real DB problem.
    if (error && !/system_state|relation|does not exist|schema cache/i.test(error.message || '')) throw error
  } catch (err) { db = { ok: false, detail: err.message } }

  const [schema, cron, email, storage] = await Promise.all([checkSchema(supabase), checkCron(supabase, nowMs), checkEmailDelivery(supabase, nowMs), checkStorage(env)])
  const problems = []
  const notes = []
  if (config.fatal.length) problems.push(...config.fatal.map(f => `config: ${f}`))
  if (!bindingsOk) problems.push('a required binding is missing')
  if (!db.ok) problems.push(`database: ${db.detail}`)
  if (!schema.ok) problems.push(`schema: ${schema.detail || `expected ${schema.expected}, found ${schema.actual}`}`)
  else if (schema.ahead) notes.push(`schema: ${schema.detail}`)
  if (!cron.ok) problems.push(`cron: ${cron.detail}`)
  if (!email.ok) problems.push(`email: ${email.detail}`)
  if (!storage.ok) problems.push(`storage: ${storage.detail}`)
  if (!(env && env.ALERT_WEBHOOK_URL)) notes.push('alerts: ALERT_WEBHOOK_URL is not set — owner alerts travel only by email, the same provider whose outage they would report')
  return {
    ok: problems.length === 0,
    problems,
    notes,
    schema, cron, db, email, storage,
    bindings,
    config: { fatal: config.fatal, warnings: config.warnings },
    checkedAt: new Date(nowMs).toISOString(),
  }
}

module.exports = { computeHealth, checkEmailDelivery, checkStorage, recordCronHeartbeat, checkSchema, checkCron, CRON_STALE_MINUTES, SCHEMA_KEY, HEARTBEAT_KEY, BASELINE_KEY }
