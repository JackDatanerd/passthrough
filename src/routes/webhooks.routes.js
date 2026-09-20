// Normal route file — not a stub. In v8 this file was intentionally empty
// because the webhook needed express.raw() registered BEFORE express.json(),
// which required the route to live directly in app.js in a specific order.
// Hono has no global body parser, so there is no ordering problem to work
// around — the webhook handler is just another Hono route. See Section 4
// of the migration patch for the full explanation.

const { Hono } = require('hono')
const rl = require('../middleware/rateLimiter')
const c  = require('../controllers/webhooks.controller')

const router = new Hono()

// The generic `general` IP limiter (mounted app-wide on /api/* in index.js)
// skips this path — see rateLimiter.js's `general` config — in favor of the
// dedicated, more generous `webhook` limiter below, since this route is
// already protected by HMAC signature verification inside the handler.
router.post('/paystack', rl.webhook, c.handlePaystack)

module.exports = router
