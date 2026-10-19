const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const validateUuidParam = require('../middleware/validateUuidParam')
const c     = require('../controllers/admin.controller')
const rl    = require('../middleware/rateLimiter')
const wh    = require('../controllers/webhooks.controller')
const stories = require('../controllers/admin-stories.controller')
const hotCategories = require('../controllers/admin-hot-categories.controller')

const router = new Hono()

// Every route in this file is admin-only — applied once here rather than
// per-route, since there is no non-admin endpoint in this router at all.
router.use('*', admin)

// Password confirmation that unlocks the money / ban routes for a few minutes (only when ADMIN_STEP_UP_MINUTES > 0).
router.post('/elevate', rl.adminElevate, c.adminElevate)

router.get('/dashboard', c.adminDashboardStats)
router.get('/health', c.adminHealth)

router.get('/users',    c.adminListUsers)
router.get('/users/:id', validateUuidParam(), c.adminGetUserDetail)
router.patch('/users/:id', admin.stepUp, validateUuidParam(), c.adminUpdateUser)

router.get('/scans',    c.adminListScans)
// Cross-cutting infra round 6: step-up (when ADMIN_STEP_UP_MINUTES is on) also guards the other writes a stolen
// admin token could abuse — re-issuing / revoking a page, re-driving a paid fix, discarding a payment event and
// re-enabling mail to an address that bounced or complained. Routine moderation stays one click.
router.patch('/scans/:id/verification', admin.stepUp, validateUuidParam(), c.adminSetVerification)
router.get('/verification-reports', c.adminListVerificationReports)
router.patch('/verification-reports/:id', validateUuidParam(), c.adminReviewVerificationReport)
router.get('/payments', c.adminListPayments)

// One-off: fingerprint PDFs of pages issued before migration 0025 (see the controller).
router.post('/verification/backfill-pdf-hashes', c.adminBackfillPdfHashes)

// Manual re-run of a paid fix that failed to generate (see adminRequeueFix).
router.post('/scans/:id/requeue-fix', admin.stepUp, validateUuidParam(), c.adminRequeueFix)

// Webhook inbox (Section 8): what Paystack sent, what we did with it, and a replay
// for anything that was HELD / FAILED / IGNORED.
router.get('/webhook-events', wh.listWebhookEvents)
router.get('/webhook-events/self-test', wh.getWebhookSelfTest)   // before /:id so 'self-test' is not read as an id (Webhooks round 18, G2)
router.get('/webhook-events/health', wh.getWebhookHealth)   // before /:id so 'health' is not read as an id
router.get('/webhook-events/:id', validateUuidParam(), wh.getWebhookEvent)
// Webhooks round 12 (W2): a Replay re-runs the stored event, which can reverse a sale or clear a dispute — the same actions
// /payments/:ref/resolve and /refund put behind step-up — so it needs the same password confirmation.
router.post('/webhook-events/:id/replay', admin.stepUp, validateUuidParam(), wh.replayWebhookEvent)
router.post('/webhook-events/:id/dismiss', admin.stepUp, validateUuidParam(), wh.dismissWebhookEvent)
// Webhooks round 14: answer a dispute from Admin → Payments (accept = Paystack refunds the buyer), and a payment's own webhook history.
router.post('/payments/:reference/dispute/accept', admin.stepUp, wh.acceptPaymentDispute)
router.post('/payments/:reference/dispute/evidence', admin.stepUp, wh.submitDisputeEvidence)
// Webhooks round 15: contest it with a generated proof of delivery.
router.post('/payments/:reference/dispute/contest', admin.stepUp, wh.contestPaymentDispute)
router.get('/payments/:reference/webhook-events', wh.getPaymentTimeline)

// Customer stories: nothing reaches the public homepage until approved here.
router.get('/stories', stories.adminListStories)
router.post('/stories/:id/moderate', validateUuidParam(), stories.adminModerateStory)

// Homepage "Hot categories": nothing is published by hand. GET shows the real counts against the threshold; the POST is a
// read-only what-if (it computes a ranking from the real counts plus the numbers in the body and stores nothing).
router.get('/hot-categories', hotCategories.adminHotCategories)
router.post('/hot-categories/simulate', hotCategories.adminSimulateHotCategories)

router.get('/email-logs', c.adminListEmailLogs)
router.get('/alerts',     c.adminListAlerts)
// Addresses we no longer send non-security mail to (permanent bounce / spam complaint).
router.get('/email-suppressions',    c.adminCheckEmailSuppression)
router.delete('/email-suppressions', admin.stepUp, c.adminLiftEmailSuppression)

// Section 12 audit (feature gap): read path for admin_audit_log — see
// adminListAuditLog's own comment.
router.get('/audit-log',  c.adminListAuditLog)

// Database audit (0077): the Claude cost ledger, aggregated in the database.
router.get('/claude-usage', c.adminClaudeUsage)
router.get('/prompt-outcomes', c.adminPromptOutcomes)

module.exports = router
