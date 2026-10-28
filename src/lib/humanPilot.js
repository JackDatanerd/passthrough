'use strict'

// Experts Phase 1 (concierge pilot): the flag, who may order, the settings (read from system_state key 'human_pilot', seeded by
// migration 0121: NO price or pay figure is written in code) and the arithmetic that hangs off them.

const SETTINGS_KEY = 'human_pilot'
const TIERS = ['polish', 'seven_day', 'forty_eight_hour', 'twenty_four_hour']
const KIND_BY_TIER = { polish: 'human_polish', seven_day: 'human_seven_day', forty_eight_hour: 'human_forty_eight_hour', twenty_four_hour: 'human_twenty_four_hour' }
const TIER_BY_KIND = Object.fromEntries(Object.entries(KIND_BY_TIER).map(([t, k]) => [k, t]))
const TIER_LABELS = { polish: 'Polish', seven_day: '7-day rewrite', forty_eight_hour: '48-hour rewrite', twenty_four_hour: '24-hour rewrite' }
const tierLabel = t => TIER_LABELS[t] || 'Human rewrite'
const isHumanKind = kind => typeof kind === 'string' && kind in TIER_BY_KIND

// Off unless the variable is exactly "true" (same rule as HUMAN_DEMAND_ENABLED). While off, every human route answers the app's 404.
const humanEnabled = env => !!env && String(env.EXPERTS_ENABLED || '').trim() === 'true'

// Who may order: EXPERTS_ALLOWED_EMAILS is a comma list of account emails, or "*" for everyone. Empty or unset = nobody.
function userAllowed(env, user) {
  const raw = String((env && env.EXPERTS_ALLOWED_EMAILS) || '').trim().toLowerCase()
  if (!raw || !user) return false
  if (raw === '*') return true
  const email = String(user.email || '').trim().toLowerCase()
  return !!email && raw.split(',').map(s => s.trim()).filter(Boolean).includes(email)
}

const isInt = n => Number.isInteger(n) && n >= 0
function validSettings(s) {
  if (!s || typeof s !== 'object') return false
  for (const k of [...TIERS, 'cover_letter']) if (!isInt(s.prices?.[k]) || !isInt(s.pay?.[k])) return false
  for (const k of TIERS) if (typeof s.tiers_enabled?.[k] !== 'boolean') return false
  return isInt(s.pilot_cap_orders) && isInt(s.accept_auto_hours) && s.accept_auto_hours > 0 && isInt(s.revision_window_days) && isInt(s.earnings_hold_days)
}

// -> settings object, or null when the row is missing or malformed (callers fail CLOSED: nothing is sold on guessed prices).
async function loadSettings(supabase) {
  const { data, error } = await supabase.from('system_state').select('value').eq('key', SETTINGS_KEY).maybeSingle()
  if (error) throw error
  return data && validSettings(data.value) ? data.value : null
}

// What a given order costs and pays, from the settings in force right now. The caller stores the result ON THE JOB ROW.
function quote(settings, tier, addCoverLetter) {
  if (!TIERS.includes(tier)) return { ok: false, code: 'BAD_TIER' }
  if (!settings.tiers_enabled[tier]) return { ok: false, code: 'TIER_UNAVAILABLE' }
  const cover = addCoverLetter ? 1 : 0
  return {
    ok: true, tier, kind: KIND_BY_TIER[tier], addCoverLetter: !!cover,
    tierPriceCents: settings.prices[tier], coverPriceCents: cover * settings.prices.cover_letter,
    priceCents: settings.prices[tier] + cover * settings.prices.cover_letter,
    expertPayCents: settings.pay[tier] + cover * settings.pay.cover_letter,
  }
}

// Promised deadline = paid time + the tier's turnaround; the internal deadline is earlier by the tier's buffer. Time spent waiting
// for the customer (paused_seconds, and a pause still running) pushes both back. Polish has no turnaround: no deadline.
function deadlines(settings, tier, paidAt) {
  const hours = settings.turnaround_hours && settings.turnaround_hours[tier]
  if (!hours) return { promised: null, internal: null }
  const base = new Date(paidAt).getTime()
  const buffer = (settings.internal_buffer_hours && settings.internal_buffer_hours[tier]) || 0
  return { promised: new Date(base + hours * 3600e3).toISOString(), internal: new Date(base + (hours - buffer) * 3600e3).toISOString() }
}

const JOB_NO_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'   // no 0/O/1/I/L/U: read aloud to a customer without mistakes
function newJobNumber() {
  const b = crypto.getRandomValues(new Uint8Array(6))
  return 'HJ-' + Array.from(b, x => JOB_NO_ALPHABET[x % JOB_NO_ALPHABET.length]).join('')
}

module.exports = { tierLabel, SETTINGS_KEY, TIERS, KIND_BY_TIER, TIER_BY_KIND, isHumanKind, humanEnabled, userAllowed, validSettings, loadSettings, quote, deadlines, newJobNumber }
