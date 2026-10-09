// Server-side rule for buying the BADGE (credential-only) tier.
//
// Payments & Pricing round 8: FixBanner has always hidden the Badge button for an UPLOADED FILE until
// the ATS-formatted version of it has been scored and clears the credential bar — the credential is issued on
// the regenerated, formatted document, not on the upload, so the upload's own score says nothing about it. That
// rule lived only in the browser: POST /api/payments/initialize and POST /api/scan/:id/initiate-fix checked just
// `ats_score >= ATS_BADGE_THRESHOLD`, so a direct API call (or a stale tab) could pay for a credential the
// delivered file would not earn — the buyer got the unverified wording plus a compensating credit instead.
// One function now decides it for both endpoints, so the quote and the charge can never disagree.
//
// Typed / saved-profile scans are already scored on the rendered document (ats_score IS the formatted score),
// so only inputMode === 'file' needs the extra proof.
//
// -> null when the Badge may be bought, otherwise { code, message } for a 400.
const c = require('../config/constants')

function badgeBlock(scan) {
  if (!scan) return null
  const threshold = c.ATS_BADGE_THRESHOLD
  if ((scan.atsScore || 0) < threshold)
    return { code: 'BADGE_SCORE_LOW', message: `Badge requires score >= ${threshold}` }
  if (scan.inputMode !== 'file') return null
  const formatted = scan.fullAtsReport && scan.fullAtsReport.formattedScore
  if (formatted == null || !Number.isFinite(Number(formatted)))
    return { code: 'BADGE_FORMATTED_CHECK_REQUIRED',
      message: 'The credential is issued on the ATS-formatted version of your file. Check that version first, then choose the credential.' }
  if (Number(formatted) < threshold)
    return { code: 'BADGE_FORMATTED_LOW',
      message: `The ATS-formatted version of your file scores ${Math.round(Number(formatted))}, under the ${threshold} the credential needs, so a Credential-only purchase would not come out verified. A full Fix rewrites it to clear the bar.` }
  return null
}

module.exports = { badgeBlock }
