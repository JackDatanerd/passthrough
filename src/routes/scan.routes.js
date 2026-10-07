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
router.post('/:id/initiate-fix', auth,        validateUuidParam(), c.initiateFix)
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
router.delete('/:id',            auth,        validateUuidParam(), c.deleteScan)
// AUDIT FIX (feature gap — section audit "generate a resume from scratch"):
// deliberately NOT behind `auth` — ownership is enforced inside the
// controllers via anon_token (same model as GET /:id above), since an
// anonymous brain-dump submitter should be able to review/correct their
// extracted data and get their free draft back without registering first.
router.patch('/:id/resume-data',   rl.resumeEdit, validateUuidParam(), c.updateResumeData)
router.get( '/:id/download-draft', rl.draftDownload, validateUuidParam(), c.downloadDraft)
router.get( '/:id/download-draft-pdf', rl.pdfRegen, validateUuidParam(), c.downloadDraftPdf)

module.exports = router
