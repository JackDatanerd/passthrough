const { Hono } = require('hono')
const auth = require('../middleware/auth')
const rl   = require('../middleware/rateLimiter')
const c    = require('../controllers/payments.controller')

const router = new Hono()

router.post('/initialize', auth, rl.payment, c.initializePayment)
router.get( '/verify',     auth,             c.verifyPayment)
router.get( '/history',    auth,             c.getPaymentHistory)

module.exports = router
