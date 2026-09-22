// Referral/discount-code pricing. This is the piece that makes a referral
// code actually change what gets charged, not just what gets displayed:
// pricing.controller.js (the public quote) and payments.controller.js (the
// actual Paystack charge) both call resolvePrice() with the same inputs, so
// a shown price and a charged price can never independently drift — same
// principle config/constants.js's priceForTier()/isPromoActive() already
// apply to the site-wide promo.
//
// Usage-limit gap: isCodeUsable() below is only checked in resolvePrice() —
// at quote time and at initializePayment time — never again when a payment
// actually completes (recordConversion, further down). uses_so_far is only
// incremented on completion, so the real enforcement window is the FULL
// checkout duration for every concurrent shopper, not a narrow simultaneous
// DB race. A single-use code shared in a burst can be legitimately redeemed
// by many more people than usage_limit intends, each a genuine, correctly-
// tracked commission. AUDIT FIX (bug): a proper fix is a reservation system
// (hold a slot at initializePayment time, release on abandon/fail) — out of
// scope for this pass; recordConversion now at least alerts the owner the
// first time a code's uses_so_far runs past its usage_limit, so an
// over-redeemed code doesn't sit silently unnoticed — see warnIfOverLimit.

const c = require('../config/constants')

async function lookupCode(supabase, rawCode) {
  if (!rawCode) return null
  const code = String(rawCode).trim().toUpperCase()
  if (!code) return null
  const { data, error } = await supabase
    .from('referral_codes').select('*, partners(status)').eq('code', code).maybeSingle()
  if (error) throw error
  return data
}

function isCodeUsable(row) {
  if (!row) return false
  if (!row.active) return false
  if (row.expires_at) {
    const expiresMs = Date.parse(row.expires_at)
    // Fail CLOSED on an unparseable date: NaN < Date.now() is false, so the
    // old check silently treated a corrupt expires_at as "never expires".
    if (Number.isNaN(expiresMs) || expiresMs < Date.now()) return false
  }
  if (row.usage_limit != null && row.uses_so_far >= row.usage_limit) return false
  // A paused partner's codes stop applying to NEW checkouts immediately.
  // Deliberately NOT re-checked in recordConversion() — a payment that already
  // went through at the discounted price still owes its commission; "paused"
  // means "stop new referrals", not "retroactively deny commission on sales".
  if (row.partners?.status !== 'ACTIVE') return false
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
  // AUDIT FIX: this used to hardcode c.CURRENCY ('USD') in all three returns
  // below, while the actual charge (paystack.service.js, payments.controller.js's
  // insert) uses `env.PAYSTACK_CURRENCY || c.CURRENCY`. Same class of bug as
  // pricing.controller.js's getPricing — if PAYSTACK_CURRENCY is ever set,
  // the quoted currency here would silently disagree with what gets charged.
  const currency = env.PAYSTACK_CURRENCY || c.CURRENCY

  if (!rawReferralCode)
    return { amount: standard, currency, referralApplied: false, referralCode: null }

  const codeRow = await lookupCode(supabase, rawReferralCode)
  const tierPrice = codeRow?.tier_prices?.[fixTier]

  if (!isCodeUsable(codeRow) || tierPrice == null)
    return { amount: standard, currency, referralApplied: false, referralCode: null }

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
  return { amount: Math.min(tierPrice, standard), currency, referralApplied: true, referralCode: codeRow }
}

/**
 * recordConversion(supabase, payment, env?)
 *   -> { ok: boolean, recorded: boolean, reason?: string, error?: string }
 *
 * Call exactly once, from the single fulfillment path that wins the atomic
 * idempotency race in payments.controller.js's verifyPayment or
 * webhooks.controller.js's handlePaystack (both already guard fulfillment
 * with an UPDATE...RETURNING that only one caller can ever see rows from
 * for a given payment) — never call this speculatively or more than once
 * per payment. The unique constraint on commission_ledger.payment_id is a
 * backstop, not the primary guard.
 *
 * NEVER THROWS, but — unlike the previous version, which only console.error'd
 * — it now REPORTS what happened. That matters because of the idempotency
 * design above: this is the only automatic attempt a payment will ever get,
 * so a transient DB error here used to mean a partner's commission was lost
 * permanently with nobody told. Callers check `ok` and call
 * notifyConversionFailure() on false; POST /api/payments/:reference/reconcile
 * re-runs this (safely — a duplicate is a no-op) to recover.
 *
 * Each write gets one immediate retry, since the realistic failure here is a
 * transient blip rather than a persistent one.
 */
async function withOneRetry(fn) {
  const first = await fn()
  if (!first.error || first.error.code === '23505') return first
  return fn()
}

async function recordConversion(supabase, payment, env) {
  const result = await recordConversionInner(supabase, payment, env)
  // Pass `env` from the fulfilment paths so a failure pages the owner; the admin
  // reconcile endpoint omits it and just returns the result to the admin.
  if (env && !result.ok) await notifyConversionFailure(env, payment, result, 'recordConversion')
  return result
}

