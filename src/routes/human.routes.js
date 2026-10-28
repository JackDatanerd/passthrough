const { Hono } = require('hono')
const auth   = require('../middleware/auth')
const limits = require('../middleware/humanLimits')
const c      = require('../controllers/human.controller')
const f      = require('../controllers/human-files.controller')
const { humanEnabled } = require('../lib/humanPilot')

const router = new Hono()

// The flag gate runs FIRST: while EXPERTS_ENABLED is not exactly "true" every path under /api/human answers the app's ordinary 404.
router.use('*', async (ctx, next) => (humanEnabled(ctx.env) ? next() : ctx.notFound()))
router.use('*', auth)

router.get('/config',                       limits.act,    c.getConfig)
router.post('/orders',                      limits.order,  c.createOrder)
router.get('/orders',                       limits.act,    c.listOrders)
router.get('/orders/:id',                   limits.act,    c.getOrder)
router.post('/orders/:id/materials',        limits.upload, f.addMaterial)
router.post('/orders/:id/links',            limits.act,    f.addLink)
router.delete('/orders/:id/materials/:mid', limits.act,    f.removeMaterial)
router.post('/orders/:id/questions/:qid',   limits.act,    c.answerQuestion)
router.post('/orders/:id/accept',           limits.act,    c.acceptOrder)
router.post('/orders/:id/revision',         limits.act,    c.requestRevision)
router.post('/orders/:id/rate',             limits.act,    c.rateOrder)
router.post('/orders/:id/cancel',           limits.act,    c.cancelOrder)
router.get('/orders/:id/files/:kind',       limits.act,    f.downloadFile)

module.exports = router
