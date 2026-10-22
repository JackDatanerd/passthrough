// Promotions run from the admin panel instead of by editing wrangler.toml and redeploying.
//
// The promo is one small record in system_state (key 'promo'): on/off, a name, an optional start, an end, and the price of each
// tier while it runs. Everything that prices a purchase already reads the promo from `env` (constants.isPromoActive / priceForTier /
// priceTable / promoLabel), so the record is handed over as a per-request COPY of env with those fields replaced. Nothing is
// mutated in place, and no stored record means the deploy settings (wrangler.toml [vars] and the table in constants.js) apply
// exactly as before: they are the fallback, and "Revert to deploy settings" in the panel simply deletes the record.
//
// An isolate re-reads the record at most every TTL_MS (an admin's change reaches every isolate within that long; the isolate that
// handled the save sees it at once). A failed read keeps serving the last good record and tries again shortly: pricing must never
// fail because this lookup did.
const KEY = 'promo'
const TTL_MS = 30 * 1000
const RETRY_AFTER_ERROR_MS = 10 * 1000
const TIERS = ['FIX', 'BADGE', 'FIX_PLAIN']

let cache = null          // { at, value }   value: the stored record or null
let inflight = null

function isRecord(v) {
  return !!v && typeof v === 'object' && typeof v.active === 'boolean' && typeof v.endsAt === 'string' && v.prices && typeof v.prices === 'object'
}

async function readStored(supabase) {
  const { data, error } = await supabase.from('system_state').select('value').eq('key', KEY).maybeSingle()
  if (error) throw error
  return data && isRecord(data.value) ? data.value : null
}

// The stored promo record (or null), cached per isolate. Never throws.
async function current(supabase, now = Date.now()) {
  if (cache && now - cache.at < (cache.failed ? RETRY_AFTER_ERROR_MS : TTL_MS)) return cache.value
  if (!inflight) {
    inflight = readStored(supabase)
      .then(value => { cache = { at: Date.now(), value }; return value })
      .catch(err => {
        console.error('promo config read failed:', err.message)
        cache = { at: Date.now(), value: cache ? cache.value : null, failed: true }
        return cache.value
      })
      .finally(() => { inflight = null })
  }
  return inflight
}

function invalidate(value) { cache = value === undefined ? null : { at: Date.now(), value } }

// A copy of env carrying the stored promo. The deploy-time values ride along (__deployPromo) so the admin panel can show what
// "revert" would go back to.
function overlayEnv(env, record) {
  if (!record) return env
  return {
    ...env,
    __deployPromo: { active: env.PROMO_ACTIVE === 'true', endsAt: env.PROMO_ENDS_AT || null },
    __promoSource: 'admin',
    PROMO_ACTIVE: record.active ? 'true' : 'false',
    PROMO_ENDS_AT: record.endsAt,
    PROMO_STARTS_AT: record.startsAt || '',
    PROMO_LABEL: record.label || '',
    PROMO_PRICES_JSON: JSON.stringify(record.prices || {}),
    PROMO_PRICES_CURRENCY: record.currency || '',
  }
}

async function save(supabase, record) {
  const { error } = await supabase.from('system_state')
    .upsert({ key: KEY, value: record, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) throw error
  invalidate(record)
}

async function clear(supabase) {
  const { error } = await supabase.from('system_state').delete().eq('key', KEY)
  if (error) throw error
  invalidate(null)
}

module.exports = { KEY, TIERS, current, overlayEnv, save, clear, invalidate, readStored, isRecord }
