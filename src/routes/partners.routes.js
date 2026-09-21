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

// Public — click tracking. Rate-limited with its own dedicated bucket
// (rl.click) rather than sharing rl.employerLead's lead-spam bucket — see
// rateLimiter.js's `click` comment.
router.post('/track-click', rl.click, c.trackClick)

// Admin only
router.post( '/',                          admin, c.adminCreatePartner)
router.get(  '/',                          admin, c.adminListPartners)
router.get(  '/:id',                       admin, c.adminGetPartner)
// commission_rate/status (ACTIVE/PAUSED) had no write path at all until
// this — see adminUpdatePartner's comment in partners.controller.js.
// name/email closed in the same pass (Admin panel).
router.patch('/:id',                       admin, c.adminUpdatePartner)
router.post( '/:id/resend-link',           admin, c.adminResendPayoutLink)
router.post( '/:id/regenerate-link',       admin, c.adminRegeneratePayoutLink)
router.post( '/:id/payouts',               admin, c.adminRecordPayout)
router.post( '/:id/referral-codes',        admin, c.adminCreateReferralCode)
router.patch('/referral-codes/:codeId',    admin, c.adminUpdateReferralCode)

module.exports = router
