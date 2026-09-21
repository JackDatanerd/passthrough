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

// FEATURE GAP CLOSED (Section 5, fixing-time pass): lifecycle management —
// the leads list was read-only with no way to track outreach or clear spam.
router.patch( '/:id', admin, c.adminUpdateLeadStatus)
router.delete('/:id', admin, c.adminDeleteLead)

module.exports = router
