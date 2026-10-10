const c = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const referralService = require('../services/referral.service')
const refundService = require('../services/refund.service')
const { UUID_RE } = require('../middleware/validateUuidParam')

// GET /api/pricing — public, unauthenticated. Marketing/landing pages and
// the post-scan checkout screen both call this instead of hardcoding prices,
// so the crossed-out "original" price, the current price, and the countdown
// target can never drift out of sync with what initializePayment will
// actually charge. If PROMO_ACTIVE/PROMO_ENDS_AT aren't set, this quietly
// returns standard pricing with promoActive: false — safe default.
//
// ?ref=CODE (optional) — when present, each tier's price is resolved through
// referral.service.js instead of c.priceForTier() directly. originalAmount
// stays the pre-referral (promo/standard) price either way, so the frontend
// can always show a consistent strikethrough regardless of which discount
// (site-wide promo, referral code, or both layered) is actually in effect.
const TIERS = ['FIX', 'BADGE', 'FIX_PLAIN']

async function getPricing(ctx) {
  const promoActive = c.isPromoActive(ctx.env)
  // Capped like initializePayment's own referralCode field (100 chars): this
  // endpoint is public and unauthenticated, and the value goes straight into a
  // referral_codes lookup.
  const referralCode = ctx.req.query('ref')?.slice(0, 100)
  const supabase = referralCode ? getSupabase(ctx.env) : null
  // AUDIT FIX (Payments & Pricing pass 1, bug — B11): resolvePrice (used by
  // initiateFix and initializePayment's actual charge) has always passed
  // buyerEmail to guard against a partner discounting their own purchase;
  // this quote endpoint never did, so a logged-in partner browsing their own
  // referral link saw a discounted price that checkout would then refuse to
  // honour. optionalAuth runs app-wide, so the email (if any) is just sitting
  // on the context already.
  const buyerEmail = ctx.get('user')?.email

  // AUDIT FIX (Section 3/4 pass, perf): used to call referralService.
  // resolvePrice() once per tier below, each doing its own independent
  // referral_codes lookup for the same code — three DB round trips per
  // request instead of one. resolvePricesForTiers does the single lookup
  // and returns all three tiers' prices from it.
  // PAYMENTS & PRICING ROUND 9: optional ?scanId= (the checkout screen sends it) scopes "my own held slot"
  // to the checkout that would actually be resumed — see countOwnLiveReservations.
  const scanIdParam = ctx.req.query('scanId')
  const buyerScanId = scanIdParam && UUID_RE.test(scanIdParam) ? scanIdParam : undefined
  const priced = referralCode
    ? await referralService.resolvePricesForTiers(supabase, TIERS, ctx.env, referralCode, { buyerEmail, buyerUserId: ctx.get('user')?.id, buyerScanId })
    : null

  const tiers = TIERS.map(tier => {
    // BUGFIX: originalAmount used to be c.priceForTier(tier, ctx.env), which
    // is ALREADY promo-adjusted — so without a referral code, amount and
    // originalAmount were always identical and the frontend's `amount !==
    // originalAmount` strikethrough check could never be true. That made the
    // promo's anchor price invisible to every visitor except the ones who
    // arrived with a ?ref= code (see referral.service.js's resolvePrice).
    // standardPriceForTier() is never promo-adjusted, so this is now a real
    // "was $X" anchor regardless of whether a referral code is present.
    const originalAmount = c.standardPriceForTier(tier)
    const currentAmount  = c.priceForTier(tier, ctx.env)
    if (!priced) return { tier, amount: currentAmount, originalAmount, referralApplied: false, discountApplied: false, selfReferral: false }

    // selfReferral: referral.service's self-referral guard fired (a partner's own
    // code on their own account). The UI needs it to say so instead of the
    // misleading "that code doesn't look right" it showed for any code that
    // did not apply.
    return { tier, amount: priced[tier].amount, originalAmount, referralApplied: priced[tier].referralApplied, discountApplied: !!priced[tier].discountApplied, selfReferral: !!priced[tier].selfReferral }
  })

  return ctx.json({ success: true, data: {
    // AUDIT FIX: was hardcoded c.CURRENCY ('USD'), while every place that
    // actually charges money (paystack.service.js, payments.controller.js's
    // insert, scan.controller.js's price preview) already uses
    // `env.PAYSTACK_CURRENCY || c.CURRENCY`. If PAYSTACK_CURRENCY is ever set
    // to anything but USD, this public quote would show the wrong currency
    // for what Paystack actually charges — the exact "future currency
    // misconfig" scenario the webhook/verify amount check already guards
    // against, just missed here. See the same fix in referral.service.js's
    // resolvePrice, which this endpoint also calls into below.
    currency: ctx.env.PAYSTACK_CURRENCY || c.CURRENCY,
    // Server clock, so the client countdown can correct for a user's
    // wrong/skewed device clock — the deadline it counts toward is enforced
    // against THIS clock at checkout, not theirs.
    serverTime: Date.now(),
    promoActive,
    // null when there's no active promo — frontend should not render a
    // countdown in that case rather than showing a stale/zero timer.
    // Round 8: normalised to an unambiguous UTC instant. The raw config string used to be passed through, and
    // isPromoActive() reads a zone-less value ("2026-12-01T23:59:59") as UTC on the Worker while every browser
    // reads the SAME string as the visitor's local time — a countdown hours off the deadline checkout enforces.
    // isPromoActive() has already proved it parses when promoActive is true.
    promoEndsAt: promoActive ? new Date(Date.parse(ctx.env.PROMO_ENDS_AT)).toISOString() : null,
    referralApplied: tiers.some(t => t.referralApplied),
    // True when the code genuinely lowers at least one tier below today's price
    // (as opposed to referralApplied, which is attribution). See B8/B2.
    discountApplied: tiers.some(t => t.discountApplied),
    selfReferral:    tiers.some(t => t.selfReferral),
    // FEATURE GAP CLOSED (Payments & Pricing pass 1 — G5): the Pricing page
    // hardcoded "80+" and "two free manual retries" in its copy, which could
    // silently drift from these two constants (the ones that actually gate
    // badge eligibility and retry count). The frontend now reads them here.
    badgeThreshold: c.ATS_BADGE_THRESHOLD,
    maxFixRetries:  c.MAX_FIX_RETRIES,
    // G2 (round 3): the free-tier copy on the Pricing page, read live like the two above.
    freeScansPerDay:   c.FREE_SCANS_PER_DAY,
    anonScansPerHour:  c.ANON_SCANS_PER_HOUR,
    // Round 9 (G3): what the Pricing page may promise about refunds is read from the same switches that
    // actually run them (AUTO_REFUND_DUPLICATES / AUTO_REFUND_UNDELIVERABLE), so the copy can never
    // promise an automatic refund the operator has turned off.
    autoRefundDuplicates:    refundService.autoRefundEnabled(ctx.env),
    autoRefundUndeliverable: refundService.autoRefundUndeliverableEnabled(ctx.env),
    tiers
  } })
}

module.exports = { getPricing }
