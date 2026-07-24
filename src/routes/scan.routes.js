const { Hono } = require('hono')
const auth         = require('../middleware/auth')
const rl           = require('../middleware/rateLimiter')
const uploadResume = require('../middleware/upload')
const c            = require('../controllers/scan.controller')

const router = new Hono()

// POST / — submit resume for scanning
// optionalAuth is app-wide (index.js) — c.get('user') already set if logged in.
// anonScan skip checks c.get('user') — same skip logic as v8, just Hono-shaped.
router.post('/',                 rl.anonScan, uploadResume, c.createScan)
// /history MUST come before /:id — Hono matches in registration order
router.get( '/history',          auth,        c.getScanHistory)
router.get( '/status/:id',                    c.getScanStatus)
router.get( '/:id',                           c.getScan)
router.post('/:id/initiate-fix', auth,        c.initiateFix)
router.post('/:id/retry-fix',    auth, rl.payment, c.retryFix)
router.get( '/:id/download',     auth,        c.downloadFile)

module.exports = router
