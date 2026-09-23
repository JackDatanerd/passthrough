const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const rl    = require('../middleware/rateLimiter')
const validateUuidParam = require('../middleware/validateUuidParam')
const c     = require('../controllers/partners.controller')

const router = new Hono()

// Public — partner self-serve, gated by the emailed token (?token=...), not
// a route param, since the pages that read it are plain pages, not
// :id-style resource routes.
//
// AUDIT FIX (bug): these three had no rate limit at all — see rateLimiter.js's
// partnerRead/partnerWrite comment. The token itself is unguessable, so this
// is hardening, not a fix for an exploited gap: a throttle on a leaked/logged
// token, and on the expensive dashboard join, where previously there was none.
router.get( '/payout-details', rl.partnerRead,  c.getPartnerByToken)
router.post('/payout-details', rl.partnerWrite, c.submitPayoutDetails)
router.get( '/dashboard',      rl.partnerRead,  c.getPartnerDashboard)

// Public — click tracking. Rate-limited with its own dedicated bucket
// (rl.click) rather than sharing rl.employerLead's lead-spam bucket — see
// rateLimiter.js's `click` comment.
router.post('/track-click', rl.click, c.trackClick)

// Admin only
router.post( '/',                          admin, c.adminCreatePartner)
router.get(  '/',                          admin, c.adminListPartners)
router.get(  '/:id',                       admin, validateUuidParam(), c.adminGetPartner)
// commission_rate/status (ACTIVE/PAUSED) had no write path at all until
// this — see adminUpdatePartner's comment in partners.controller.js.
// name/email closed in the same pass (Admin panel).
//
// BUG FIX (traced from Section 11/12's audit of validateUuidParam.js — every
// :id/:codeId route below was still handing an unvalidated param straight to
// `.eq('id'/'code_id', ...)` against a uuid column, same uncaught-500 shape
// the middleware exists to prevent elsewhere): validated here too.
router.patch('/:id',                       admin, validateUuidParam(), c.adminUpdatePartner)
router.post( '/:id/resend-link',           admin, validateUuidParam(), c.adminResendPayoutLink)
router.post( '/:id/regenerate-link',       admin, validateUuidParam(), c.adminRegeneratePayoutLink)
router.post( '/:id/payouts',               admin, validateUuidParam(), c.adminRecordPayout)
router.post( '/:id/referral-codes',        admin, validateUuidParam(), c.adminCreateReferralCode)
router.patch('/referral-codes/:codeId',    admin, validateUuidParam('codeId'), c.adminUpdateReferralCode)

module.exports = router
