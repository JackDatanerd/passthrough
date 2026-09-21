// AUDIT FIX: ScoreGauge.jsx, CategoryScores.jsx, and FixBanner.jsx each had
// their own hardcoded copy of the pass/badge thresholds (75 / 80) — the
// same numbers as the backend's ATS_PASS_THRESHOLD/ATS_BADGE_THRESHOLD
// (src/config/constants.js), just re-typed three times independently.
// They agree today by coincidence of nobody having changed either value
// since; the moment one does, these three drift out of sync with each
// other AND with the actual pass/badge gating the backend enforces.
//
// Where the backend already computes and sends the real answer for a given
// scan (`scan.passed`, `scan.badgeEligible`), prefer that — it accounts for
// the live constants.js value with no risk of drift at all. These are a
// fallback for callers that only have a bare score number (e.g. no scan
// object in hand yet), and for the per-category bars in CategoryScores.jsx,
// which have no server-computed equivalent to defer to since the backend
// doesn't compute a pass/fail per category, only overall. Frontend and
// backend are separate deployables here (no shared package), so this can't
// literally import from src/config/constants.js — but at least a threshold
// that needs to change now only needs changing in one frontend place, not
// three.
export const ATS_PASS_THRESHOLD  = 75
export const ATS_BADGE_THRESHOLD = 80
// Mirrors constants.js's MAX_FIX_RETRIES — same duplication risk as the
// score thresholds above; used by ScanResult.jsx's retry-count display.
export const MAX_FIX_RETRIES = 2
