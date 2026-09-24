// Single source of truth for all tunable values — identical to the v8 spec.
// Only change from the original: UPLOAD_DIR is removed. R2 doesn't need a
// filesystem path; src/config/storage.js builds object keys as plain strings.
//
// CommonJS by design — only src/index.js uses ESM (see Section 9 of the
// Cloudflare migration patch). esbuild bundles require()/module.exports
// into the ESM entry point without issue.

module.exports = {
  // Standard (post-promo) prices — these are what priceForTier() falls back
  // to once PROMO_ENDS_AT passes, and what the frontend shows crossed-out as
  // the anchor during the promo.
  PRICE_FIX:       4900,    // $49.00 USD cents — rewrite + Passthrough Verified credential
  PRICE_BADGE:     3900,    // $39.00 USD cents — credential only, no rewrite (requires score >= ATS_BADGE_THRESHOLD)
  PRICE_FIX_PLAIN: 3900,    // $39.00 USD cents — rewrite only, no credential/verification link

  // Launch promo prices. Mapping: BADGE gets the deepest cut (cheapest tier
  // to deliver — no Claude rewrite call, no PDF render), FIX_PLAIN a middle
  // cut, FIX (the most expensive to deliver) the smallest cut. Flagging this
  // mapping explicitly in case a different assignment was intended — easy to
  // swap, just move the numbers.
  PROMO_PRICE_FIX:       2900,   // $29.00
  PROMO_PRICE_BADGE:     900,    // $9.00
  PROMO_PRICE_FIX_PLAIN: 1900,   // $19.00

  // Whether the promo price applies right now. This is what makes the
  // frontend countdown honest: it counts down to env.PROMO_ENDS_AT, and this
  // same check is what the backend uses to actually decide what to charge —
  // there's no separate "fake" timer, the displayed deadline IS the
  // enforced one. Extending the promo means redeploying with a later
  // PROMO_ENDS_AT (see wrangler.toml), which is a real, visible decision
  // each time rather than a timer that silently never expires.
  isPromoActive(env) {
    if (!env || env.PROMO_ACTIVE !== 'true' || !env.PROMO_ENDS_AT) return false
    const endsAt = Date.parse(env.PROMO_ENDS_AT)
    if (Number.isNaN(endsAt)) return false   // fails safe to standard pricing on bad config
    return Date.now() < endsAt
  },

  // Single source of truth for tier -> price, used by scan.controller.js's
  // initiateFix (price preview), payments.controller.js's initializePayment
  // (actual charge), and pricing.controller.js (public pricing display) —
  // having independently-maintained copies of this mapping is exactly how
  // they'd eventually drift and quote one price but charge another.
  priceForTier(fixTier, env) {
    const promo = this.isPromoActive(env)
    if (fixTier === 'BADGE')     return promo ? this.PROMO_PRICE_BADGE     : this.PRICE_BADGE
    if (fixTier === 'FIX_PLAIN') return promo ? this.PROMO_PRICE_FIX_PLAIN : this.PRICE_FIX_PLAIN
    return promo ? this.PROMO_PRICE_FIX : this.PRICE_FIX
  },

  // The true pre-promo anchor price — never promo-adjusted, unlike
  // priceForTier(). This is what pricing.controller.js now returns as
  // originalAmount, so the frontend's crossed-out "was $X" price is always
  // the real standard price, not (as it silently was before) just another
  // copy of whatever priceForTier() currently returns — which made the
  // strikethrough identical to the live price, and therefore invisible,
  // for every visitor who didn't arrive with a referral code.
  standardPriceForTier(fixTier) {
    if (fixTier === 'BADGE')     return this.PRICE_BADGE
    if (fixTier === 'FIX_PLAIN') return this.PRICE_FIX_PLAIN
    return this.PRICE_FIX
  },
  // AUDIT FIX (feature gap): single-source-of-truth display name per tier,
  // for the payment receipt email (email.service.js's sendPaymentReceipt) —
  // same "don't let this drift into an independently-maintained copy"
  // reasoning as priceForTier() above. Matches the labels used on the
  // pricing page (frontend/src/pages/Pricing.jsx): "Full fix", "Credential
  // only", "Fix only".
  tierLabel(fixTier) {
    if (fixTier === 'BADGE')     return 'Credential only'
    if (fixTier === 'FIX_PLAIN') return 'Fix only'
    return 'Full fix'
  },
  CURRENCY:    'USD',
  ATS_PASS_THRESHOLD:  75,
  ATS_BADGE_THRESHOLD: 80,
  // < 75: FAIL → $49 or $39 (plain) | 75-79: PASS no badge → $49 or $39 (plain) | 80+: PASS → $39 badge, $39 plain, or $49 full
  ATS_RULE_WEIGHT: 0.70,
  ATS_AI_WEIGHT:   0.30,
  // Rewrite retry loop (generateFix): if the first rewrite scores below
  // ATS_BADGE_THRESHOLD, retry with specific feedback about what's weak,
  // up to this many total attempts. The best-scoring attempt is always
  // what gets delivered, even if none reach the threshold — see generateFix.
  MAX_FIX_ATTEMPTS: 3,
  // User-facing "Try Again" retries after the initial 3-attempt process
  // still falls short of ATS_BADGE_THRESHOLD. Each press re-runs the same
  // 3-attempt process, building on the latest rewrite rather than starting
  // over. If retries are exhausted and still below threshold, the user gets
  // 1 free fix credit (see generateFix / retryFix in scan.controller.js).
  MAX_FIX_RETRIES: 2,
  MAX_JD_CHARS:     5000,
  MAX_RESUME_CHARS: 8000,
  MIN_BRAIN_DUMP_CHARS: 100,   // Phase 1 — brain-dump entry path minimum length
  MAX_UPLOAD_MB:    5,
  FREE_SCANS_PER_DAY:  3,
  ANON_SCAN_TTL_HOURS: 24,
  // Length of the ORIGINAL 6-character verification codes. Pages issued before the
  // longer format still use it, so lookups keep accepting it (see lib/verification.js).
  SHORT_CODE_LENGTH: 6,
  // Length of every NEWLY issued code: 32^10 (~1.1e15) instead of 32^6 (~1.1e9). The
  // code is the only capability guarding a page's optional .docx/PDF download (a full
  // resume with contact details), so 30 bits was too small to leave unguarded.
  VERIFY_CODE_LENGTH: 10,
  SHORT_CODE_CHARS:  'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  EMAIL_TOKEN_EXPIRY_HOURS: 1,
  RESET_TOKEN_EXPIRY_HOURS: 1,
  ROLE_CATEGORIES: [
    'software_engineering','product_management','design','data_science',
    'marketing','sales','operations','finance','healthcare','legal','education','other'
  ],
  SENIORITY_LEVELS: ['junior','mid','senior','lead','executive'],
}
