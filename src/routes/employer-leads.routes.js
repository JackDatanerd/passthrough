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
// The confirmed page asks for the field when the lead has none (same signed confirm token).
router.post('/field', rl.employerLeadLink, c.setLeadField)
// BUG FIX (independent audit round 8): the two OPT-OUT endpoints left the shared 30/hour bucket
// above. Mailbox providers send RFC 8058 one-click requests from a small pool of shared IPs, so
// a modest number of recipients could 429 each other's unsubscribes — and failing to honour an
// opt-out is the one failure here that is not just an inconvenience. A signed token already
// gates both, so they get their own, much larger bucket (and skip the generic per-IP one).
router.post('/remove',  rl.employerLeadOptOut, c.removeLead)
// RFC 8058 one-click target for the acknowledgement's List-Unsubscribe header (fresh
// audit pass 2, G4). Mail providers POST a form body here with the signed token in the
// query string; POST-only so a scanner's GET can never remove anyone.
router.post('/unsubscribe', rl.employerLeadOptOut, c.unsubscribeLead)
// Independent audit round 7: the same URL opened as a plain link (clients without one-click
// support) used to hit a JSON 404. A GET never removes anyone — it hands off to the remove page.
router.get('/unsubscribe', rl.employerLeadOptOut, c.unsubscribeRedirect)

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
// FEATURE GAP CLOSED (independent audit round 6, G1): tell confirmed leads in a field that now has
// Verified candidates. Not keyed by :id, so it sits with the other fixed-path writes.
router.post('/notify-candidates', admin, c.adminNotifyCandidates)

// FEATURE GAP CLOSED (fresh audit pass, Section 5): the only way to learn an
// address was suppressed used to be trying to re-add it via /manual and
// reading the 409 — see the controller's own comment above adminCheckSuppression.
// Registered before the /:id routes for the same "never read as an id" reason
// as /manual and /bulk above.
router.post(  '/suppressions/check', admin, c.adminCheckSuppression)
// FEATURE GAP CLOSED (fresh audit pass, Section 5): the write side of the do-
// not-contact list — see the controller's own comment above adminAddSuppression
// for why check + lift alone weren't enough.
router.post(  '/suppressions',       admin, c.adminAddSuppression)
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
// Fresh audit pass 2 (G1): an admin recording that the address was confirmed by other means.
router.post(  '/:id/mark-confirmed', admin, validateUuidParam(), c.adminMarkConfirmed)
router.patch( '/:id', admin, validateUuidParam(), c.adminUpdateLeadStatus)
router.delete('/:id', admin, validateUuidParam(), c.adminDeleteLead)

module.exports = router
