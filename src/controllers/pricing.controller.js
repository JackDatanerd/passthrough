const c = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const referralService = require('../services/referral.service')

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
async function getPricing(ctx) {
  const promoActive = c.isPromoActive(ctx.env)
  const referralCode = ctx.req.query('ref')
  const supabase = referralCode ? getSupabase(ctx.env) : null

  const tiers = await Promise.all(['FIX', 'BADGE', 'FIX_PLAIN'].map(async tier => {
    const originalAmount = c.priceForTier(tier, ctx.env)
    if (!referralCode) return { tier, amount: originalAmount, originalAmount, referralApplied: false }

    const priced = await referralService.resolvePrice(supabase, tier, ctx.env, referralCode)
    return { tier, amount: priced.amount, originalAmount, referralApplied: priced.referralApplied }
  }))

  return ctx.json({ success: true, data: {
    currency: c.CURRENCY,
    promoActive,
    // null when there's no active promo — frontend should not render a
    // countdown in that case rather than showing a stale/zero timer.
    promoEndsAt: promoActive ? ctx.env.PROMO_ENDS_AT : null,
    referralApplied: tiers.some(t => t.referralApplied),
    tiers
  } })
}

module.exports = { getPricing }
