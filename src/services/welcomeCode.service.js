// Welcome codes (migration 0105): one personal, single-use discount code on the full fix for each account that verifies its
// email. The code lives in referral_codes like any other, owned by the 0%-commission system partner, and carries the
// account's id so it prices for that account only (see priceForResolvedCode in referral.service.js). It is worth
// WELCOME_PERCENT_OFF off the price in force when it is USED, so a promo that starts, ends or is extended afterwards never
// changes what the account was promised.
//
// Everything here is best-effort from the caller's side: issuing a code must never break email verification, so
// issueWelcomeCode reports what happened instead of throwing for the expected cases (migration not applied, a race with
// another request), and only a genuinely unexpected database error is thrown for the caller to log.
const c = require('../config/constants')

// No 0/O/1/I: a code is read off a screen and typed. 32 symbols, so a random byte maps onto it without bias.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const SUFFIX_LENGTH = 5
const MAX_CODE_TRIES = 5
const DAY_MS = 24 * 60 * 60 * 1000

// Up to two capital letters from the name (first and last word): "Faith Njeri" -> "FN", "Cher" -> "C", "李雷" -> "". Initials, not
// the name itself, so a code left behind in a payment record after the account is erased says nothing about who it was.
function initialsOf(name) {
  const words = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[\s\-_.]+/)
    .map(w => w.replace(/[^A-Za-z]/g, '')).filter(Boolean)
  if (!words.length) return ''
  const first = words[0][0]
  const last = words.length > 1 ? words[words.length - 1][0] : ''
  return (first + last).toUpperCase()
}

function randomSuffix(length = SUFFIX_LENGTH) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

// "FN-7K2QH". Falls back to "PT" when the name has no usable letters.
function generateCode(name) {
  return `${initialsOf(name) || 'PT'}-${randomSuffix()}`
}

// What the code charges for the full fix right now: WELCOME_PERCENT_OFF off the price in force (promo included, so the discount is
// real against what the buyer would otherwise pay). The same figure is recomputed when the code is redeemed (constants.
// welcomeAmountFor), so what is stored with the code is only the marker that it prices the full fix.
function welcomePriceCents(env) {
  const base = c.priceForTier('FIX', env)
  const cents = c.welcomeAmountFor(base)
  return { base, cents }
}

// Fixed length, independent of any promo: the percentage is worked out at redemption, so there is nothing to outlive.
function expiryFor(env, now) {
  return now + c.WELCOME_VALID_DAYS * DAY_MS
}

const isMissingColumn = err => !!err && (err.code === '42703' || err.code === 'PGRST204' || /column .* (does not exist|of relation)|could not find the '[^']+' column/i.test(err.message || ''))

function offerFromRow(row, env, now) {
  if (!row) return null
  if (!row.active) return null
  if (row.partners && row.partners.status !== 'ACTIVE') return null
  const expiresMs = Date.parse(row.expires_at)
  if (!Number.isFinite(expiresMs) || expiresMs <= now) return null
  if (row.usage_limit != null && (row.uses_so_far || 0) >= row.usage_limit) return null
  // The stored FIX value is only the marker that this code prices the full fix; the amount is today's price less the percentage.
  if (!row.tier_prices || !Number.isInteger(row.tier_prices.FIX)) return null
  const base = c.priceForTier('FIX', env)
  const amount = c.welcomeAmountFor(base)
  if (!(amount > 0 && amount < base)) return null
  return {
    code: row.code,
    expiresAt: new Date(expiresMs).toISOString(),
    tier: 'FIX',
    amountCents: amount,
    listAmountCents: base,
    percentOff: c.WELCOME_PERCENT_OFF,
    currency: c.activeCurrency(env),
  }
}

// The account's welcome offer if it has one that can still be used; null otherwise.
async function getWelcomeOffer(supabase, env, userId, now = Date.now()) {
  const { data, error } = await supabase.from('referral_codes')
    .select('code, tier_prices, active, usage_limit, uses_so_far, expires_at, partners(status)')
    .eq('user_id', userId).maybeSingle()
  if (error) {
    if (isMissingColumn(error)) return null          // migration 0105 not applied yet: no offer, not an error
    throw error
  }
  return offerFromRow(data, env, now)
}

// Gives the account its welcome code if it has none. Idempotent: a second call (a replayed verification link, a retry) returns
// the code the account already has.
// -> { issued: true, offer } | { issued: false, reason, offer? }   reason: 'exists' | 'migration' | 'no-system-partner' | 'no-price'
async function issueWelcomeCode(supabase, env, user, now = Date.now()) {
  const existing = await supabase.from('referral_codes').select('id').eq('user_id', user.id).maybeSingle()
  if (existing.error) {
    if (isMissingColumn(existing.error)) return { issued: false, reason: 'migration' }
    throw existing.error
  }
  if (existing.data) return { issued: false, reason: 'exists', offer: await getWelcomeOffer(supabase, env, user.id, now) }

  const expires = expiryFor(env, now)
  const { base, cents } = welcomePriceCents(env)
  if (!(cents > 0 && cents < base)) return { issued: false, reason: 'no-price' }

  for (let attempt = 0; attempt < MAX_CODE_TRIES; attempt++) {
    const code = generateCode(user.name)
    const { error } = await supabase.from('referral_codes').insert({
      partner_id: c.WELCOME_PARTNER_ID,
      code,
      tier_prices: { FIX: cents },
      active: true,
      usage_limit: 1,
      expires_at: new Date(expires).toISOString(),
      user_id: user.id,
    })
    if (!error) return { issued: true, offer: offerFromRow({ code, tier_prices: { FIX: cents }, active: true, usage_limit: 1, uses_so_far: 0, expires_at: new Date(expires).toISOString() }, env, now) }
    if (isMissingColumn(error)) return { issued: false, reason: 'migration' }
    if (error.code === '23503') {                    // foreign key: the system partner row is missing
      console.error('issueWelcomeCode: the system partner (migration 0105) does not exist')
      return { issued: false, reason: 'no-system-partner' }
    }
    if (error.code === '23505') {
      // Either the account already has a code (another request won the race) or the random code collided. Tell them apart by
      // looking, not by parsing the message: the account's own code settles it.
      const mine = await supabase.from('referral_codes').select('id').eq('user_id', user.id).maybeSingle()
      if (mine.data) return { issued: false, reason: 'exists', offer: await getWelcomeOffer(supabase, env, user.id, now) }
      continue
    }
    throw error
  }
  throw new Error('issueWelcomeCode: could not find an unused code')
}

module.exports = { issueWelcomeCode, getWelcomeOffer, generateCode, initialsOf, welcomePriceCents, expiryFor, ALPHABET }
