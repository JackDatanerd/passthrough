const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const c     = require('../controllers/partners.controller')

const router = new Hono()

// Public — partner self-serve payout details, gated by the emailed token
// (not a route param, a query string — ?token=... — since the frontend
// pages that read it are plain pages, not :id-style resource routes).
router.get( '/payout-details', c.getPartnerByToken)
router.post('/payout-details', c.submitPayoutDetails)

// Admin only
router.post('/',                    admin, c.adminCreatePartner)
router.get( '/',                    admin, c.adminListPartners)
router.post('/:id/resend-link',     admin, c.adminResendPayoutLink)
router.post('/:id/payouts',         admin, c.adminRecordPayout)

module.exports = router
