const { Hono } = require('hono')
const limits = require('../middleware/humanDemandLimits')
const c  = require('../controllers/human-demand.controller')
const { humanDemandEnabled } = require('../lib/humanDemand')

const router = new Hono()

// The flag gate runs FIRST, before the rate limiter and the handler: while HUMAN_DEMAND_ENABLED is not exactly "true" every
// path under /api/human-demand answers the app's ordinary 404, as if these routes did not exist.
router.use('*', async (ctx, next) => (humanDemandEnabled(ctx.env) ? next() : ctx.notFound()))

// Public (a visitor may scan without an account). No auth required; a signed-in caller is recognised by the app-wide optionalAuth.
router.get('/config',    limits.config,   c.getConfig)
router.post('/events',   limits.events,   c.postEvent)
router.post('/waitlist', limits.waitlist, c.postWaitlist)

module.exports = router
