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
router.post('/:id/redeem-credit', auth, rl.payment, validateUuidParam(), c.redeemCredit)
router.post('/:id/retry-fix',    auth, rl.payment, validateUuidParam(), c.retryFix)
router.patch('/:id/verify-visibility', auth, validateUuidParam(), c.updateVerifyVisibility)
router.get( '/:id/download',     auth,        validateUuidParam(), c.downloadFile)
// AUDIT FIX (feature gap — section audit "generate a resume from scratch"):
// deliberately NOT behind `auth` — ownership is enforced inside the
// controllers via anon_token (same model as GET /:id above), since an
// anonymous brain-dump submitter should be able to review/correct their
// extracted data and get their free draft back without registering first.
router.patch('/:id/resume-data',   rl.resumeEdit, validateUuidParam(), c.updateResumeData)
router.get( '/:id/download-draft', rl.resumeEdit, validateUuidParam(), c.downloadDraft)

module.exports = router
