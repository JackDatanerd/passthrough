const { Hono } = require('hono')
const auth         = require('../middleware/auth')
const rl           = require('../middleware/rateLimiter')
const uploadResume = require('../middleware/upload')
const validateUuidParam = require('../middleware/validateUuidParam')
const c            = require('../controllers/scan.controller')

const router = new Hono()

// POST / — submit resume for scanning
// optionalAuth is app-wide (index.js) — c.get('user') already set if logged in.
// anonScan skip checks c.get('user') — same skip logic as v8, just Hono-shaped.
router.post('/',                 rl.anonScan, uploadResume, c.createScan)
// /history MUST come before /:id — Hono matches in registration order
router.get( '/history',          auth,        c.getScanHistory)
// BUG FIX (traced from Section 6's audit — see validateUuidParam.js): every
// one of these hands :id straight to a `.eq('id', ...)` query, so a
// malformed id used to surface as a generic 500 instead of a clean 400.
router.get( '/status/:id',  rl.scanPoll,      validateUuidParam(), c.getScanStatus)
router.get( '/:id',         rl.scanPoll,      validateUuidParam(), c.getScan)
router.post('/:id/initiate-fix', auth, rl.fixQuote, validateUuidParam(), c.initiateFix)
// AUDIT FIX (Section 9/10 pass, bug): these two used to share `rl.payment` —
// the same KV bucket as initializePayment, not just the same numbers — which
// let either action starve the other for an unrelated reason. See
// middleware/rateLimiter.js's own comment on retryFix/redeemCredit for the
// full reasoning (same fate-sharing class as paymentCancel/click/partnerWrite
// being split off their own shared buckets elsewhere in this codebase).
router.post('/:id/redeem-credit', auth, rl.redeemCredit, validateUuidParam(), c.redeemCredit)
router.post('/:id/retry-fix',    auth, rl.retryFix, validateUuidParam(), c.retryFix)
// FEATURE (Auth/Scan round): re-render a PDF that failed to generate at delivery.
router.post('/:id/regenerate-pdf', auth, rl.pdfRegen, validateUuidParam(), c.regeneratePdf)
router.patch('/:id/verify-visibility', auth, validateUuidParam(), c.updateVerifyVisibility)
router.get( '/:id/download',     auth,        validateUuidParam(), c.downloadFile)
// Owner-only removal of one scan and everything stored for it (see deleteScan).
// Anonymous results are deleted by their token (checked inside deleteScan), signed-in ones by
// their owner — so no `auth` here.
router.delete('/:id',            validateUuidParam(), c.deleteScan)
// AUDIT FIX (feature gap — section audit "generate a resume from scratch"):
// deliberately NOT behind `auth` — ownership is enforced inside the
// controllers via anon_token (same model as GET /:id above), since an
// anonymous brain-dump submitter should be able to review/correct their
// extracted data and get their free draft back without registering first.
router.patch('/:id/resume-data',   rl.resumeEdit, validateUuidParam(), c.updateResumeData)
router.get( '/:id/download-draft', rl.draftDownload, validateUuidParam(), c.downloadDraft)
router.get( '/:id/download-draft-pdf', rl.pdfRegen, validateUuidParam(), c.downloadDraftPdf)
// Build (and store) the structure of an uploaded file so it can be reviewed/corrected before paying.
router.post('/:id/structure',      rl.resumeEdit, validateUuidParam(), c.structureResume)
// G1 (round 3): re-run a free scan that failed on our side, in place. rl.anonScan spends the anonymous
// visitor's hourly slot (and hands it back on a 4xx/5xx); logged-in users are metered by the account quota.
router.post('/:id/retry-scan',     rl.anonScan, validateUuidParam(), c.retryScan)
// Owner edits to the DELIVERED resume (both files rebuilt and re-scored), and its cover letter.
router.patch('/:id/delivered-resume', auth, rl.resumeEdit, validateUuidParam(), c.updateDeliveredResume)
router.post('/:id/cover-letter',   auth, rl.resumeEdit, validateUuidParam(), c.generateCoverLetter)
router.get( '/:id/cover-letter',   auth, rl.draftDownload, validateUuidParam(), c.downloadCoverLetter)

module.exports = router
