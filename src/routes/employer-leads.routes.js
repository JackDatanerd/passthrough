const { Hono } = require('hono')
const rl = require('../middleware/rateLimiter')
const c  = require('../controllers/employer-leads.controller')

const router = new Hono()

router.post('/', rl.employerLead, c.createLead)

module.exports = router
