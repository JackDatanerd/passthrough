const { Hono } = require('hono')
const auth = require('../middleware/auth')
const rl   = require('../middleware/rateLimiter')
const validateUuidParam = require('../middleware/validateUuidParam')
const c    = require('../controllers/outcomes.controller')

const router = new Hono()

router.get(   '/pending',           auth, c.pendingOutcomes)
router.put(   '/',                  auth, rl.outcomeWrite, c.submitOutcome)
router.delete('/:scanId/story',     auth, rl.outcomeWrite, validateUuidParam('scanId'), c.withdrawStory)

module.exports = router
