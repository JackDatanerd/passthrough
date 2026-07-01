const { Hono } = require('hono')
const auth         = require('../middleware/auth')
const rl           = require('../middleware/rateLimiter')
const c            = require('../controllers/auth.controller')

const router = new Hono()

router.post('/register',            rl.auth, c.register)
router.post('/login',               rl.auth, c.login)
router.get( '/me',                  auth,    c.getMe)
router.post('/forgot-password',     rl.auth, c.forgotPassword)
router.post('/reset-password',               c.resetPassword)
router.get( '/verify-email',                 c.verifyEmail)
router.post('/resend-verification', auth, rl.auth, c.resendVerification)
router.patch('/password',           auth,    c.changePassword)
router.delete('/account',           auth,    c.deleteAccount)
router.post('/claim-scan',          auth,    c.claimScan)

module.exports = router
