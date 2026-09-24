const { Hono } = require('hono')
const auth = require('../middleware/auth')
const rl   = require('../middleware/rateLimiter')
const c    = require('../controllers/profile.controller')

const router = new Hono()

router.get(   '/',      auth, c.getProfile)
router.post(  '/save',  auth, c.saveProfile)
router.delete('/',      auth, c.deleteProfile)
// A full read of the account's scans and payments — rate-limited like the other
// heavy per-user reads.
router.get(   '/export', auth, rl.dataExport, c.exportMyData)

module.exports = router