async function recordConversionInner(supabase, payment, env) {
  if (!payment?.referral_code_id) return { ok: true, recorded: false, reason: 'no-referral' }

  try {
    const codeRes = await withOneRetry(() => supabase
      .from('referral_codes').select('id, partner_id').eq('id', payment.referral_code_id).maybeSingle())
    if (codeRes.error) {
      console.error('recordConversion code lookup:', codeRes.error.message)
      return { ok: false, recorded: false, reason: 'code-lookup', error: codeRes.error.message }
    }
    const codeRow = codeRes.data
    if (!codeRow) return { ok: true, recorded: false, reason: 'code-not-found' }

    const partnerRes = await withOneRetry(() => supabase
      .from('partners').select('commission_rate').eq('id', codeRow.partner_id).maybeSingle())
    if (partnerRes.error) {
      console.error('recordConversion partner lookup:', partnerRes.error.message)
      return { ok: false, recorded: false, reason: 'partner-lookup', error: partnerRes.error.message }
    }
    const partner = partnerRes.data
    if (!partner) return { ok: true, recorded: false, reason: 'partner-not-found' }

    // Number(null) is 0, which would silently record a $0 commission for a
    // partner whose rate is simply missing — treat null/undefined as invalid,
    // and anything above 100% (commission larger than the sale) as invalid too.
    const commissionRate = partner.commission_rate == null ? NaN : Number(partner.commission_rate)
    if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 1)
      return { ok: false, recorded: false, reason: 'bad-commission-rate', error: `commission_rate=${partner.commission_rate}` }
    const commissionAmountCents = Math.round(payment.amount_cents * commissionRate)

    const ledgerRes = await withOneRetry(() => supabase.from('commission_ledger').insert({
      payment_id:              payment.id,
      partner_id:              codeRow.partner_id,
      referral_code_id:        codeRow.id,
      gross_amount_cents:      payment.amount_cents,
      commission_rate:         commissionRate,
      commission_amount_cents: commissionAmountCents
    }))
    if (ledgerRes.error) {
      if (ledgerRes.error.code === '23505') return { ok: true, recorded: false, reason: 'duplicate' }
      console.error('recordConversion ledger insert:', ledgerRes.error.message)
      return { ok: false, recorded: false, reason: 'ledger-insert', error: ledgerRes.error.message }
    }

    const rpcRes = await withOneRetry(() => supabase.rpc('increment_referral_code_usage', { p_code_id: codeRow.id }))
    if (rpcRes.error) {
      console.error('recordConversion usage increment:', rpcRes.error.message)
      // The commission itself IS recorded — only the usage counter is short by one.
      return { ok: false, recorded: true, reason: 'usage-increment', error: rpcRes.error.message }
    }
    // AUDIT FIX (bug): see the file-level comment above — this is the
    // mitigation for the usage-limit gap. Not gated on `env` being passed
    // for a live fulfilment path specifically; every caller that DOES pass
    // env (verifyPayment, the webhook, the sweeps) gets this for free, and
    // the admin reconcile endpoint's deliberate omission of env (see
    // recordConversion's comment) means it stays quiet on a retry, same as
    // notifyConversionFailure just above.
    if (env) await warnIfOverLimit(supabase, env, codeRow.id)
    return { ok: true, recorded: true }
  } catch (err) {
    console.error('recordConversion unexpected:', err.message)
    return { ok: false, recorded: false, reason: 'exception', error: err.message }
  }
}

// AUDIT FIX (bug): throttled the same way webhooks.controller.js throttles
// its signature-mismatch alert — a popular over-limit code redeeming
// repeatedly in a burst must not email-bomb the owner once per sale, so
// this fires at most once per code per day. Never throws.
async function warnIfOverLimit(supabase, env, codeId) {
  try {
    const { data: code, error } = await supabase.from('referral_codes')
      .select('code, usage_limit, uses_so_far').eq('id', codeId).maybeSingle()
    if (error || !code || code.usage_limit == null || code.uses_so_far <= code.usage_limit) return

    const kv = env.RATE_LIMIT_KV
    const key = `referral-over-limit-alert:${codeId}`
    if (kv) {
      if (await kv.get(key)) return
      await kv.put(key, '1', { expirationTtl: 24 * 60 * 60 })
    }

    const emailService = require('./email.service')
    await emailService.sendOwnerAlert(env,
      `Referral code ${code.code} redeemed past its usage limit`,
      `code: ${code.code}\nusage_limit: ${code.usage_limit}\nuses_so_far: ${code.uses_so_far}\n\n` +
      `The limit is only checked when a checkout starts, not when it completes, so under concurrent ` +
      `redemptions this code can legitimately be used more times than its limit before any of them ` +
      `finish paying. Each use here is a real, already-charged sale — nothing to undo. Deactivate the ` +
      `code (Admin -> Partners -> that partner -> Referral Codes) if it shouldn't keep accepting new ` +
      `checkouts.\n\n(Further redemptions of this same code are throttled to one alert per day.)`
    )
  } catch (_) {}
}

// Owner alert for a conversion that could not be (fully) recorded. Lazy
// require: email.service pulls in the Resend/fetch plumbing, which pure
// pricing callers/tests of this module shouldn't need to load.
async function notifyConversionFailure(env, payment, result, source) {
  try {
    const emailService = require('./email.service')
    await emailService.sendOwnerAlert(env,
      'Partner commission NOT fully recorded',
      `source: ${source}\npayment id: ${payment?.id}\nreference: ${payment?.paystack_ref}\n` +
      `referral_code_id: ${payment?.referral_code_id}\namount_cents: ${payment?.amount_cents}\n` +
      `step: ${result?.reason}\nerror: ${result?.error}\ncommission recorded: ${result?.recorded ? 'yes' : 'NO'}\n\n` +
      `The customer's fix is unaffected. To retry the ledger write (safe to repeat), call:\n\n` +
      `  POST /api/payments/${payment?.paystack_ref}/reconcile  (admin-only)`
    )
  } catch (_) {}
}

module.exports = { resolvePrice, recordConversion, notifyConversionFailure, isCodeUsable }
