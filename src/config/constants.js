// Single source of truth for all tunable values — identical to the v8 spec.
// Only change from the original: UPLOAD_DIR is removed. R2 doesn't need a
// filesystem path; src/config/storage.js builds object keys as plain strings.
//
// CommonJS by design — only src/index.js uses ESM (see Section 9 of the
// Cloudflare migration patch). esbuild bundles require()/module.exports
// into the ESM entry point without issue.

module.exports = {
  // The highest supabase/migrations number this code expects the database to have applied. Every
  // migration ends by writing its number to system_state.schema_version (see 0059); the Worker
  // compares the two (lib/health.js). Bump it in the same commit as the migration —
  // tests/schemaVersion.test.js fails when the newest migration and this value disagree.
  EXPECTED_SCHEMA_VERSION: 72,

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
  // Employer leads: how many times the hourly sweep retries a never-acknowledged lead before it
  // gives up (and the unconfirmed-lead purge may remove it). See employer-leads.controller.js.
  LEAD_ACK_MAX_ATTEMPTS: 5,
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
  // ── Homepage evidence (migration 0070) ────────────────────────────────────────────────────────
  // The dashboard asks "did this lead to an interview?" this many days after a fix was delivered; the
  // follow-up email goes out later, if the question is still unanswered.
  OUTCOME_DASHBOARD_AFTER_DAYS: 14,
  OUTCOME_EMAIL_AFTER_DAYS: 30,
  // Past this age the email is not sent any more (the answer would be about something long gone).
  OUTCOME_EMAIL_MAX_AGE_DAYS: 120,
  // Follow-up emails per sweep run, and attempts per scan before we stop trying.
  OUTCOME_EMAIL_BATCH: 40,
  OUTCOME_EMAIL_MAX_ATTEMPTS: 3,
  // The interview rate is only published once this many people have answered: a rate over a handful
  // of replies is noise, and every public number here has to survive being asked "based on what?".
  OUTCOME_MIN_RESPONSES: 50,
  // A field appears in "hot categories" only with at least this many interviews reported in the window.
  HOT_CATEGORY_MIN_REPORTS: 10,
  HOT_CATEGORY_WINDOWS: [7, 30],
  // Stories shown on the homepage.
  HOMEPAGE_STORIES: 3,
  STORY_MAX_NAME: 40,
  STORY_MAX_QUOTE: 160,
  STORY_MAX_TEXT: 1200,
  MAX_FIX_RETRIES: 2,
  MAX_JD_CHARS:     5000,
  // Brain-dump input box (the frontend mirrors this value).
  MAX_RESUME_CHARS: 12000,
  // Text extracted from an UPLOADED resume, for scoring and structuring. Much
  // larger than the brain-dump cap: 8000 chars silently truncated any resume
  // beyond ~2.5 pages.
  MAX_RESUME_TEXT_CHARS: 24000,
  MIN_BRAIN_DUMP_CHARS: 100,   // Phase 1 — brain-dump entry path minimum length
  MAX_UPLOAD_MB:    5,
  FREE_SCANS_PER_DAY:  3,
  // Scans an ACCOUNT-LESS visitor gets per hour (rateLimiter.js's anonScan). Exposed through
  // /api/pricing so the pricing page's free-tier copy can never drift from the real limit.
  ANON_SCANS_PER_HOUR: 1,
  // Ceiling per IP when the visitor identifies a device (X-Device-Id): every device still gets
  // ANON_SCANS_PER_HOUR, but one network (a carrier's CGNAT, an office) is capped at this many.
  ANON_SCANS_PER_IP_PER_HOUR: 10,
  // Ceiling on scans per IP per 24h across ALL accounts (five accounts' worth) —
  // stops throwaway-account farming of the free tier. SCAN_IP_DAILY_CAP env var
  // overrides it; 0 disables the ceiling.
  FREE_SCANS_PER_IP_PER_DAY: 15,
  ANON_SCAN_TTL_HOURS: 24,
  // Length of the ORIGINAL 6-character verification codes. Pages issued before the
  // longer format still use it, so lookups keep accepting it (see lib/verification.js).
  SHORT_CODE_LENGTH: 6,
  // Length of every NEWLY issued code: 32^10 (~1.1e15) instead of 32^6 (~1.1e9). The
  // code is the only capability guarding a page's optional .docx/PDF download (a full
  // resume with contact details), so 30 bits was too small to leave unguarded.
  VERIFY_CODE_LENGTH: 10,
  SHORT_CODE_CHARS:  'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  // Short-lived emailed links that act on the account itself (pending email-change confirmation).
  EMAIL_TOKEN_EXPIRY_HOURS: 1,
  // AUDIT FIX (Auth round 4, G1): the signup verification link shared the 1-hour window above, so
  // anyone who registered and read their mail later found a dead link — and replacing it needs a
  // signed-in session. Verifying an address only ever sets email_verified (it grants no access and
  // changes nothing else), so it can live far longer than a reset or email-change link.
  EMAIL_VERIFY_EXPIRY_HOURS: 24,

  // Version of the Terms of Service / Privacy Policy a new account accepts at
  // sign-up (stored on users.terms_version). Bump when either document changes
  // materially so acceptance can be told apart per version.
  TERMS_VERSION: '2026-09',
  RESET_TOKEN_EXPIRY_HOURS: 1,
  // Auth section, feature-gap-closing pass: minimum gap between "new sign-in"
  // alert emails for the same account, regardless of how many times the IP
  // actually changes in that window (see auth.controller.js's
  // recordLoginMetadata). A phone reconnecting to a new cell tower gets a new
  // IP on nearly every handoff — without a floor like this, that alone would
  // fire an email per handoff, which trains the account owner to ignore the
  // one that eventually matters instead of helping them notice it.
  NEW_LOGIN_ALERT_THROTTLE_HOURS: 6,

  // Auth section round 1 — server-side sessions (migration 0047).
  // A session's ABSOLUTE lifetime: the hard stop that silent token renewal
  // (getMe re-issues a token when <24h remain) can never push past, however
  // often the client checks in. After this the user signs in again.
  SESSION_ABSOLUTE_LIFETIME_DAYS: 30,
  // Live sessions kept per user; signing in beyond this revokes the
  // least-recently-used one (enforced in create_user_session()).
  SESSION_MAX_ACTIVE: 20,
  // How often an active session's last_seen_at / IP is refreshed. Bounded so
  // an authenticated request costs a session WRITE at most this often, not
  // on every call.
  SESSION_TOUCH_INTERVAL_MINUTES: 10,
  ROLE_CATEGORIES: [
    'software_engineering','product_management','design','data_science',
    'marketing','sales','operations','finance','healthcare','legal','education','other'
  ],
  SENIORITY_LEVELS: ['junior','mid','senior','lead','executive'],
}
