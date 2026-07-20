const { Hono } = require('hono')
const auth = require('../middleware/auth')
const c    = require('../controllers/profile.controller')

const router = new Hono()

router.get(   '/',      auth, c.getProfile)
router.post(  '/save',  auth, c.saveProfile)
router.delete('/',      auth, c.deleteProfile)

module.exports = router
