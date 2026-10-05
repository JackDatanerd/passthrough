import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Route wiring for the endpoints that are only as safe as their middleware:
// the controller tests call handlers directly, so a route registered without
// its admin/auth guard, or in an order that lets a literal path be read as an
// :id, would pass all of them. Controllers are replaced by markers so this
// exercises ONLY the routing, the real adminOnly and the real UUID guard.

const ID = '11111111-1111-4111-8111-111111111111'
const marker = () => new Proxy({}, { get: (_, name) => async (c) => c.json({ handler: String(name) }) })
const passThrough = () => new Proxy({}, { get: () => async (c, next) => next() })

let restore, current
function mount(routeFile, controllerFile, extraStubs = {}) {
  const loaded = loadWithStubs(routeFile, {
    [controllerFile]: marker(),
    'middleware/rateLimiter.js': passThrough(),
    // Same contract as middleware/auth.js for this test: no user -> 401.
    'middleware/auth.js': async (c, next) => c.get('user') ? next() : c.json({ success: false }, 401),
    ...extraStubs,
  })
  restore = loaded.restore
  const app = new Hono()
  app.use('*', async (c, next) => { if (current) c.set('user', current); await next() })
  app.route('/r', loaded.mod)
  return app
}
const call = async (app, method, path, body) => {
  const res = await app.request(`/r${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && !['GET', 'HEAD'].includes(method) ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json().catch(() => null) }
}
afterEach(() => { restore?.(); current = undefined })

describe('employer-leads routes', () => {
  const app = () => mount('routes/employer-leads.routes.js', 'controllers/employer-leads.controller.js')
  const adminRoutes = [
    ['GET', ''], ['GET', '/export.csv'], ['POST', '/manual'], ['POST', '/bulk'],
    ['POST', '/suppressions/check'], ['DELETE', '/suppressions'],
    [`PATCH`, `/${ID}`], [`DELETE`, `/${ID}`], [`POST`, `/${ID}/request-confirmation`], [`POST`, `/${ID}/mark-confirmed`],
  ]
  it('the public form needs no login', async () => {
    const a = app()
    expect(await call(a, 'POST', '', { name: 'x' })).toEqual({ status: 200, json: { handler: 'createLead' } })
  })
  it('the confirm / remove links from the acknowledgement email need no login either', async () => {
    const a = app()
    expect(await call(a, 'POST', '/confirm', { token: 'x' })).toEqual({ status: 200, json: { handler: 'confirmLead' } })
    expect(await call(a, 'POST', '/remove', { token: 'x' })).toEqual({ status: 200, json: { handler: 'removeLead' } })
    // Fresh audit pass 2 (G4): the RFC 8058 one-click target mail providers POST to.
    expect(await call(a, 'POST', '/unsubscribe')).toEqual({ status: 200, json: { handler: 'unsubscribeLead' } })
    expect((await call(a, 'GET', '/unsubscribe')).status).toBe(404)   // POST-only: a scanner's GET removes nobody
  })
  it('every admin route rejects anonymous callers (401) and non-admins (403)', async () => {
    const a = app()
    for (const [m, p] of adminRoutes) {
      current = undefined
      expect((await call(a, m, p, {})).status, `${m} ${p} anonymous`).toBe(401)
      current = { id: 'u1', role: 'USER' }
      expect((await call(a, m, p, {})).status, `${m} ${p} user`).toBe(403)
    }
  })
  it('an admin reaches the right handler; "manual" and "bulk" are never read as ids', async () => {
    const a = app(); current = { id: 'a1', role: 'ADMIN' }
    expect((await call(a, 'POST', '/manual', {})).json.handler).toBe('adminCreateLead')
    expect((await call(a, 'POST', '/bulk', {})).json.handler).toBe('adminBulkUpdateLeads')
    expect((await call(a, 'GET', '/export.csv')).json.handler).toBe('adminExportLeads')
    expect((await call(a, 'PATCH', `/${ID}`, {})).json.handler).toBe('adminUpdateLeadStatus')
    expect((await call(a, 'POST', `/${ID}/request-confirmation`, {})).json.handler).toBe('adminRequestConfirmation')
    expect((await call(a, 'POST', `/${ID}/mark-confirmed`, {})).json.handler).toBe('adminMarkConfirmed')
    expect((await call(a, 'PATCH', '/bulk', {})).status).toBe(400)   // a malformed :id, not the bulk handler
    // FEATURE GAP CLOSED (fresh audit pass, Section 5): 'suppressions' must
    // never be read as an :id either, same reasoning as 'manual' and 'bulk'.
    expect((await call(a, 'POST', '/suppressions/check', {})).json.handler).toBe('adminCheckSuppression')
    expect((await call(a, 'DELETE', '/suppressions', {})).json.handler).toBe('adminLiftSuppression')
  })
  // BUG FIX (fresh audit pass, Section 5): confirm/remove used to share the
  // exact `employerLead` bucket with the public form (POST /). Stubs each
  // rate-limiter export with a distinguishable marker (rather than the
  // blanket passThrough every other test here uses) so this can tell WHICH
  // limiter a route actually goes through, not just that some limiter ran.
  it('confirm/remove use their own rate limiter, not the public form\'s', async () => {
    const hit = []
    const taggedLimiter = (name) => async (c, next) => { hit.push(name); return next() }
    const a = mount('routes/employer-leads.routes.js', 'controllers/employer-leads.controller.js', {
      'middleware/rateLimiter.js': { employerLead: taggedLimiter('employerLead'), employerLeadLink: taggedLimiter('employerLeadLink') },
    })
    await call(a, 'POST', '', { name: 'x' })
    await call(a, 'POST', '/confirm', { token: 'x' })
    await call(a, 'POST', '/remove', { token: 'x' })
    await call(a, 'POST', '/unsubscribe')
    expect(hit).toEqual(['employerLead', 'employerLeadLink', 'employerLeadLink', 'employerLeadLink'])
  })
})

// Payments & Pricing pass 1 (G1, G4, B2): the new refund/receipt endpoints,
// and the verify endpoint's new rate limiter, are only as safe as their
// wiring — a route registered without auth/admin, or through the wrong (or
// no) limiter, would pass every controller-level test while being reachable
// by the wrong caller in production. Mirrors this file's own template.
describe('payments routes — refund, receipt, verify', () => {
  const REF = 'PSK-ref-1'
  const app = (extraStubs) => mount('routes/payments.routes.js', 'controllers/payments.controller.js', extraStubs)

  it('refund is admin-only: 401 anonymous, 403 for a signed-in non-admin', async () => {
    const a = app()
    current = undefined
    expect((await call(a, 'POST', `/${REF}/refund`, {})).status).toBe(401)
    current = { id: 'u1', role: 'USER' }
    expect((await call(a, 'POST', `/${REF}/refund`, {})).status).toBe(403)
  })
  it('an admin reaches refundPayment', async () => {
    const a = app(); current = { id: 'a1', role: 'ADMIN' }
    expect((await call(a, 'POST', `/${REF}/refund`, {})).json.handler).toBe('refundPayment')
  })
  it('receipt requires login (any signed-in owner, not admin-gated) and reaches resendPaymentReceipt', async () => {
    const a = app()
    current = undefined
    expect((await call(a, 'POST', `/${REF}/receipt`, {})).status).toBe(401)
    current = { id: 'u1', role: 'USER' }
    expect((await call(a, 'POST', `/${REF}/receipt`, {})).json.handler).toBe('resendPaymentReceipt')
  })
  it('receipt goes through its OWN limiter (rl.paymentReceipt), not refund\'s or verify\'s', async () => {
    const hit = []
    const taggedLimiter = name => async (c, next) => { hit.push(name); return next() }
    const a = app({ 'middleware/rateLimiter.js': {
      paymentReceipt: taggedLimiter('paymentReceipt'), paymentVerify: taggedLimiter('paymentVerify'),
      payment: taggedLimiter('payment'), paymentCancel: taggedLimiter('paymentCancel'),
    } })
    current = { id: 'u1', role: 'USER' }
    await call(a, 'POST', `/${REF}/receipt`, {})
    expect(hit).toEqual(['paymentReceipt'])
  })
  it('B2: verify now goes through rl.paymentVerify, not the app-wide limiter alone', async () => {
    const hit = []
    const taggedLimiter = name => async (c, next) => { hit.push(name); return next() }
    const a = app({ 'middleware/rateLimiter.js': {
      paymentVerify: taggedLimiter('paymentVerify'), paymentReceipt: taggedLimiter('paymentReceipt'),
      payment: taggedLimiter('payment'), paymentCancel: taggedLimiter('paymentCancel'),
    } })
    current = { id: 'u1', role: 'USER' }
    await call(a, 'GET', '/verify', undefined)
    expect(hit).toEqual(['paymentVerify'])
  })
  it('initialize and cancel still use their own distinct limiters (payment / paymentCancel), unaffected by the new ones', async () => {
    const hit = []
    const taggedLimiter = name => async (c, next) => { hit.push(name); return next() }
    const a = app({ 'middleware/rateLimiter.js': {
      payment: taggedLimiter('payment'), paymentCancel: taggedLimiter('paymentCancel'),
      paymentVerify: taggedLimiter('paymentVerify'), paymentReceipt: taggedLimiter('paymentReceipt'),
    } })
    current = { id: 'u1', role: 'USER' }
    await call(a, 'POST', '/initialize', {})
    await call(a, 'POST', `/${REF}/cancel`, {})
    expect(hit).toEqual(['payment', 'paymentCancel'])
  })
  it('refund and receipt both require login before their guard/limiter runs at all', async () => {
    const a = app()
    current = undefined
    expect((await call(a, 'POST', `/${REF}/receipt`, {})).status).toBe(401)
  })
})

describe('scan routes — DELETE /:id', () => {
  const app = () => mount('routes/scan.routes.js', 'controllers/scan.controller.js')
  it('requires a login, rejects a malformed id, and reaches deleteScan for an owner', async () => {
    const a = app()
    expect((await call(a, 'DELETE', `/${ID}`)).status).toBe(401)
    current = { id: 'u1' }
    expect((await call(a, 'DELETE', '/not-a-uuid')).status).toBe(400)
    expect(await call(a, 'DELETE', `/${ID}`)).toEqual({ status: 200, json: { handler: 'deleteScan' } })
  })
})

describe('profile routes — GET /export', () => {
  const app = () => mount('routes/profile.routes.js', 'controllers/profile.controller.js')
  it('requires a login and reaches exportMyData', async () => {
    const a = app()
    expect((await call(a, 'GET', '/export')).status).toBe(401)
    current = { id: 'u1' }
    expect(await call(a, 'GET', '/export')).toEqual({ status: 200, json: { handler: 'exportMyData' } })
    expect((await call(a, 'GET', '')).json.handler).toBe('getProfile')
  })
  it('every profile route needs a login, and each reaches its own handler', async () => {
    const a = app()
    const routes = [
      ['GET', '', 'getProfile'], ['GET', '/data', 'getProfileData'], ['PUT', '', 'updateProfile'],
      ['PATCH', '/preferences', 'updatePreferences'], ['POST', '/save', 'saveProfile'],
      ['DELETE', '', 'deleteProfile'], ['DELETE', '/scans', 'deleteScanHistory'], ['GET', '/export', 'exportMyData'],
    ]
    for (const [m, p, handler] of routes) {
      current = undefined
      expect((await call(a, m, p, {})).status, `${m} ${p} anonymous`).toBe(401)
      current = { id: 'u1' }
      expect((await call(a, m, p, {})).json, `${m} ${p}`).toEqual({ handler })
    }
  })
  it('DELETE /scans (the whole history) is not shadowed by, and does not shadow, DELETE / (the saved profile)', async () => {
    const a = app(); current = { id: 'u1' }
    expect((await call(a, 'DELETE', '')).json.handler).toBe('deleteProfile')
    expect((await call(a, 'DELETE', '/scans')).json.handler).toBe('deleteScanHistory')
  })
})

describe('admin routes — webhook inbox', () => {
  const app = () => mount('routes/admin.routes.js', 'controllers/admin.controller.js', {
    'controllers/webhooks.controller.js': marker(),
  })
  it('is admin-only: 401 anonymous, 403 for a non-admin, for the list AND the replay', async () => {
    const a = app()
    for (const [m, p] of [['GET', '/webhook-events'], ['GET', `/webhook-events/${ID}`], ['POST', `/webhook-events/${ID}/replay`]]) {
      current = undefined
      expect((await call(a, m, p, {})).status, `${m} ${p} anonymous`).toBe(401)
      current = { id: 'u1', role: 'USER' }
      expect((await call(a, m, p, {})).status, `${m} ${p} user`).toBe(403)
    }
  })
  it('an admin reaches the right handlers, and a malformed id never reaches replay', async () => {
    const a = app(); current = { id: 'a1', role: 'ADMIN' }
    expect((await call(a, 'GET', '/webhook-events')).json.handler).toBe('listWebhookEvents')
    expect((await call(a, 'GET', `/webhook-events/${ID}`)).json.handler).toBe('getWebhookEvent')
    expect((await call(a, 'GET', '/webhook-events/not-a-uuid')).status).toBe(400)
    expect((await call(a, 'POST', `/webhook-events/${ID}/replay`, {})).json.handler).toBe('replayWebhookEvent')
    expect((await call(a, 'POST', '/webhook-events/not-a-uuid/replay', {})).status).toBe(400)
  })
})

// Section 12 audit (feature gap): GET /admin/audit-log is the read path for
// admin_audit_log — a list of who did what to whose data, so it is exactly as
// sensitive as the actions it records and must never be reachable without
// the admin guard.
describe('admin routes — audit log', () => {
  const app = () => mount('routes/admin.routes.js', 'controllers/admin.controller.js', {
    'controllers/webhooks.controller.js': marker(),
  })
  it('is admin-only: 401 anonymous, 403 for a non-admin', async () => {
    const a = app()
    current = undefined
    expect((await call(a, 'GET', '/audit-log')).status).toBe(401)
    current = { id: 'u1', role: 'USER' }
    expect((await call(a, 'GET', '/audit-log')).status).toBe(403)
  })
  it('an admin reaches adminListAuditLog', async () => {
    const a = app(); current = { id: 'a1', role: 'ADMIN' }
    expect(await call(a, 'GET', '/audit-log')).toEqual({ status: 200, json: { handler: 'adminListAuditLog' } })
  })
})


describe('auth routes — session endpoints and public/authenticated split', () => {
  const app = () => mount('routes/auth.routes.js', 'controllers/auth.controller.js')

  it('/me, /sessions (GET/DELETE), /sessions/revoke-others, /logout, /accept-terms, /name all require a login', async () => {
    const a = app()
    for (const [method, path] of [
      ['GET',    '/me'],
      ['GET',    '/sessions'],
      ['DELETE', `/sessions/${ID}`],
      ['POST',   '/sessions/revoke-others'],
      ['POST',   '/logout'],
      ['POST',   '/accept-terms'],
      ['PATCH',  '/name'],
    ]) expect((await call(a, method, path)).status, `${method} ${path}`).toBe(401)
  })
  it('reaches each handler once authenticated', async () => {
    const a = app()
    current = { id: 'u1' }
    expect((await call(a, 'GET', '/me')).json.handler).toBe('getMe')
    expect((await call(a, 'GET', '/sessions')).json.handler).toBe('listSessions')
    expect((await call(a, 'DELETE', `/sessions/${ID}`)).json.handler).toBe('revokeSession')
    expect((await call(a, 'POST', '/sessions/revoke-others')).json.handler).toBe('signOutOtherSessions')
    expect((await call(a, 'POST', '/logout')).json.handler).toBe('logout')
  })
  it('register, login, forgot-password, reset-password, email/confirm are public (no login required)', async () => {
    const a = app()
    for (const [method, path] of [
      ['POST', '/register'], ['POST', '/login'], ['POST', '/forgot-password'],
      ['POST', '/reset-password'], ['GET', '/reset-password/validate'],
      ['GET', '/verify-email'], ['POST', '/email/confirm'],
    ]) expect((await call(a, method, path)).json.handler, `${method} ${path}`).toBeDefined()
  })
  it('/password, /email and /account require BOTH login and the current password check reaching the handler', async () => {
    const a = app()
    expect((await call(a, 'PATCH', '/password')).status).toBe(401)
    expect((await call(a, 'PATCH', '/email')).status).toBe(401)
    expect((await call(a, 'DELETE', '/account')).status).toBe(401)
    current = { id: 'u1' }
    expect((await call(a, 'PATCH', '/password')).json.handler).toBe('changePassword')
    expect((await call(a, 'PATCH', '/email')).json.handler).toBe('updateEmail')
    expect((await call(a, 'DELETE', '/account')).json.handler).toBe('deleteAccount')
  })
})
