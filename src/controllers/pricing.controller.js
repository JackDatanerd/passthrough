const c = require('../config/constants')

// GET /api/pricing — public, unauthenticated. Marketing/landing pages and
// the post-scan checkout screen both call this instead of hardcoding prices,
// so the crossed-out "original" price, the current price, and the countdown
// target can never drift out of sync with what initializePayment will
// actually charge. If PROMO_ACTIVE/PROMO_ENDS_AT aren't set, this quietly
// returns standard pricing with promoActive: false — safe default.
async function getPricing(ctx) {
  const promoActive = c.isPromoActive(ctx.env)
  const tiers = ['FIX', 'BADGE', 'FIX_PLAIN'].map(tier => ({
    tier,
    amount:         c.priceForTier(tier, ctx.env),
    originalAmount: c.priceForTier(tier, null),
  }))

  return ctx.json({ success: true, data: {
    currency: c.CURRENCY,
    promoActive,
    // null when there's no active promo — frontend should not render a
    // countdown in that case rather than showing a stale/zero timer.
    promoEndsAt: promoActive ? ctx.env.PROMO_ENDS_AT : null,
    tiers
  } })
}

module.exports = { getPricing }
