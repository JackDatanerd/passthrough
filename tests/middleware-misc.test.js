import { describe, it, expect } from 'vitest'
import adminOnly from '../src/middleware/adminOnly.js'
import validateUuidParam, { UUID_RE } from '../src/middleware/validateUuidParam.js'

// Both had zero direct test coverage. adminOnly.js gates every admin route
// in the app (admin.routes.js, partners.routes.js, employer-leads.routes.js
// all mount it); validateUuidParam.js is the fix for an uncaught 500 on a
// malformed :id and — per this audit — was missing from 9 real routes
// across those same three files (now fixed alongside this test).

function fakeCtx({ user, authError } = {}) {
  const store = { user, authError }
  return { get: k => store[k], json: (body, status) => ({ body, status }) }
}

describe('adminOnly', () => {
  it('401s when no user is set (no token / optionalAuth found nothing)', async () => {
    const c = fakeCtx({})
    let nextCalled = false
    const res = await adminOnly(c, async () => { nextCalled = true })
    expect(res.status).toBe(401)
    expect(nextCalled).toBe(false)
  })

  it('403s when the user exists but is not an ADMIN', async () => {
    const c = fakeCtx({ user: { id: 'u1', role: 'USER' } })
    let nextCalled = false
    const res = await adminOnly(c, async () => { nextCalled = true })
    expect(res.status).toBe(403)
    expect(nextCalled).toBe(false)
  })

  it('calls next() for an ADMIN user, with no response of its own', async () => {
    const c = fakeCtx({ user: { id: 'u1', role: 'ADMIN' } })
    let nextCalled = false
    const res = await adminOnly(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
    expect(res).toBeUndefined()
  })

  // AUDIT FIX (bug): plain 401 used to be the answer whenever there was no
  // user, full stop — including when the REASON was a database hiccup during
  // optionalAuth's own lookup (see optionalAuth.middleware.test.js's
  // authError describe). The admin SPA treats a 401 on a request that carried
  // a token as a dead session and signs the admin out — so an infra blip was
  // logging admins out. c.get('authError') (set by optionalAuth) lets this
  // middleware tell "your session is bad" apart from "we couldn't check".
  it('503s (never 401) when the reason there is no user is OUR OWN lookup failing', async () => {
    const c = fakeCtx({ authError: 'unavailable' })
    let nextCalled = false
    const res = await adminOnly(c, async () => { nextCalled = true })
    expect(res.status).toBe(503)
    expect(nextCalled).toBe(false)
  })
  it('401s with a machine-readable code for an expired token, so the SPA can prompt a fresh login', async () => {
    const c = fakeCtx({ authError: 'expired' })
    const res = await adminOnly(c, async () => {})
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('TOKEN_EXPIRED')
  })
  it('plain 401 for every other reason (no token, invalid, inactive)', async () => {
    for (const authError of [undefined, 'invalid', 'inactive']) {
      const res = await adminOnly(fakeCtx({ authError }), async () => {})
      expect(res.status).toBe(401)
    }
  })
})

describe('validateUuidParam', () => {
  function fakeParamCtx(paramValue) {
    return { req: { param: () => paramValue }, json: (body, status) => ({ body, status }) }
  }

  it('400s on a missing param', async () => {
    let nextCalled = false
    const res = await validateUuidParam()(fakeParamCtx(undefined), async () => { nextCalled = true })
    expect(res.status).toBe(400)
    expect(nextCalled).toBe(false)
  })

  it('400s on a non-UUID string', async () => {
    let nextCalled = false
    const res = await validateUuidParam()(fakeParamCtx('not-a-uuid'), async () => { nextCalled = true })
    expect(res.status).toBe(400)
    expect(nextCalled).toBe(false)
  })

  it('400s on a UUID-shaped-but-truncated value (the original motivating bug)', async () => {
    const res = await validateUuidParam()(fakeParamCtx('123e4567-e89b-12d3-a456'), async () => {})
    expect(res.status).toBe(400)
  })

  it('400s on SQL-injection-style / non-hex garbage in a UUID-length string', async () => {
    const res = await validateUuidParam()(fakeParamCtx("'; DROP TABLE users;--"), async () => {})
    expect(res.status).toBe(400)
  })

  it('calls next() on a well-formed (any case) UUID, with no response of its own', async () => {
    let nextCalled = false
    const res = await validateUuidParam()(fakeParamCtx('123E4567-E89B-12D3-A456-426614174000'), async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
    expect(res).toBeUndefined()
  })

  it('reads the configured param name, not always "id"', async () => {
    let seenValue
    const c = { req: { param: name => { seenValue = name; return '123e4567-e89b-12d3-a456-426614174000' } }, json: () => {} }
    await validateUuidParam('codeId')(c, async () => {})
    expect(seenValue).toBe('codeId')
  })

  it('exports UUID_RE for reuse (profile.controller.js relies on this for its own inline scanId check)', () => {
    expect(UUID_RE.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(UUID_RE.test('not-a-uuid')).toBe(false)
  })
})
