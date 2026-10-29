// Experts Phase 2A: the expert realm's flag, secret, origin and tunable limits. Nothing here touches the main app's configuration.
//
// Flag: Worker variable EXPERT_REALM_ENABLED, on only for the exact string "true". Unset = off. While off, every realm route answers the
// app's ordinary 404 and nothing else in the app behaves differently. (EXPERTS_ENABLED still governs the Phase 1 pilot, separately.)
const jwtMainSecret = env => (env && env.JWT_SECRET) || null

const realmEnabled = env => !!env && env.EXPERT_REALM_ENABLED === 'true'

// The realm signs with its OWN secret: at least 32 characters, and different from JWT_SECRET (main app) and EXPERT_JWT_SECRET (Phase 1
// pilot). A shared secret would make tokens interchangeable between realms, so a bad secret means the realm refuses to run.
function secretOf(env) {
  const s = env && env.EXPERT_REALM_SECRET
  if (typeof s !== 'string' || s.length < 32) return null
  if (s === jwtMainSecret(env) || s === (env && env.EXPERT_JWT_SECRET)) return null
  return s
}

// The expert site: https://experts.usepassthrough.com (EXPERT_SITE_URL). The API is reached THROUGH that host (a Worker route on
// experts.usepassthrough.com/api/*), so the cookie is first-party to the expert site and no other site can ever send it.
const normalizeOrigin = v => String(v || '').trim().replace(/\/+$/, '')
const siteOrigin = env => normalizeOrigin(env && env.EXPERT_SITE_URL) || null
function siteHost(env) { try { return new URL(siteOrigin(env)).host } catch (_) { return null } }

const COOKIE_NAME = '__Host-pt_xr'     // __Host-: Secure, Path=/, no Domain attribute: the browser sends it to this exact host only

const DEFAULTS = Object.freeze({
  idle_hours: 8, absolute_days: 7, pending_minutes: 10, step_up_minutes: 10, reset_minutes: 30,
  max_failures: 5, lock_minutes: 15, recovery_codes: 10, min_password_length: 12,
})
const LIMITS = Object.freeze({ idle_hours: [1, 24], absolute_days: [1, 30], pending_minutes: [2, 30], step_up_minutes: [1, 60], reset_minutes: [10, 120],
  max_failures: [3, 10], lock_minutes: [5, 240] })

// Settings, not constants: system_state key 'expert_realm' may override any key in DEFAULTS (clamped to LIMITS); a missing row or a bad value
// falls back to the default. Cached for 30 seconds per isolate.
let cache = { at: 0, value: null }
async function loadSettings(supabase, now = Date.now()) {
  if (cache.value && now - cache.at < 30e3) return cache.value
  let row = null
  try { const { data } = await supabase.from('system_state').select('value').eq('key', 'expert_realm').maybeSingle(); row = data && data.value } catch (_) { row = null }
  const out = { ...DEFAULTS }
  if (row && typeof row === 'object') {
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) { const v = Number(row[k]); if (Number.isFinite(v) && v >= lo && v <= hi) out[k] = v }
  }
  cache = { at: now, value: out }
  return out
}
const resetSettingsCache = () => { cache = { at: 0, value: null } }

module.exports = { realmEnabled, secretOf, siteOrigin, siteHost, normalizeOrigin, COOKIE_NAME, DEFAULTS, LIMITS, loadSettings, resetSettingsCache }
