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
router.post('/track-click', rl.employerLead, c.trackClick)

// Admin only
router.post('/',                          admin, c.adminCreatePartner)
router.get( '/',                          admin, c.adminListPartners)
router.post('/:id/resend-link',           admin, c.adminResendPayoutLink)
router.post('/:id/payouts',               admin, c.adminRecordPayout)
router.post('/:id/referral-codes',        admin, c.adminCreateReferralCode)
router.patch('/referral-codes/:codeId',   admin, c.adminSetReferralCodeActive)

module.exports = router
