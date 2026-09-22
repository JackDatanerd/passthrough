const { Hono } = require('hono')
const c = require('../controllers/verify.controller')

const router = new Hono()

router.get('/:code',           c.getVerification)
router.get('/:code/download',  c.downloadVerifiedFile)
// Embeddable live status badge — image/svg+xml, cacheable, no view count.
router.get('/:code/badge.svg', c.getBadge)

module.exports = router
