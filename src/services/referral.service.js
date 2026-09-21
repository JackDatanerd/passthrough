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
const emailService = require('./email.service')

async function lookupCode(supabase, rawCode) {
  if (!rawCode) return null
  const code = String(rawCode).trim().toUpperCase()
  if (!code) return null
  // AUDIT FIX (Section 10, feature gap): now also pulls the owning
  // partner's status. partner_status_enum ('ACTIVE'/'PAUSED') existed on
  // the partners table since 0011 with no endpoint that ever set it AND no
  // check anywhere that ever read it — pausing a partner (even by hand,
  // directly in the DB, the only way it could be set at all before this
  // fix) had zero effect: their codes kept discounting checkout and kept
  // crediting commission exactly as if nothing had changed. See
  // isCodeUsable() below for where this actually gets enforced now.
  const { data, error } = await supabase
    .from('referral_codes').select('*, partners(status)').eq('code', code).maybeSingle()
  if (error) throw error
  return data
}

function isCodeUsable(row) {
  if (!row) return false
  if (!row.active) return false
  // A paused partner's codes stop applying to NEW checkouts immediately.
  // Deliberately NOT re-checked in recordConversion() below — a payment
  // that already went through at the discounted price, under valid terms
  // at the time, still owes its commission regardless of what happens to
  // the partner's status afterward. "Paused" means "stop new referrals,"
  // not "retroactively deny commission on completed sales."
  if (row.partners?.status !== 'ACTIVE') return false
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

  // BUGFIX: tier_prices on a referral code is a static, admin-set cents
  // value with no awareness of an active site-wide promo (isPromoActive()).
  // Charging tierPrice unconditionally meant a partner's own discount code
  // could become WORSE than the public price the instant a promo undercut
  // it (e.g. a code offering $39 vs a $29 promo) — a stranger with no code
  // would then get a better deal than the partner's own referred customer.
  // Taking the lower of the two means a referral code can only ever help,
  // never hurt, and the code stays "applied" (referralApplied: true) either
  // way — the partner is still attributed and credited via recordConversion
  // on whatever amount actually gets charged, they just don't out-charge
  // an active promo.
  return { amount: Math.min(tierPrice, standard), currency: c.CURRENCY, referralApplied: true, referralCode: codeRow }
}

/**
 * recordConversion(supabase, payment, env)
 *
 * Call exactly once, from the single fulfillment path that wins the atomic
 * idempotency race in payments.controller.js's verifyPayment or
 * webhooks.controller.js's handlePaystack (both already guard fulfillment
 * with an UPDATE...RETURNING that only one caller can ever see rows from
 * for a given payment) — never call this speculatively or more than once
 * per payment. The unique constraint on commission_ledger.payment_id is a
 * backstop, not the primary guard.
 *
 * `env` is used ONLY to alert on failure (AUDIT FIX, Admin panel pass —
 * see the ledger-insert branch below). Every other payment-critical
 * failure in this codebase (Paystack init/verify, webhook signature/amount
 * mismatches) pages the owner via sendOwnerAlert; this function's two
 * failure points previously only logged to console, which nobody sees in
 * production unless they're actively running `wrangler tail`. A failure
 * here means a completed, already-charged sale silently fails to generate
 * (or count) its commission — the partner is underpaid and the admin
 * panel's own "pending commission" figure is quietly wrong, with no signal
 * that either thing happened.
 */
async function recordConversion(supabase, payment, env) {
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
    if (env) {
      await emailService.sendOwnerAlert(env,
        'Commission ledger write failed — partner will be underpaid unless fixed manually',
        `paymentId: ${payment.id}\npartnerId: ${codeRow.partner_id}\nreferralCodeId: ${codeRow.id}\ngrossAmountCents: ${payment.amount_cents}\nerror: ${ledgerErr.message}\n\nThis payment charged successfully but no commission_ledger row was created. The partner's pending balance will not reflect this sale until a row is inserted manually.`
      ).catch(() => {})
    }
    return
  }

  const { error: rpcErr } = await supabase.rpc('increment_referral_code_usage', { p_code_id: codeRow.id })
  if (rpcErr) {
    console.error('recordConversion usage increment:', rpcErr.message)
    if (env) {
      await emailService.sendOwnerAlert(env,
        'Referral code usage counter failed to increment',
        `referralCodeId: ${codeRow.id}\npaymentId: ${payment.id}\nerror: ${rpcErr.message}\n\nThe commission was still recorded correctly. Only uses_so_far (the usage-limit counter) under-counted this redemption — check whether the code's usage_limit needs manual adjustment.`
      ).catch(() => {})
    }
  }
}

module.exports = { resolvePrice, recordConversion }
