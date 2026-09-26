const { Hono } = require('hono')
const rl    = require('../middleware/rateLimiter')
const admin = require('../middleware/adminOnly')
const validateUuidParam = require('../middleware/validateUuidParam')
const c     = require('../controllers/employer-leads.controller')

const router = new Hono()

router.post('/', rl.employerLead, c.createLead)
// The two links in the acknowledgement email (confirm the address / remove
// it). Public; signed tokens, no session.
//
// BUG FIX (fresh audit pass, Section 5): these used to share the `employerLead`
// bucket with the form above (`rl:lead:<ip>`) — see rateLimiter.js's
// `employerLeadLink` comment for why that's the same fate-sharing mistake
// already fixed for partner click-tracking. Given their own dedicated bucket.
router.post('/confirm', rl.employerLeadLink, c.confirmLead)
router.post('/remove',  rl.employerLeadLink, c.removeLead)

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

// FEATURE GAP CLOSED (fresh audit pass, Section 5): the only way to learn an
// address was suppressed used to be trying to re-add it via /manual and
// reading the 409 — see the controller's own comment above adminCheckSuppression.
// Registered before the /:id routes for the same "never read as an id" reason
// as /manual and /bulk above.
router.post(  '/suppressions/check', admin, c.adminCheckSuppression)
router.delete('/suppressions',       admin, c.adminLiftSuppression)

// FEATURE GAP CLOSED (Section 5, fixing-time pass): lifecycle management —
// the leads list was read-only with no way to track outreach or clear spam.
//
// BUG FIX (traced from Section 11/12's audit of validateUuidParam.js — the
// middleware existed and was wired into scan.routes.js and one
// admin.routes.js route, but not here): a malformed :id was falling through
// to `.eq('id', ...)` against a uuid column and surfacing as an uncaught 500
// via errorHandler.js's generic branch instead of a clean 400.
router.post(  '/:id/request-confirmation', admin, validateUuidParam(), c.adminRequestConfirmation)
router.patch( '/:id', admin, validateUuidParam(), c.adminUpdateLeadStatus)
router.delete('/:id', admin, validateUuidParam(), c.adminDeleteLead)

module.exports = router
