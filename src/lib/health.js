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

async function checkSchema(supabase) {
  const expected = c.EXPECTED_SCHEMA_VERSION
  try {
    const row = await readState(supabase, SCHEMA_KEY)
    const actual = row && row.value && Number.isFinite(Number(row.value.version)) ? Number(row.value.version) : null
    return { expected, actual, ok: actual === expected, detail: actual === null ? 'schema_version not recorded — apply migration 0059 and every one after it' : null }
  } catch (err) {
    // A missing table is exactly "migration 0059 has not been applied".
    return { expected, actual: null, ok: false, detail: `could not read schema_version (${err.message}) — apply migration 0059 and every one after it` }
  }
}

async function checkCron(supabase, nowMs = Date.now()) {
  try {
    const row = await readState(supabase, HEARTBEAT_KEY)
    const at = row && row.value && row.value.at ? Date.parse(row.value.at) : NaN
    if (!Number.isFinite(at)) return { known: false, lastRunAt: null, ageMinutes: null, stale: false, ok: true, detail: 'no heartbeat recorded yet (the first hourly run writes one)' }
    const ageMinutes = Math.round((nowMs - at) / 60000)
    const stale = ageMinutes > CRON_STALE_MINUTES
    return { known: true, lastRunAt: new Date(at).toISOString(), ageMinutes, stale, ok: !stale, detail: stale ? `the hourly cron last ran ${ageMinutes} minutes ago — scheduled sweeps are not running` : null }
  } catch (err) {
    return { known: false, lastRunAt: null, ageMinutes: null, stale: false, ok: true, detail: `could not read cron heartbeat (${err.message})` }
  }
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

  const [schema, cron] = await Promise.all([checkSchema(supabase), checkCron(supabase, nowMs)])
  const problems = []
  if (config.fatal.length) problems.push(...config.fatal.map(f => `config: ${f}`))
  if (!bindingsOk) problems.push('a required binding is missing')
  if (!db.ok) problems.push(`database: ${db.detail}`)
  if (!schema.ok) problems.push(`schema: ${schema.detail || `expected ${schema.expected}, found ${schema.actual}`}`)
  if (!cron.ok) problems.push(`cron: ${cron.detail}`)
  return {
    ok: problems.length === 0,
    problems,
    schema, cron, db,
    bindings,
    config: { fatal: config.fatal, warnings: config.warnings },
    checkedAt: new Date(nowMs).toISOString(),
  }
}

module.exports = { computeHealth, recordCronHeartbeat, checkSchema, checkCron, CRON_STALE_MINUTES, SCHEMA_KEY, HEARTBEAT_KEY }
