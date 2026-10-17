// Strict numeric env parsing. parseInt('7d') is 7 and Number('10m') is NaN: a mistyped value used to
// silently become a tiny number or switch a guard off. A value is accepted only if the WHOLE trimmed
// string is a plain decimal number inside [min, max]; anything else yields the fallback.
function parseNumEnv(raw, { min = -Infinity, max = Infinity, integer = true } = {}) {
  if (raw === undefined || raw === null) return { ok: false, unset: true }
  const s = String(raw).trim()
  if (s === '') return { ok: false, unset: true }
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, unset: false }
  const n = Number(s)
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) return { ok: false, unset: false }
  return { ok: true, value: n }
}
function numEnv(raw, fallback, opts) {
  const r = parseNumEnv(raw, opts)
  return r.ok ? r.value : fallback
}
// Names validated by validateEnv, with the range each accepts.
const NUMERIC_ENV = {
  ADMIN_SESSION_MAX_HOURS:  { min: 0, max: 8760 },
  ADMIN_STEP_UP_MINUTES:    { min: 0, max: 240 },
  JWT_EXPIRES_IN_SECONDS:   { min: 60, max: 31536000 },
  SUPABASE_TIMEOUT_MS:      { min: 1000, max: 120000 },
  RATE_LIMIT_DO_TIMEOUT_MS: { min: 1, max: 30000 },
  SCAN_IP_DAILY_CAP:        { min: 0, max: 100000 },
  COMMISSION_HOLD_DAYS:     { min: 0, max: 365 },
  REVERSAL_CHECKS_PER_RUN:  { min: 1, max: 100 },
  PAYOUT_DETAILS_HOLD_HOURS: { min: 0, max: 8760 },
  COMMISSION_MIN_PAYOUT_CENTS: { min: 0, max: 100000000 },
  REFERRAL_MIN_PRICE_PCT:   { min: 0, max: 100, integer: false },
  REFERRAL_VELOCITY_ALERT:  { min: 0, max: 100000 },
}
module.exports = { parseNumEnv, numEnv, NUMERIC_ENV }
