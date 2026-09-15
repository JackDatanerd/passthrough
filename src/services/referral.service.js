// Referral/discount-code pricing. This is the piece that makes a referral
// code actually change what gets charged, not just what gets displayed:
// pricing.controller.js (the public quote) and payments.controller.js (the
// actual Paystack charge) both call resolvePrice() with the same inputs, so
// a shown price and a charged price can never independently drift — same
// principle config/constants.js's priceForTier()/isPromoActive() already
// apply to the site-wide promo.
//
// Usage-limit race, flagged the same way middleware/rateLimiter.js flags
// its own: under a concurrent burst against the exact same code, two
// redemptions could both pass the under-limit check before either's
// increment lands, letting a couple of extra uses through right at the
// boundary. Acceptable for a marketing usage cap; the uses_so_far COUNTER
// itself stays exact regardless (see increment_referral_code_usage in the
// migration) — only the pre-check has this benign race, not the bookkeeping.

const c = require('../config/constants')

async function lookupCode(supabase, rawCode) {
  if (!rawCode) return null
  const code = String(rawCode).trim().toUpperCase()
  if (!code) return null
  const { data, error } = await supabase
    .from('referral_codes').select('*').eq('code', code).maybeSingle()
  if (error) throw error
  return data
}

function isCodeUsable(row) {
  if (!row) return false
  if (!row.active) return false
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return false
  if (row.usage_limit != null && row.uses_so_far >= row.usage_limit) return false
  return true
}

/**
 * resolvePrice(supabase, fixTier, env, rawReferralCode)
 *   -> { amount, currency, referralApplied, referralCode: row|null }
 *
 * Falls through to normal promo/standard pricing on ANY invalid, expired,
 * exhausted, inactive, or tier-less code — silently. A bad or stale code in
 * a URL or an old screenshot should never block checkout; it should just
 * not apply, exactly like an expired promo would elsewhere in this app.
 */
async function resolvePrice(supabase, fixTier, env, rawReferralCode) {
  const standard = c.priceForTier(fixTier, env)

  if (!rawReferralCode)
    return { amount: standard, currency: c.CURRENCY, referralApplied: false, referralCode: null }

  const codeRow = await lookupCode(supabase, rawReferralCode)
  const tierPrice = codeRow?.tier_prices?.[fixTier]

  if (!isCodeUsable(codeRow) || tierPrice == null)
    return { amount: standard, currency: c.CURRENCY, referralApplied: false, referralCode: null }

  return { amount: tierPrice, currency: c.CURRENCY, referralApplied: true, referralCode: codeRow }
}

/**
 * recordConversion(supabase, payment)
 *
 * Call exactly once, from the single fulfillment path that wins the atomic
 * idempotency race in payments.controller.js's verifyPayment or
 * webhooks.controller.js's handlePaystack (both already guard fulfillment
 * with an UPDATE...RETURNING that only one caller can ever see rows from
 * for a given payment) — never call this speculatively or more than once
 * per payment. The unique constraint on commission_ledger.payment_id is a
 * backstop, not the primary guard.
 */
async function recordConversion(supabase, payment) {
  if (!payment?.referral_code_id) return

  const { data: codeRow, error: codeErr } = await supabase
    .from('referral_codes').select('id, partner_id').eq('id', payment.referral_code_id).maybeSingle()
  if (codeErr) { console.error('recordConversion code lookup:', codeErr.message); return }
  if (!codeRow) return

  const { data: partner, error: partnerErr } = await supabase
    .from('partners').select('commission_rate').eq('id', codeRow.partner_id).maybeSingle()
  if (partnerErr) { console.error('recordConversion partner lookup:', partnerErr.message); return }
  if (!partner) return

  const commissionRate = Number(partner.commission_rate)
  const commissionAmountCents = Math.round(payment.amount_cents * commissionRate)

  const { error: ledgerErr } = await supabase.from('commission_ledger').insert({
    payment_id:              payment.id,
    partner_id:              codeRow.partner_id,
    referral_code_id:        codeRow.id,
    gross_amount_cents:      payment.amount_cents,
    commission_rate:         commissionRate,
    commission_amount_cents: commissionAmountCents
  })
  if (ledgerErr) {
    if (ledgerErr.code === '23505') return  // already recorded — harmless duplicate call
    console.error('recordConversion ledger insert:', ledgerErr.message)
    return
  }

  const { error: rpcErr } = await supabase.rpc('increment_referral_code_usage', { p_code_id: codeRow.id })
  if (rpcErr) console.error('recordConversion usage increment:', rpcErr.message)
}

module.exports = { resolvePrice, recordConversion }
