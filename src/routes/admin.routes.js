const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const validateUuidParam = require('../middleware/validateUuidParam')
const c     = require('../controllers/admin.controller')
const rl    = require('../middleware/rateLimiter')
const wh    = require('../controllers/webhooks.controller')

const router = new Hono()

// Every route in this file is admin-only — applied once here rather than
// per-route, since there is no non-admin endpoint in this router at all.
router.use('*', admin)

// Password confirmation that unlocks the money / ban routes for a few minutes (only when ADMIN_STEP_UP_MINUTES > 0).
router.post('/elevate', rl.auth, c.adminElevate)

router.get('/dashboard', c.adminDashboardStats)
router.get('/health', c.adminHealth)

router.get('/users',    c.adminListUsers)
router.get('/users/:id', validateUuidParam(), c.adminGetUserDetail)
router.patch('/users/:id', admin.stepUp, validateUuidParam(), c.adminUpdateUser)

router.get('/scans',    c.adminListScans)
router.patch('/scans/:id/verification', validateUuidParam(), c.adminSetVerification)
router.get('/payments', c.adminListPayments)

// One-off: fingerprint PDFs of pages issued before migration 0025 (see the controller).
router.post('/verification/backfill-pdf-hashes', c.adminBackfillPdfHashes)

// Manual re-run of a paid fix that failed to generate (see adminRequeueFix).
router.post('/scans/:id/requeue-fix', validateUuidParam(), c.adminRequeueFix)

// Webhook inbox (Section 8): what Paystack sent, what we did with it, and a replay
// for anything that was HELD / FAILED / IGNORED.
router.get('/webhook-events', wh.listWebhookEvents)
router.get('/webhook-events/health', wh.getWebhookHealth)   // before /:id so 'health' is not read as an id
router.get('/webhook-events/:id', validateUuidParam(), wh.getWebhookEvent)
router.post('/webhook-events/:id/replay', validateUuidParam(), wh.replayWebhookEvent)

router.get('/email-logs', c.adminListEmailLogs)
router.get('/alerts',     c.adminListAlerts)
// Addresses we no longer send non-security mail to (permanent bounce / spam complaint).
router.get('/email-suppressions',    c.adminCheckEmailSuppression)
router.delete('/email-suppressions', c.adminLiftEmailSuppression)

// Section 12 audit (feature gap): read path for admin_audit_log — see
// adminListAuditLog's own comment.
router.get('/audit-log',  c.adminListAuditLog)

module.exports = router
