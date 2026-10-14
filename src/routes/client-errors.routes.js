const { Hono } = require('hono')
const rl = require('../middleware/rateLimiter')
const c  = require('../controllers/client-errors.controller')

const router = new Hono()

// Public: the SPA reports a crash in a visitor's browser (see the controller). No auth — a crash on the sign-in page
// has no session to present — so the per-IP bucket and the controller's alert ceilings are the guards.
router.post('/', rl.clientError, c.reportClientError)

module.exports = router
