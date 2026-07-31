const { Hono } = require('hono')
const auth         = require('../middleware/auth')
const rl           = require('../middleware/rateLimiter')
const c            = require('../controllers/auth.controller')

const router = new Hono()

router.post('/register',            rl.auth, c.register)
router.post('/login',               rl.auth, c.login)
router.get( '/me',                  auth,    c.getMe)
router.post('/forgot-password',     rl.auth, c.forgotPassword)
router.post('/reset-password',      rl.auth, c.resetPassword)
router.get( '/verify-email',        rl.auth, c.verifyEmail)
router.post('/resend-verification', auth, rl.auth, c.resendVerification)
router.patch('/password',           auth, rl.auth, c.changePassword)
router.delete('/account',           auth, rl.auth, c.deleteAccount)
router.post('/claim-scan',          auth,    c.claimScan)

module.exports = router
