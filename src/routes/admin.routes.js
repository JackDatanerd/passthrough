const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const c     = require('../controllers/admin.controller')

const router = new Hono()

// Every route in this file is admin-only — applied once here rather than
// per-route, since there is no non-admin endpoint in this router at all.
router.use('*', admin)

router.get('/dashboard', c.adminDashboardStats)

router.get('/users',    c.adminListUsers)
router.get('/users/:id', c.adminGetUserDetail)
router.patch('/users/:id', c.adminUpdateUser)

router.get('/scans',    c.adminListScans)
router.get('/payments', c.adminListPayments)

router.get('/email-logs', c.adminListEmailLogs)
router.get('/alerts',     c.adminListAlerts)

module.exports = router
