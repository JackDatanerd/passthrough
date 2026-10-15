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
// applied_migrations (migration 0082) records one row per migration from this version on. schema_version is a single
// integer, so a skipped migration is invisible once a later one has been applied; the ledger is what notices.
const LEDGER_FROM_VERSION = 82
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
async function missingFromLedger(supabase, expected) {
  try {
    const { data, error } = await supabase.from('applied_migrations').select('version').gte('version', LEDGER_FROM_VERSION)
    if (error) throw error
    const have = new Set((data || []).map(r => Number(r.version)))
    const versions = []
    for (let v = LEDGER_FROM_VERSION; v <= expected; v++) if (!have.has(v)) versions.push(v)
    return { versions }
  } catch (err) {
    return { versions: [], error: err.message }
  }
}

async function checkSchema(supabase) {
  const expected = c.EXPECTED_SCHEMA_VERSION
  try {
    const row = await readState(supabase, SCHEMA_KEY)
    const actual = row && row.value && Number.isFinite(Number(row.value.version)) ? Number(row.value.version) : null
    if (actual === null)
      return { expected, actual, ok: false, ahead: false, detail: 'schema_version not recorded — apply migration 0059 and every one after it' }
    if (actual < expected)
      return { expected, actual, ok: false, ahead: false, detail: `the database is at migration ${actual} but this code expects ${expected} — apply every migration above ${actual}, in order` }
    // The ledger says which migrations actually ran. Only versions this code expects are required (a database AHEAD of
    // the code legitimately holds more), and only from the version the ledger started at.
    if (expected >= LEDGER_FROM_VERSION) {
      const missing = await missingFromLedger(supabase, expected)
      if (missing.error)
        return { expected, actual, ok: false, ahead: false, detail: `could not read applied_migrations (${missing.error}) — apply migration 0082 and every one after it, in order` }
      if (missing.versions.length)
        return { expected, actual, ok: false, ahead: false, missing: missing.versions,
          detail: `the database reports migration ${actual} but migration${missing.versions.length > 1 ? 's' : ''} ${missing.versions.map(v => String(v).padStart(4, '0')).join(', ')} ${missing.versions.length > 1 ? 'were' : 'was'} never recorded as applied — it was skipped; apply it, then every migration after it, in order (the files from 0082 on can be re-run as a range; each one only ever moves schema_version forward)` }
    }
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
    // email_logs's timestamp column is sent_at (0001). This filtered on `created_at`, which the table has never had:
    // PostgREST answered with a column error, the catch below turned it into "ok", and the probe could never see a
    // Resend outage. tests/schemaColumns.test.js now checks column names in queries against the migrations.
    const { data, error } = await supabase.from('email_logs').select('status').gte('sent_at', since).limit(500)
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

// Round 9 (webhooks G1): Paystack webhooks not reaching the app is invisible everywhere else (payments still settle
// through the buyer's return visit), so an uptime monitor reading /healthz is told. Lazy require: the controller pulls in
// most of the app. Anything unreadable counts as fine — it must never turn health red on its own.
async function checkWebhookDeliveryHealth(supabase, nowMs = Date.now()) {
  try {
    const wh = require('../controllers/webhooks.controller')
    const problem = wh.deliveryProblem(await wh.computeWebhookHealth(supabase, { now: nowMs }))
    return { ok: !problem, detail: problem }
  } catch (_) { return { ok: true, detail: null } }
}

// Cross-cutting infra round 5: the deep check only proved the rate-limit BINDINGS exist. The limiter fails OPEN on any
// backend error, so a Durable Object that is broken, mis-migrated or timing out disables every limit and the account
// lockout silently — the only trace was a throttled owner email. A read-only round trip through the real backend
// (the one a request would use, including its timeout) makes the monitor page on it.
async function checkRateLimiter(env) {
  if (!(env && (env.RATE_LIMIT_DO || env.RATE_LIMIT_KV))) return { ok: true, detail: null, backend: null }
  try {
    const { runOp, backendName } = require('../middleware/rateLimiter')
    const backend = backendName(env)
    await runOp(env, 'missRead', { key: 'rl:healthprobe', max: 1 })
    return { ok: true, detail: null, backend }
  } catch (err) {
    return { ok: false, detail: `the rate-limit backend is not answering (limits and the login lockout are failing open): ${err && err.message}`, backend: null }
  }
}

async function computeHealth(env, supabase, { nowMs = Date.now() } = {}) {
  const config = validateEnv(env)
  const bindings = Object.fromEntries(BINDINGS.map(b => [b, !!(env && env[b])]))
  // Both rate-limit backends missing means no limiting at all; the DO alone missing is the degraded KV fallback.
  // CROSS-CUTTING INFRA ROUND 10 (bug): BROWSER was listed above but never required here, and validateEnv never warned about it.
  // Without it every PDF render fails and the caller quietly degrades a paid fix to DOCX-only, while /healthz stayed green.
  const bindingsOk = bindings.RESUMES_BUCKET && bindings.FIX_QUEUE && bindings.BROWSER && (bindings.RATE_LIMIT_DO || bindings.RATE_LIMIT_KV)

  let db = { ok: true }
  try {
    const { error } = await supabase.from('system_state').select('key').limit(1)
    // A missing system_state table is reported by the schema check; anything else is a real DB problem.
    if (error && !/system_state|relation|does not exist|schema cache/i.test(error.message || '')) throw error
  } catch (err) { db = { ok: false, detail: err.message } }

  const [schema, cron, email, storage, webhooks, limiter] = await Promise.all([checkSchema(supabase), checkCron(supabase, nowMs), checkEmailDelivery(supabase, nowMs), checkStorage(env), checkWebhookDeliveryHealth(supabase, nowMs), checkRateLimiter(env)])
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
  if (!limiter.ok) problems.push(`rate limiter: ${limiter.detail}`)
  if (!webhooks.ok) problems.push(`webhooks: ${webhooks.detail} — check the webhook URL and signing key in the Paystack dashboard`)
  if (!(env && env.ALERT_WEBHOOK_URL)) notes.push('alerts: ALERT_WEBHOOK_URL is not set — owner alerts travel only by email, the same provider whose outage they would report')
  return {
    ok: problems.length === 0,
    problems,
    notes,
    schema, cron, db, email, storage, webhooks, limiter,
    bindings,
    config: { fatal: config.fatal, warnings: config.warnings },
    checkedAt: new Date(nowMs).toISOString(),
  }
}

module.exports = { computeHealth, checkRateLimiter, checkWebhookDeliveryHealth, checkEmailDelivery, checkStorage, recordCronHeartbeat, checkSchema, checkCron, CRON_STALE_MINUTES, LEDGER_FROM_VERSION, SCHEMA_KEY, HEARTBEAT_KEY, BASELINE_KEY }
