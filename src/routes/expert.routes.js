const { Hono } = require('hono')
const limits = require('../middleware/humanLimits')
const { expertAuth } = require('../middleware/expertAuth')
const a = require('../controllers/expert-auth.controller')
const c = require('../controllers/expert.controller')
const { humanEnabled } = require('../lib/humanPilot')

const router = new Hono()

// Same flag as the customer side: while EXPERTS_ENABLED is not exactly "true" every path under /api/expert is the app's ordinary 404.
router.use('*', async (ctx, next) => (humanEnabled(ctx.env) ? next() : ctx.notFound()))

router.post('/auth/login',        limits.expertLogin, a.login)
router.post('/auth/enroll/start', limits.expertLogin, expertAuth('pending'), a.enrollStart)
router.post('/auth/mfa',          limits.expertLogin, expertAuth('pending'), a.mfa)

router.use('*', expertAuth('full'), limits.expertAct)
router.get('/me',                       a.me)
router.post('/auth/logout',             a.logout)
router.get('/jobs',                     c.listJobs)
router.get('/jobs/:id',                 c.getJob)
router.put('/jobs/:id/document',        c.saveDocument)
router.post('/jobs/:id/questions',      c.askQuestion)
router.post('/jobs/:id/submit',         c.submitJob)

module.exports = router
