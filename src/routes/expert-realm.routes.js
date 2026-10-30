// Experts Phase 2A: the expert realm's routers. Mounted by index.js at /api/expert-realm (the expert's own side) and /api/expert-admin (the
// console). EVERY route is declared through define() with a stated policy (a matrix action, or public / pending / session); define() itself adds the
// session, limiter and matrix guards the policy needs (AUDIT A2 G2), so nothing is mounted without a permission rule and the permission tests can enumerate the whole surface. Flag off, wrong host, or no secret: the app's
// ordinary 404 on every path here. These routers read only the realm cookie; they never read an Authorization header.
const { Hono } = require('hono')
const mw = require('../middleware/expertRealm')
const { define } = require('../lib/expertRealm/permissions')
const auth = require('../controllers/expert-realm-auth.controller')
const realmCtl = require('../controllers/expert-realm.controller')
const adminCtl = require('../controllers/expert-admin.controller')

const { gate, csrf, requireElevated, limits } = mw

const realm = new Hono()
realm.use('*', gate(), csrf())
// public: no session yet
define(realm, 'realm', 'post', '/auth/login',           { auth: 'public' }, limits.loginIp, auth.login)
define(realm, 'realm', 'post', '/auth/password/forgot', { auth: 'public' }, limits.forgotIp, auth.forgot)
define(realm, 'realm', 'post', '/auth/password/reset',  { auth: 'public' }, limits.resetIp, auth.reset)
// pending: password checked, second factor still to do
define(realm, 'realm', 'post', '/auth/totp/setup',      { auth: 'pending' }, limits.secondFactor, auth.totpSetup)
define(realm, 'realm', 'post', '/auth/totp',            { auth: 'pending' }, limits.secondFactor, auth.totpVerify)
define(realm, 'realm', 'post', '/auth/recover',         { auth: 'pending' }, limits.secondFactor, auth.recover)
// session: fully signed in, any role, own account only
define(realm, 'realm', 'get',    '/me',                 { auth: 'session' }, auth.me)
define(realm, 'realm', 'post',   '/auth/logout',        { auth: 'session' }, auth.logout)
define(realm, 'realm', 'post',   '/auth/logout-all',    { auth: 'session' }, auth.logoutAll)
define(realm, 'realm', 'get',    '/sessions',           { auth: 'session' }, auth.listSessions)
define(realm, 'realm', 'delete', '/sessions/:id',       { auth: 'session' }, auth.endSession)
define(realm, 'realm', 'post',   '/auth/step-up',       { auth: 'session' }, limits.secondFactor, auth.stepUp)
define(realm, 'realm', 'post',   '/me/password',        { auth: 'session' }, limits.secondFactor, auth.changePassword)
define(realm, 'realm', 'post',   '/me/recovery-codes',  { auth: 'session' }, requireElevated(), auth.newRecoveryCodes)
// matrix actions: the expert's Desk and one assigned job
define(realm, 'realm', 'get', '/desk',            { action: 'job.view_full' }, realmCtl.desk)
define(realm, 'realm', 'get', '/jobs/:id/brief',  { action: 'job.view_full' }, realmCtl.jobBrief)

const admin = new Hono()
admin.use('*', gate(), csrf())
const act = (method, path, action, ...rest) => define(admin, 'admin', method, path, { action }, ...rest)
act('get',  '/board',              'board.view',     adminCtl.board)
act('get',  '/jobs/:id',           'board.view',     adminCtl.jobDetail)
act('post', '/jobs/:id/assign',    'job.assign',     adminCtl.assign)
act('post', '/jobs/:id/reassign',  'job.reassign',   adminCtl.reassign)
act('post', '/jobs/:id/refund',    'money.refund',   limits.money, adminCtl.refund)
act('get',  '/experts',            'directory.view', adminCtl.directory)
act('get',  '/audit',              'audit.view',     adminCtl.auditLog)

module.exports = { realm, admin }
