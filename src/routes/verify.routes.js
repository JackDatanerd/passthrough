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
// The same badge as a PNG — for e-mail signatures, LinkedIn and anywhere SVG is not displayed.
router.get('/:code/badge.png', c.getBadgePng)
// ROUND-7: the link-preview image; edge-cached and quota'd like the badge, so no verifyRead limiter.
router.get('/:code/card.png',  c.getCardPng)

module.exports = router
