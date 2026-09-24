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
    [`PATCH`, `/${ID}`], [`DELETE`, `/${ID}`],
  ]
  it('the public form needs no login', async () => {
    const a = app()
    expect(await call(a, 'POST', '', { name: 'x' })).toEqual({ status: 200, json: { handler: 'createLead' } })
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
    expect((await call(a, 'PATCH', '/bulk', {})).status).toBe(400)   // a malformed :id, not the bulk handler
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
})
