const { Hono } = require('hono')
const auth = require('../middleware/auth')
const rl   = require('../middleware/rateLimiter')
const validateUuidParam = require('../middleware/validateUuidParam')
const c    = require('../controllers/outcomes.controller')
const { runInBackground } = require('../lib/background')

// The hourly follow-up email is sent by the cron, which has no request to read the API's public address from. A
// signed-in dashboard visit does, so remember it (employer-leads.controller keeps it in KV) — that is what lets the
// email carry its one-click unsubscribe header. Best effort; never delays or fails the request.
async function rememberOrigin(ctx, next) {
  try {
    const el = require('../controllers/employer-leads.controller')
    runInBackground(ctx, el.rememberApiOrigin(ctx.env, el.apiOrigin(ctx)))
  } catch (_) { /* best effort */ }
  return next()
}

const router = new Hono()

// Public, token-gated (see unsubscribeFollowUp). Fixed paths, so they cannot be read as a :scanId.
router.post(  '/unsubscribe',        rl.followUpOptOut, c.unsubscribeFollowUp)
router.get(   '/unsubscribe',        rl.followUpOptOut, c.unsubscribeFollowUpRedirect)
router.get(   '/pending',           auth, rememberOrigin, c.pendingOutcomes)
router.put(   '/',                  auth, rl.outcomeWrite, c.submitOutcome)
router.delete('/:scanId/story',     auth, rl.outcomeWrite, validateUuidParam('scanId'), c.withdrawStory)

module.exports = router
