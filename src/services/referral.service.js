// Referral/discount-code pricing. This is the piece that makes a referral
// code actually change what gets charged, not just what gets displayed:
// pricing.controller.js (the public quote) and payments.controller.js (the
// actual Paystack charge) both call resolvePrice() with the same inputs, so
// a shown price and a charged price can never independently drift — same
// principle config/constants.js's priceForTier()/isPromoActive() already
// apply to the site-wide promo.
//
// Usage-limit gap — FIXED (Section 3/4 pass, feature gap): isCodeUsable()
// below is only a plain read of uses_so_far vs usage_limit, which is fine
// for a QUOTE (getPricing) but was, until this pass, also the only thing
// initializePayment relied on before charging — and uses_so_far is only
// incremented on a COMPLETED conversion, so the real enforcement window used
// to be the FULL checkout duration for every concurrent shopper, not a
// narrow simultaneous DB race: a single-use code shared in a burst could be
// legitimately redeemed by many more people than usage_limit intended,
// each a genuine, correctly-tracked commission with nothing to undo.
// warnIfOverLimit (below) only ever told the owner AFTER the fact.
//
// reserveCodeUsage/releaseCodeReservation (below) close this: payments.
// controller.js's initializePayment now takes an atomic reservation for a
// code BEFORE ever calling Paystack (so the amount actually charged always
// matches whatever the reservation decided), and releases it on every path
// that ends a checkout without converting (cancelPayment, the stale-PENDING
// abandon in initializePayment itself, reconcile.service.js's
// sweepStalePendingPayments, and initializePayment's own Paystack-call/
// insert failure branches). recordConversion consumes a held reservation
// (folds it into uses_so_far) in the same statement that bumps the counter —
// see increment_referral_code_usage (migration 0042). warnIfOverLimit stays
// as defense-in-depth for anything this doesn't cover (a payment that
// predates this migration, or a reservation that outlived its TTL before
// being consumed).
const c = require('../config/constants')

