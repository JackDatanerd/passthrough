const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const rl    = require('../middleware/rateLimiter')
const validateUuidParam = require('../middleware/validateUuidParam')
const auth  = require('../middleware/auth')
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
// Round 6: every conversion, paged (the dashboard itself only carries the latest 50).
// Round 15: the "sales in this payout" statement pages through here too (up to 10 requests), so it uses the same roomier bucket.
// Round 10: the CSV export (?export=1) pages through this route up to 50 times; it has its own bucket so exporting a
// long history cannot spend the dashboard's read budget.
router.get( '/conversions',    (ctx, next) => (ctx.req.query('export') === '1' || ctx.req.query('payoutId') ? rl.partnerExport : rl.partnerRead)(ctx, next), c.getPartnerConversions)
router.post('/request-payout-link', rl.partnerLinkRequest, c.requestPayoutLink)
// Round 7: "I lost my link" — mails the read-only dashboard link to the address on file (own limiter bucket).
router.post('/recover-links', rl.partnerRecover, c.recoverPartnerLinks)
// Round 10: "reset my links" — replaces BOTH links and mails the new ones to the address on file (never returned).
router.post('/reset-links', rl.partnerReset, c.resetMyPartnerLinks)
// Round 10: a signed-in person's referral attribution, kept on the account so it survives a device switch / cleared storage.
router.post('/attribution', auth, rl.referralAttribution, c.setMyReferralAttribution)
// Round 5: the partner's own email preference (per-sale emails on/off).
router.post('/notifications', rl.partnerPrefs, c.updatePartnerNotifications)
// Round 8: record acceptance of the current terms version (either partner token). Same light bucket as the prefs switch.
router.post('/accept-terms',  rl.partnerPrefs, c.acceptPartnerTerms)

// Public — click tracking. Rate-limited with its own dedicated bucket
// (rl.click) rather than sharing rl.employerLead's lead-spam bucket — see
// rateLimiter.js's `click` comment.
router.post('/track-click', rl.click, c.trackClick)

// Public — "become a partner" application (rate-limited like the other public writes).
router.get( '/program', rl.partnerProgram, c.getProgramTerms)
router.post('/apply', rl.partnerApply, c.applyAsPartner)

// Admin — application review. Registered BEFORE the '/:id' routes below so
// 'applications' is never parsed as a partner id.
router.get( '/applications',                    admin, c.adminListApplications)
// STEP-UP (round 10): approving mints a partner (email + commission rate + payout link), same as creating one below.
router.post('/applications/:id/approve',        admin, admin.stepUp, validateUuidParam(), c.adminApproveApplication)
router.post('/applications/:id/reject',         admin, validateUuidParam(), c.adminRejectApplication)
router.post('/applications/:id/reopen',         admin, validateUuidParam(), c.adminReopenApplication)

// Admin only
router.post( '/',                          admin, admin.stepUp, c.adminCreatePartner)
router.get(  '/',                          admin, c.adminListPartners)
// Round 5: cross-partner views. Registered BEFORE '/:id' so these literals are never
// parsed as a partner id.
router.get(  '/overview',                  admin, c.adminPartnersOverview)
router.get(  '/codes',                     admin, c.adminListReferralCodes)
router.get(  '/payouts',                   admin, c.adminListPayouts)
router.get(  '/ledger',                    admin, c.adminListLedger)
// Round 18: paid sales that used a code but have no commission row (declared before '/:id').
router.get(  '/unrecorded-commissions',     admin, c.adminListUnrecordedCommissions)
// Round 6: record a whole payout run in one call (each item runs the single-payout checks).
router.post( '/payouts/batch',             admin, admin.stepUp, c.adminRecordPayoutBatch)
// Round 8: email partners who have not accepted the current terms version (batched, resumable).
router.post( '/terms-notice',              admin, c.adminSendTermsNotice)
router.get(  '/:id',                       admin, validateUuidParam(), c.adminGetPartner)
// commission_rate/status (ACTIVE/PAUSED) had no write path at all until
// this — see adminUpdatePartner's comment in partners.controller.js.
// name/email closed in the same pass (Admin panel).
//
// BUG FIX (traced from Section 11/12's audit of validateUuidParam.js — every
// :id/:codeId route below was still handing an unvalidated param straight to
// `.eq('id'/'code_id', ...)` against a uuid column, same uncaught-500 shape
// the middleware exists to prevent elsewhere): validated here too.
// STEP-UP (cross-cutting infra round 5): the partner's email is where every payout link goes, and the commission rate
// is what they earn — changing either is a payout decision, like the payout routes below. Name / status / profile edits
// stay one click.
const partnerMoneyEdit = admin.stepUpWhen(body => !!body && (body.email !== undefined || body.commissionRate !== undefined))
router.patch('/:id',                       admin, partnerMoneyEdit, validateUuidParam(), c.adminUpdatePartner)
// resend / regenerate / links hand the payout-details WRITE token back in the JSON (resend only when the email failed) —
// a stolen bearer token could otherwise read it and re-point the partner's payouts.
router.post( '/:id/resend-link',           admin, admin.stepUp, validateUuidParam(), c.adminResendPayoutLink)
router.post( '/:id/regenerate-link',       admin, admin.stepUp, validateUuidParam(), c.adminRegeneratePayoutLink)
router.get(  '/:id/links',                 admin, admin.stepUp, validateUuidParam(), c.adminGetPartnerLinks)
router.post( '/:id/payouts',               admin, admin.stepUp, validateUuidParam(), c.adminRecordPayout)
router.post( '/:id/payouts/:payoutId/void', admin, admin.stepUp, validateUuidParam(), validateUuidParam('payoutId'), c.adminVoidPayout)
router.post( '/:id/anonymize',            admin, admin.stepUp, validateUuidParam(), c.adminAnonymizePartner)
// Round 8: manual ledger adjustment (clawback / write-off / bonus). It moves money, so it needs the same
// step-up as recording or voiding a payout.
router.post( '/:id/adjustments',          admin, admin.stepUp, validateUuidParam(), c.adminAdjustLedger)
// Round 18: reject one sale (negative ledger row, like a refund, without touching the buyer's payment).
router.post( '/:id/ledger/:ledgerId/reverse', admin, admin.stepUp, validateUuidParam(), validateUuidParam('ledgerId'), c.adminReverseSale)
// STEP-UP (round 10): a code's tier prices decide what a buyer pays and what the partner earns on it, so setting or changing
// them is a money decision like the commission rate above. Switching a code off / changing its limit or expiry stays one click.
const priceEdit = admin.stepUpWhen(body => !!body && body.tierPrices !== undefined)
router.post( '/:id/referral-codes',        admin, priceEdit, validateUuidParam(), c.adminCreateReferralCode)
router.patch('/referral-codes/:codeId',    admin, priceEdit, validateUuidParam('codeId'), c.adminUpdateReferralCode)

module.exports = router
