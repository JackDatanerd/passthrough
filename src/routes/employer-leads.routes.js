const { Hono } = require('hono')
const rl    = require('../middleware/rateLimiter')
const admin = require('../middleware/adminOnly')
const c     = require('../controllers/employer-leads.controller')

const router = new Hono()

router.post('/', rl.employerLead, c.createLead)

// AUDIT FIX (Section 5): the retrieval side of the lead-capture gap — leads
// were being written with no way for anyone to ever read them back short of
// a manual Supabase query.
router.get('/', admin, c.adminListLeads)

module.exports = router
