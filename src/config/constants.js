// Single source of truth for all tunable values — identical to the v8 spec.
// Only change from the original: UPLOAD_DIR is removed. R2 doesn't need a
// filesystem path; src/config/storage.js builds object keys as plain strings.
//
// CommonJS by design — only src/index.js uses ESM (see Section 9 of the
// Cloudflare migration patch). esbuild bundles require()/module.exports
// into the ESM entry point without issue.

module.exports = {
  PRICE_FIX:   4900,    // $49.00 USD cents
  PRICE_BADGE: 3900,    // $39.00 USD cents
  CURRENCY:    'USD',
  ATS_PASS_THRESHOLD:  75,
  ATS_BADGE_THRESHOLD: 80,
  // < 75: FAIL → $49 | 75-79: PASS no badge → $49 | 80+: PASS → $39 or $49
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
  SHORT_CODE_LENGTH: 6,
  SHORT_CODE_CHARS:  'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  EMAIL_TOKEN_EXPIRY_HOURS: 1,
  RESET_TOKEN_EXPIRY_HOURS: 1,
  ROLE_CATEGORIES: [
    'software_engineering','product_management','design','data_science',
    'marketing','sales','operations','finance','healthcare','legal','education','other'
  ],
  SENIORITY_LEVELS: ['junior','mid','senior','lead','executive'],
}
