const { Hono } = require('hono')
const auth  = require('../middleware/auth')
const admin = require('../middleware/adminOnly')
const rl    = require('../middleware/rateLimiter')
const c     = require('../controllers/payments.controller')

const router = new Hono()

router.post('/initialize', auth, rl.payment, c.initializePayment)
// AUDIT FIX (feature gap): initializePayment's 409 ("...finish or cancel it")
// had no cancel path behind it anywhere — see cancelPayment's comment in
// payments.controller.js.
//
// AUDIT FIX (Section 3/4 re-audit, bug): this used to run through `rl.payment`
// — the SAME bucket as /initialize above — so a user who burned that tight
// 3-per-minute budget just trying to check out could no longer reach the one
// endpoint built specifically to get them unstuck. See rl.paymentCancel's
// comment in rateLimiter.js.
router.post('/:reference/cancel', auth, rl.paymentCancel, c.cancelPayment)
// AUDIT FIX (Payments & Pricing pass 1, bug — B2): had no limiter of its own
// beyond the app-wide 100-per-15-minutes-per-IP one, despite every call being
// a live Paystack round trip. rl.paymentVerify is per-account (rateLimiter.js).
router.get( '/verify',     auth, rl.paymentVerify, c.verifyPayment)
router.get( '/history',    auth,             c.getPaymentHistory)
// G3 (Payments & Pricing round 3): the caller's own open checkout for a scan, if any.
router.get( '/pending',    auth,             c.getPendingPayment)
// Manual recovery for a payment stuck between "marked SUCCESS" and "fix
// actually enqueued" — see reconcilePayment's comment in
// payments.controller.js and the matching hardening in
// webhooks.controller.js's handlePaystack.
router.post('/:reference/reconcile', auth, admin, c.reconcilePayment)
// Section 8 audit: PENDING/ABANDONED/FAILED payments (held mismatches, lost
// webhooks) — ask Paystack and settle if the money really arrived.
router.post('/:reference/recheck',   auth, admin, c.recheckPayment)
// Section 8 audit: reverse a sale (refund / lost dispute) or clear a won dispute.
router.post('/:reference/resolve',   auth, admin, c.resolvePayment)
// FEATURE GAP CLOSED (Payments & Pricing pass 1 — G1): admin-only — queues an
// actual refund with Paystack (see refundPayment's own comment in
// payments.controller.js for why this never touches our row directly).
router.post('/:reference/refund',    auth, admin, c.refundPayment)
// FEATURE GAP CLOSED (Payments & Pricing pass 1 — G4): owner-only (checked
// inside resendPaymentReceipt itself, same as verify/history) — re-sends a
// receipt to the buyer's current email. rl.paymentReceipt caps it because
// each call is a real outbound email.
router.post('/:reference/receipt',   auth, rl.paymentReceipt, c.resendPaymentReceipt)

module.exports = router
