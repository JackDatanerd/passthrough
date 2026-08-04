const { Hono } = require('hono')
const c = require('../controllers/pricing.controller')

const router = new Hono()

// Public — no auth, no ownership to check, just current pricing config.
router.get('/', c.getPricing)

module.exports = router
