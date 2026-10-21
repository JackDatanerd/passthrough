const { Hono } = require('hono')
const auth = require('../middleware/auth')
const rl = require('../middleware/rateLimiter')
const c = require('../controllers/pricing.controller')

const router = new Hono()

// Public — no auth, no ownership to check, just current pricing config.
// rl.pricingRef only bites when ?ref= is present (see rateLimiter.js).
router.get('/', rl.pricingRef, c.getPricing)
// Signed in: the account's own welcome code (an account only ever sees its own).
router.get('/welcome-offer', auth, c.getWelcomeOffer)

module.exports = router
