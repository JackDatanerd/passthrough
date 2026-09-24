const { Hono } = require('hono')
const rl    = require('../middleware/rateLimiter')
const admin = require('../middleware/adminOnly')
const validateUuidParam = require('../middleware/validateUuidParam')
const c     = require('../controllers/employer-leads.controller')

const router = new Hono()

router.post('/', rl.employerLead, c.createLead)

// AUDIT FIX (Section 5): the retrieval side of the lead-capture gap — leads
// were being written with no way for anyone to ever read them back short of
// a manual Supabase query.
router.get('/', admin, c.adminListLeads)
// Must not be shadowed by a future GET /:id.
router.get('/export.csv', admin, c.adminExportLeads)

// Admin-only writes that are not keyed by an :id, registered before the /:id
// routes so 'manual' / 'bulk' can never be read as an id.
router.post('/manual', admin, c.adminCreateLead)
router.post('/bulk',   admin, c.adminBulkUpdateLeads)

// FEATURE GAP CLOSED (Section 5, fixing-time pass): lifecycle management —
// the leads list was read-only with no way to track outreach or clear spam.
//
// BUG FIX (traced from Section 11/12's audit of validateUuidParam.js — the
// middleware existed and was wired into scan.routes.js and one
// admin.routes.js route, but not here): a malformed :id was falling through
// to `.eq('id', ...)` against a uuid column and surfacing as an uncaught 500
// via errorHandler.js's generic branch instead of a clean 400.
router.patch( '/:id', admin, validateUuidParam(), c.adminUpdateLeadStatus)
router.delete('/:id', admin, validateUuidParam(), c.adminDeleteLead)

module.exports = router
