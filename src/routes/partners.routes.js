const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const rl    = require('../middleware/rateLimiter')
const c     = require('../controllers/partners.controller')

const router = new Hono()

// Public — partner self-serve, gated by the emailed token (?token=...), not
// a route param, since the pages that read it are plain pages, not
// :id-style resource routes.
router.get( '/payout-details', c.getPartnerByToken)
router.post('/payout-details', c.submitPayoutDetails)
router.get( '/dashboard',      c.getPartnerDashboard)

// Public — click tracking. Rate-limited like the other public write
// endpoint in this app (employer-leads) since it's unauthenticated.
// AUDIT FIX (Section 9): was rl.employerLead — shared the lead-spam bucket
// with POST /employer-leads. See rateLimiter.js's `click` comment.
router.post('/track-click', rl.click, c.trackClick)

// Admin only
router.post('/',                          admin, c.adminCreatePartner)
router.get( '/',                          admin, c.adminListPartners)
// AUDIT FIX (Section 10, feature gap): commission_rate and status
// (ACTIVE/PAUSED) had no write path at all until now — see
// adminUpdatePartner's comment in partners.controller.js.
router.patch('/:id',                      admin, c.adminUpdatePartner)
router.post('/:id/resend-link',           admin, c.adminResendPayoutLink)
router.post('/:id/payouts',               admin, c.adminRecordPayout)
router.post('/:id/referral-codes',        admin, c.adminCreateReferralCode)
router.patch('/referral-codes/:codeId',   admin, c.adminSetReferralCodeActive)

module.exports = router
