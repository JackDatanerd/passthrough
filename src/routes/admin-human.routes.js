const { Hono } = require('hono')
const admin = require('../middleware/adminOnly')
const validateUuidParam = require('../middleware/validateUuidParam')
const c = require('../controllers/admin-human.controller')
const { humanEnabled } = require('../lib/humanPilot')

// Mounted inside routes/admin.routes.js, so every route here is already behind the admin auth. While EXPERTS_ENABLED is off they are the ordinary 404.
const router = new Hono()
router.use('*', async (ctx, next) => (humanEnabled(ctx.env) ? next() : ctx.notFound()))

router.get('/summary',                  c.summary)
router.get('/orders',                   c.listOrders)
router.get('/orders/:id',               validateUuidParam(), c.getOrder)
router.get('/orders/:id/review',        validateUuidParam(), admin.stepUp, c.review)            // shows the customer's real resume: step-up, and logged
router.post('/orders/:id/assign',       validateUuidParam(), c.assign)
router.post('/orders/:id/unassign',     validateUuidParam(), c.unassign)
router.post('/orders/:id/return',       validateUuidParam(), c.returnToExpert)
router.post('/orders/:id/deliver',      validateUuidParam(), admin.stepUp, c.deliverOrder)
router.post('/orders/:id/record',       validateUuidParam(), admin.stepUp, c.record)
router.post('/orders/:id/accept',       validateUuidParam(), admin.stepUp, c.acceptForCustomer)       // writes the expert's pay row: money, so step-up
router.post('/orders/:id/late-credit',   validateUuidParam(), admin.stepUp, c.lateCredit)
router.post('/orders/:id/refund',       validateUuidParam(), admin.stepUp, c.refund)
router.get('/experts',                  c.listExperts)
router.post('/experts',                 admin.stepUp, c.createExpert)
router.patch('/experts/:id',            validateUuidParam(), admin.stepUp, c.patchExpert)
router.get('/experts/:id/ledger',       validateUuidParam(), c.expertLedger)
router.post('/experts/:id/adjustments', validateUuidParam(), admin.stepUp, c.addAdjustment)
router.post('/payouts',                 admin.stepUp, c.recordPayout)
router.post('/payouts/:id/void',        validateUuidParam(), admin.stepUp, c.voidPayout)

module.exports = router
