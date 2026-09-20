const { Hono } = require('hono')
const auth  = require('../middleware/auth')
const admin = require('../middleware/adminOnly')
const rl    = require('../middleware/rateLimiter')
const c     = require('../controllers/payments.controller')

const router = new Hono()

router.post('/initialize', auth, rl.payment, c.initializePayment)
router.get( '/verify',     auth,             c.verifyPayment)
router.get( '/history',    auth,             c.getPaymentHistory)
// Manual recovery for a payment stuck between "marked SUCCESS" and "fix
// actually enqueued" — see reconcilePayment's comment in
// payments.controller.js and the matching hardening in
// webhooks.controller.js's handlePaystack.
router.post('/:reference/reconcile', auth, admin, c.reconcilePayment)

module.exports = router
