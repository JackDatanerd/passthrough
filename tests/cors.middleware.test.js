import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import corsMiddleware, { EXPOSED_HEADERS, PREFLIGHT_MAX_AGE_SECONDS, allowedOrigins } from '../src/middleware/cors.js'
import bodyLimit from '../src/middleware/bodyLimit.js'
import envCheck from '../src/middleware/envCheck.js'
import errorHandler from '../src/middleware/errorHandler.js'

// The site and the API are different origins in production, so every response header outside the
// CORS-safelisted set is hidden from the SPA unless it is exposed — losing Retry-After or
// X-Export-Parts from the list fails silently in production and nowhere else.
const GOOD = { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 'j'.repeat(40), FRONTEND_URL: 'https://passthrough.dev' }
const SITE = 'https://passthrough.dev'
// Same order as src/index.js: cors BEFORE the early-exit middleware.
function app() {
  const a = new Hono()
  a.use('*', corsMiddleware)
  a.use('/api/*', envCheck)
  a.use('/api/*', bodyLimit())
  a.post('/api/x', async c => c.json({ ok: true, body: await c.req.json() }))
  a.onError(errorHandler)
  return a
}
beforeEach(() => envCheck._reset())

describe('CORS middleware', () => {
  it.each(['X-Export-Parts', 'Retry-After', 'Content-Disposition'])('exposes %s to the browser', h => {
    expect(EXPOSED_HEADERS.map(x => x.toLowerCase())).toContain(h.toLowerCase())
  })

  it('answers the site with credentials and exposes the headers on a real response', async () => {
    const r = await app().request('/api/x', { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: '{}' }, GOOD)
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBe(SITE)
    expect(r.headers.get('access-control-allow-credentials')).toBe('true')
    expect(r.headers.get('access-control-expose-headers')).toMatch(/Retry-After/i)
  })

  it('caches the preflight (max-age) so credentialed calls do not re-preflight constantly', async () => {
    const r = await app().request('/api/x', { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } }, GOOD)
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-max-age')).toBe(String(PREFLIGHT_MAX_AGE_SECONDS))
  })

  it('does not allow an unlisted origin', async () => {
    const r = await app().request('/api/x', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }, GOOD)
    expect(r.headers.get('access-control-allow-origin')).toBeFalsy()
  })

  it('a trailing slash on FRONTEND_URL still matches; CORS_EXTRA_ORIGINS adds more', async () => {
    const env = { ...GOOD, FRONTEND_URL: 'https://passthrough.dev/', CORS_EXTRA_ORIGINS: 'https://www.passthrough.dev/, https://staging.passthrough.dev' }
    expect(allowedOrigins(env)).toEqual(['https://passthrough.dev', 'https://www.passthrough.dev', 'https://staging.passthrough.dev'])
    for (const origin of [SITE, 'https://www.passthrough.dev', 'https://staging.passthrough.dev']) {
      envCheck._reset()
      const r = await app().request('/api/x', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }, env)
      expect(r.headers.get('access-control-allow-origin')).toBe(origin)
    }
  })

  it('a missing FRONTEND_URL no longer crashes every request (no origin is allowed instead)', async () => {
    const env = { ...GOOD }; delete env.FRONTEND_URL
    const r = await app().request('/api/x', { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: '{}' }, env)
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBeFalsy()
  })

  it('the early 413 (body too large) carries CORS headers, so the SPA can read the message', async () => {
    const r = await app().request('/api/x', { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) }, body: 'x' }, GOOD)
    expect(r.status).toBe(413)
    expect(r.headers.get('access-control-allow-origin')).toBe(SITE)
  })

  it('the early 503 (broken config) carries CORS headers too', async () => {
    const r = await app().request('/api/x', { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: '{}' }, { FRONTEND_URL: SITE })
    expect(r.status).toBe(503)
    expect(r.headers.get('access-control-allow-origin')).toBe(SITE)
  })
})

describe('bodyLimit + errorHandler through a real Hono app', () => {
  it('malformed JSON on a JSON route is a 400 (the tag set by bodyLimit)', async () => {
    const r = await app().request('/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }, GOOD)
    expect(r.status).toBe(400)
    expect((await r.json()).message).toBe('Invalid request body.')
  })
  it('a spoofed multipart Content-Type cannot smuggle a large body past the cap', async () => {
    const big = JSON.stringify({ x: 'a'.repeat(3 * 1024 * 1024) })
    const r = await app().request('/api/x', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: big }, GOOD)
    expect(r.status).toBe(413)
  })
})

describe('envCheck.normalizeEnv', () => {
  it('strips trailing slashes from FRONTEND_URL in place', () => {
    const env = { FRONTEND_URL: 'https://passthrough.dev//' }
    envCheck.normalizeEnv(env)
    expect(env.FRONTEND_URL).toBe('https://passthrough.dev')
    envCheck.normalizeEnv({}); envCheck.normalizeEnv(undefined)   // never throws
  })
})
