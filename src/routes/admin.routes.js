const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const validateUuidParam = require('../middleware/validateUuidParam')
const c     = require('../controllers/admin.controller')
const wh    = require('../controllers/webhooks.controller')

const router = new Hono()

// Every route in this file is admin-only — applied once here rather than
// per-route, since there is no non-admin endpoint in this router at all.
router.use('*', admin)

router.get('/dashboard', c.adminDashboardStats)

router.get('/users',    c.adminListUsers)
router.get('/users/:id', validateUuidParam(), c.adminGetUserDetail)
router.patch('/users/:id', validateUuidParam(), c.adminUpdateUser)

router.get('/scans',    c.adminListScans)
router.patch('/scans/:id/verification', validateUuidParam(), c.adminSetVerification)
router.get('/payments', c.adminListPayments)

// Manual re-run of a paid fix that failed to generate (see adminRequeueFix).
router.post('/scans/:id/requeue-fix', validateUuidParam(), c.adminRequeueFix)

// Webhook inbox (Section 8): what Paystack sent, what we did with it, and a replay
// for anything that was HELD / FAILED / IGNORED.
router.get('/webhook-events', wh.listWebhookEvents)
router.post('/webhook-events/:id/replay', validateUuidParam(), wh.replayWebhookEvent)

router.get('/email-logs', c.adminListEmailLogs)
router.get('/alerts',     c.adminListAlerts)

module.exports = router
