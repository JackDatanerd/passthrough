const { Hono } = require('hono')
const c = require('../controllers/verify.controller')

const router = new Hono()

router.get('/:code', c.getVerification)

module.exports = router