async function lookupCode(supabase, rawCode) {
  if (!rawCode) return null
  const code = String(rawCode).trim().toUpperCase()
  if (!code) return null
  const { data, error } = await supabase
    .from('referral_codes').select('*, partners(status, email)').eq('code', code).maybeSingle()
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
// Shared core: given a tier and an ALREADY-RESOLVED codeRow (or null/
// undefined — no code, not found, whatever), compute that tier's price.
// Factored out so resolvePrice (one tier, one lookup — initializePayment's
// shape) and resolvePricesForTiers (all three tiers, one shared lookup —
// getPricing's shape) reduce to the exact same tier-price math and can never
// independently drift on what "the price for this code+tier" means.
function priceForResolvedCode(fixTier, env, codeRow, opts = {}) {
  const standard = c.priceForTier(fixTier, env)
  // AUDIT FIX: this used to hardcode c.CURRENCY ('USD') in all three returns
  // below, while the actual charge (paystack.service.js, payments.controller.js's
  // insert) uses `env.PAYSTACK_CURRENCY || c.CURRENCY`. Same class of bug as
  // pricing.controller.js's getPricing — if PAYSTACK_CURRENCY is ever set,
  // the quoted currency here would silently disagree with what gets charged.
  const currency = env.PAYSTACK_CURRENCY || c.CURRENCY
  const tierPrice = codeRow?.tier_prices?.[fixTier]

  if (!isCodeUsable(codeRow) || tierPrice == null)
    return { amount: standard, currency, referralApplied: false, referralCode: null }

  // Self-referral guard: a partner buying with their own code would collect
  // the buyer discount AND the commission on the same sale. Silently fall
  // back to normal pricing, exactly like any other code that doesn't apply.
  // (Matches on the partner's registered email; a different email can't be
  // detected here.)
  if (isSelfReferral(codeRow, opts.buyerEmail))
    return { amount: standard, currency, referralApplied: false, referralCode: null, selfReferral: true }

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
  // AUDIT FIX (Payments & Pricing pass 1, bug — B8): referralApplied was true
  // even when Math.min picked the PROMO price over the code's own tierPrice —
  // so the checkout/pricing UI said "your code is applied — see your
  // discount" while charging the same public price everyone else was paying.
  // referralApplied itself is UNCHANGED (partner attribution/commission are
  // deliberately keyed on it, see the comment above — the code IS in effect,
  // it just isn't the reason for today's price). discountApplied is the new,
  // narrower signal: true only when the code actually lowered what this buyer
  // pays below the standard price, which is what "you got a discount" copy
  // should be gated on.
  const amount = Math.min(tierPrice, standard)
  return { amount, currency, referralApplied: true, discountApplied: amount < standard, referralCode: codeRow }
}

// Round 5: compared on the exact address only, so `me+x@gmail.com` or `m.e@gmail.com` sailed
// past the guard as a "different buyer". Canonical form: lower-case, `+tag` dropped, and (Gmail
// only, where it is guaranteed) dots in the local part ignored. Best-effort by nature — a
// partner determined to buy through their own link with an unrelated address can't be
// stopped here — but the cheap, common aliasing is closed.
function canonicalEmail(email) {
  const e = String(email || '').trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1) return e
  let local = e.slice(0, at), domain = e.slice(at + 1)
  local = local.split('+')[0]
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

function isSelfReferral(codeRow, buyerEmail) {
  const partnerEmail = codeRow?.partners?.email
  if (!partnerEmail || !buyerEmail) return false
  return canonicalEmail(partnerEmail) === canonicalEmail(buyerEmail)
}

// opts.buyerEmail (optional) enables the self-referral guard above.
async function resolvePrice(supabase, fixTier, env, rawReferralCode, opts = {}) {
  if (!rawReferralCode) return priceForResolvedCode(fixTier, env, null)
  const codeRow = await lookupCode(supabase, rawReferralCode)
  return priceForResolvedCode(fixTier, env, codeRow, opts)
}

// AUDIT FIX (Section 3/4 pass, perf): pricing.controller.js's getPricing
// used to call resolvePrice() once per tier (FIX/BADGE/FIX_PLAIN) whenever a
// ?ref= code was present, each call independently doing its own lookupCode()
// — three DB round trips for the exact same referral_codes row, on every
// load of a public, unauthenticated, uncached endpoint hit by both the
// marketing pricing page and the post-scan checkout screen. One lookup here,
// reused for all three tiers via the same priceForResolvedCode() core
// resolvePrice itself uses above, so a quoted multi-tier price can never
// compute a tier differently than a single-tier resolvePrice call would.
// opts.buyerEmail (optional): see resolvePrice — enables the same self-referral
// guard for the /api/pricing quote (AUDIT FIX, Payments & Pricing pass 1 —
// B11: this used to never receive it at all, so a logged-in partner browsing
// their own code saw a discounted QUOTE that initializePayment's resolvePrice
// call — which DOES get buyerEmail — would then refuse to honour at checkout).
async function resolvePricesForTiers(supabase, tiers, env, rawReferralCode, opts = {}) {
  if (!rawReferralCode)
    return Object.fromEntries(tiers.map(t => [t, priceForResolvedCode(t, env, null)]))
  let codeRow = await lookupCode(supabase, rawReferralCode)
  // AUDIT FIX (Payments & Pricing round 4, bug — B1): isCodeUsable only compares uses_so_far with
  // usage_limit, but initializePayment claims a slot with reserve_referral_code_slot, which
  // counts uses_so_far PLUS live reservations. A limited code whose last slots were held by
  // checkouts in progress therefore QUOTED its discount here and then silently charged the full
  // price at checkout. The quote now applies the same rule the claim does.
  if (codeRow && isCodeUsable(codeRow) && codeRow.usage_limit != null) {
    const live = await countLiveReservations(supabase, codeRow.id)
    if ((codeRow.uses_so_far || 0) + live >= codeRow.usage_limit) codeRow = null
  }
  return Object.fromEntries(tiers.map(t => [t, priceForResolvedCode(t, env, codeRow, opts)]))
}

// Must match reserve_referral_code_slot's default p_ttl_seconds (migration 0044).
const RESERVATION_TTL_SECONDS = 3600

// Reservations still counting toward a code's limit. A QUOTE helper only — never reserves.
// Fails OPEN (0): a failed count must not hide a discount that checkout may well still honour;
// the claim at checkout is the real enforcement.
async function countLiveReservations(supabase, codeId) {
  try {
    const since = new Date(Date.now() - RESERVATION_TTL_SECONDS * 1000).toISOString()
    const { count, error } = await supabase.from('referral_code_reservations')
      .select('id', { count: 'exact', head: true })
      .eq('referral_code_id', codeId).gt('created_at', since)
    if (error) { console.error('countLiveReservations:', error.message); return 0 }
    return count || 0
  } catch (err) {
    console.error('countLiveReservations unexpected:', err.message)
    return 0
  }
}

/**
 * reserveCodeUsage(supabase, codeId) -> reservationId | null
 *
 * Atomically claims a usage-limit slot for this code (see migration 0042's
 * reserve_referral_code_slot — the `for update` lock there is what actually
 * closes the race, not this JS wrapper). Call ONLY from an actual checkout
 * attempt (payments.controller.js's initializePayment), never from a plain
 * price quote (pricing.controller.js's getPricing) — reserving on every page
 * view of a ?ref= link would burn through a limited code's capacity just
 * from visitors browsing, not buying.
 *
 * Returns the new reservation's id on success. Returns null both when the
 * code has no room left (the caller should fall back to standard/promo
 * pricing — exactly how an already-exhausted code has always silently been
 * treated) AND on an unexpected DB error (logged, never thrown) — a failure
 * to reserve must never be treated as "reservation succeeded," so both cases
 * collapse to the same safe "don't apply this code" outcome for the caller.
 */
async function reserveCodeUsage(supabase, codeId) {
  try {
    const { data, error } = await supabase.rpc('reserve_referral_code_slot', { p_code_id: codeId })
    if (error) { console.error('reserveCodeUsage:', error.message); return null }
    return data || null
  } catch (err) {
    console.error('reserveCodeUsage unexpected:', err.message)
    return null
  }
}

/**
 * releaseCodeReservation(supabase, reservationId) -> void
 *
 * Best-effort, never throws — call from every path that ends a checkout
 * without it converting (cancelPayment, initializePayment's own stale-PENDING
 * abandon step and its Paystack-call/insert-failure branches, reconcile.
 * service.js's sweepStalePendingPayments). A no-op for a reservation that's
 * already gone (already released, already consumed by recordConversion,
 * already pruned) — callers never need to check existence first. Silently
 * skips a null/undefined id so every call site can pass
 * `payment.referral_reservation_id` unconditionally.
 */
async function releaseCodeReservation(supabase, reservationId) {
  if (!reservationId) return
  try {
    const { error } = await supabase.rpc('release_referral_code_slot', { p_reservation_id: reservationId })
    if (error) console.error('releaseCodeReservation:', error.message)
  } catch (err) {
    console.error('releaseCodeReservation unexpected:', err.message)
  }
}

// Table hygiene, not correctness — reserve_referral_code_slot's own count
// already ignores anything older than its TTL, so a reservation row past
// that age can never affect a real limit decision even if it's never
// explicitly released. This just keeps referral_code_reservations from
// growing forever for the rare row whose release path was skipped (a
// payment stuck PENDING past every sweep's reach, a crashed request between
// reserving and inserting). Piggybacked on the existing hourly
// sweepStalePendingPayments run (reconcile.service.js) rather than a new
// cron job — same cadence, same file already touches this exact area.
// MAX_AGE_MS is deliberately far past reserve_referral_code_slot's own TTL
// (60 min) — this is cleanup of things already long since ignored for
// limit-counting purposes, not a second enforcement window.
const RESERVATION_MAX_AGE_MS = 24 * 60 * 60 * 1000

async function pruneReferralCodeReservations(supabase, { now = Date.now() } = {}) {
  try {
    const cutoff = new Date(now - RESERVATION_MAX_AGE_MS).toISOString()
    const { error } = await supabase.from('referral_code_reservations').delete().lt('created_at', cutoff)
    if (error) console.error('pruneReferralCodeReservations:', error.message)
  } catch (err) {
    console.error('pruneReferralCodeReservations unexpected:', err.message)
  }
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
      .from('referral_codes').select('id, partner_id, code').eq('id', payment.referral_code_id).maybeSingle())
    if (codeRes.error) {
      console.error('recordConversion code lookup:', codeRes.error.message)
      return { ok: false, recorded: false, reason: 'code-lookup', error: codeRes.error.message }
    }
    const codeRow = codeRes.data
    if (!codeRow) return { ok: true, recorded: false, reason: 'code-not-found' }

    const partnerRes = await withOneRetry(() => supabase
      .from('partners').select('name, email, commission_rate, dashboard_token, notify_conversions').eq('id', codeRow.partner_id).maybeSingle())
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

    // usage_counted:false marks "row written, counter not bumped yet". The RPC
    // below flips it and bumps uses_so_far in one transaction, exactly once —
    // so a failed bump can be repaired by re-running this function (the
    // /reconcile path) instead of being stuck behind the duplicate check.
    const ledgerRes = await withOneRetry(() => supabase.from('commission_ledger').insert({
      payment_id:              payment.id,
      partner_id:              codeRow.partner_id,
      referral_code_id:        codeRow.id,
      gross_amount_cents:      payment.amount_cents,
      commission_rate:         commissionRate,
      commission_amount_cents: commissionAmountCents,
      currency:                payment.currency || (env && env.PAYSTACK_CURRENCY) || c.CURRENCY,
      usage_counted:           false
    }).select('id').single())

    let ledgerId = ledgerRes.data?.id || null
    let repairOnly = false
    if (ledgerRes.error) {
      if (ledgerRes.error.code !== '23505') {
        console.error('recordConversion ledger insert:', ledgerRes.error.message)
        return { ok: false, recorded: false, reason: 'ledger-insert', error: ledgerRes.error.message }
      }
      // Duplicate: the commission already exists. Only act if a previous run
      // wrote the row but never managed to count the usage.
      const existing = await withOneRetry(() => supabase.from('commission_ledger')
        .select('id, usage_counted').eq('payment_id', payment.id).is('reverses_ledger_id', null).maybeSingle())
      if (existing.error) {
        console.error('recordConversion duplicate lookup:', existing.error.message)
        return { ok: false, recorded: false, reason: 'duplicate-lookup', error: existing.error.message }
      }
      if (!existing.data || existing.data.usage_counted !== false) return { ok: true, recorded: false, reason: 'duplicate' }
      ledgerId = existing.data.id
      repairOnly = true
    }

    const rpcArgs = { p_code_id: codeRow.id, p_ledger_id: ledgerId }
    if (payment.referral_reservation_id) rpcArgs.p_reservation_id = payment.referral_reservation_id
    const rpcRes = await withOneRetry(() => supabase.rpc('increment_referral_code_usage', rpcArgs))
    if (rpcRes.error) {
      console.error('recordConversion usage increment:', rpcRes.error.message)
      // The commission itself IS recorded — only the usage counter is short by one.
      // Re-running (POST /api/payments/:ref/reconcile) now repairs exactly this.
      return { ok: false, recorded: !repairOnly, reason: 'usage-increment', error: rpcRes.error.message }
    }
    if (repairOnly) return { ok: true, recorded: false, reason: 'duplicate', usageRepaired: true }

    // Refund-before-commission race: a refund can land between the payment flip to
    // SUCCESS and this write. reversePayment found no original to reverse, so the
    // commission we just wrote would sit positive on a REFUNDED sale forever. Re-read
    // the payment's CURRENT status (the `payment` object here is a stale snapshot) and,
    // if it was refunded meanwhile, reverse straight away. Idempotent (unique reversal
    // index), so a reversePayment arriving at the same moment is harmless.
    try {
      const cur = await supabase.from('payments').select('status').eq('id', payment.id).maybeSingle()
      if (cur?.data?.status === 'REFUNDED') {
        const { reverseCommission } = require('./fulfillment.service')
        const rev = await reverseCommission(supabase, payment.id, 'REFUND')
        return { ok: true, recorded: true, reversedImmediately: !!rev.reversed }
      }
    } catch (err) {
      console.error('recordConversion refunded-check:', err.message)   // never fail an already-recorded commission
    }
    // AUDIT FIX (bug): see the file-level comment above — this is the
    // mitigation for the usage-limit gap. Not gated on `env` being passed
    // for a live fulfilment path specifically; every caller that DOES pass
    // env (verifyPayment, the webhook, the sweeps) gets this for free, and
    // the admin reconcile endpoint's deliberate omission of env (see
    // recordConversion's comment) means it stays quiet on a retry, same as
    // notifyConversionFailure just above.
    if (env) await warnIfOverLimit(supabase, env, codeRow.id)
    // AUDIT FIX (Section 3/4 pass, feature gap): a partner gets emailed for
    // every OTHER account-adjacent event this file/partners.controller.js
    // handles — a payout sent, payout details changed, a new code created,
    // their payout link reset — but never for the one event they'd most want
    // to know about: someone actually used their code and they just earned a
    // commission. Same `env`-gating as warnIfOverLimit just above: only the
    // live fulfilment paths (verifyPayment, the webhook, the sweeps) pass
    // `env` and therefore notify; the admin reconcile endpoint's deliberate
    // omission of it means retrying a recovery stays quiet, same reasoning
    // as notifyConversionFailure. Best-effort — a failed/throttled
    // notification must never affect the (already-succeeded) commission
    // record itself, so this never changes the returned `ok`/`recorded`.
    if (env) await notifyPartnerConversion(env, supabase, partner, codeRow, commissionAmountCents, payment.currency)
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

// AUDIT FIX (Section 3/4 pass, feature gap): see the call site's comment in
// recordConversionInner. Deliberately swallows everything — a partner with
// no email on file, a throttled/failed send, or a missing dashboard_
// token (no dashboard link to send them yet) must never turn an already-
// successful commission record into a failure response.
async function notifyPartnerConversion(env, supabase, partner, codeRow, commissionAmountCents, currency) {
  if (!partner?.email || !partner?.dashboard_token) return
  // Round 5: a partner can turn the per-sale email off (partners.notify_conversions).
  // Reversal / payout / account emails are never affected by it.
  if (partner.notify_conversions === false) return
  try {
    const emailService = require('./email.service')
    const dashboardUrl = `${env.FRONTEND_URL}/partner/dashboard?token=${partner.dashboard_token}`
    await emailService.sendPartnerConversionEarned(env, supabase, partner.email, partner.name,
      codeRow.code, commissionAmountCents, currency || c.CURRENCY, dashboardUrl)
  } catch (_) {}
}

// A refund/chargeback clawed commission back — tell the partner (their dashboard
// shows it, but they shouldn't have to notice). Best-effort, never throws; only
// the live reversal paths pass `env`.
async function notifyPartnerReversal(env, supabase, partnerId, commissionCents, currency) {
  try {
    const { data: partner } = await supabase.from('partners')
      .select('name, email, dashboard_token, status').eq('id', partnerId).maybeSingle()
    if (!partner?.email || !partner?.dashboard_token) return
    const emailService = require('./email.service')
    const dashboardUrl = `${env.FRONTEND_URL}/partner/dashboard?token=${partner.dashboard_token}`
    await emailService.sendPartnerCommissionReversed(env, supabase, partner.email, partner.name,
      commissionCents, currency || env.PAYSTACK_CURRENCY || c.CURRENCY, dashboardUrl)
  } catch (_) {}
}

module.exports = {
  canonicalEmail,
  notifyPartnerReversal,
  resolvePrice, resolvePricesForTiers, recordConversion, notifyConversionFailure, isCodeUsable,
  priceForResolvedCode, reserveCodeUsage, releaseCodeReservation, pruneReferralCodeReservations,
  countLiveReservations,
}
