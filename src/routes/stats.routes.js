const { Hono } = require('hono')
const rl = require('../middleware/rateLimiter')
const c  = require('../controllers/stats.controller')

const router = new Hono()

// Public: the homepage's evidence block (see the controller). No auth, edge-cacheable.
router.get('/', rl.statsRead, c.getHomeStats)

module.exports = router
