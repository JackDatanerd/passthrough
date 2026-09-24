const { Hono } = require('hono')
const rl = require('../middleware/rateLimiter')
const c  = require('../controllers/verify.controller')

const router = new Hono()

router.get('/:code',           rl.verifyRead, c.getVerification)
router.get('/:code/download',  rl.verifyRead, c.downloadVerifiedFile)
// Embeddable live status badge — image/svg+xml, cacheable, no view count.
router.get('/:code/badge.svg', c.getBadge)

module.exports = router
