const { Hono } = require('hono')
const rl = require('../middleware/rateLimiter')
const c  = require('../controllers/verify.controller')

const router = new Hono()

// Registered first so `by-hash` is never read as a :code.
// Find the page for a file the reader already holds (they hash it locally; see the controller).
router.get('/by-hash/:hash',   rl.verifyRead, c.lookupByHash)
router.get('/:code',           rl.verifyRead, c.getVerification)
router.get('/:code/download',  rl.verifyRead, c.downloadVerifiedFile)
// Embeddable live status badge — image/svg+xml, cacheable, no view count.
router.get('/:code/badge.svg', c.getBadge)

module.exports = router
