import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import bodyLimit from '../src/middleware/bodyLimit.js'
import securityHeaders from '../src/middleware/securityHeaders.js'
import envCheck from '../src/middleware/envCheck.js'
import { validateEnv } from '../src/lib/env.js'

const ctxFor = req => ({ req: { method: req.method, header: n => req.headers.get(n), raw: req }, json: (b, s, h) => ({ b, s, h }) })
const streamOf = (total, chunk = 64 * 1024) => { let sent = 0; return new ReadableStream({ pull(c) { if (sent >= total) return c.close(); const n = Math.min(chunk, total - sent); sent += n; c.enqueue(new Uint8Array(n).fill(0x20)) } }) }

describe('bodyLimit', () => {
  it('lets small JSON through untouched', async () => {
    const req = new Request('https://x/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) })
    const c = ctxFor(req); let passed = false
    await bodyLimit(1024)(c, async () => { passed = true })
    expect(passed).toBe(true)
    expect(await c.req.raw.json()).toEqual({ a: 1 })
  })
  it('rejects a body that DECLARES more than the cap (413) without reading it', async () => {
    const req = new Request('https://x', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '999999999' }, body: '{}' })
    let passed = false
    const res = await bodyLimit(1024)(ctxFor(req), async () => { passed = true })
    expect(res.s).toBe(413); expect(passed).toBe(false)
  })
  it('CHUNKED body with no Content-Length: reading it fails with a 413 the moment the cap is crossed', async () => {
    const req = new Request('https://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: streamOf(10 * 1024 * 1024), duplex: 'half' })
    expect(req.headers.get('content-length')).toBeNull()
    const c = ctxFor(req)
    await bodyLimit(1024 * 1024)(c, async () => {})
    let err; try { await c.req.raw.json() } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err.status).toBe(413)
    expect(err.expose).toBe(true)
  })
  it('a chunked body UNDER the cap still parses', async () => {
    const enc = new TextEncoder().encode(JSON.stringify({ ok: true }))
    const req = new Request('https://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new ReadableStream({ start(c) { c.enqueue(enc); c.close() } }), duplex: 'half' })
    const c = ctxFor(req)
    await bodyLimit(1024)(c, async () => {})
    expect(await c.req.raw.json()).toEqual({ ok: true })
  })
  it('does not touch multipart uploads (upload.js owns those) or GETs', async () => {
    const mp = new Request('https://x', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': '999999999' }, body: 'x' })
    let passed = false
    await bodyLimit(1024)(ctxFor(mp), async () => { passed = true })
    expect(passed).toBe(true)
    passed = false
    await bodyLimit(1024)(ctxFor(new Request('https://x', { method: 'GET' })), async () => { passed = true })
    expect(passed).toBe(true)
  })
})

describe('securityHeaders', () => {
  const honoish = () => ({
    res: null,
    header(k, v) { const h = new Headers(this.res.headers); h.set(k, v); this.res = new Response(this.res.body, { status: this.res.status, headers: h }) },
  })
  it('adds the baseline headers to any response, including error/429 ones', async () => {
    for (const status of [200, 404, 429, 500]) {
      const c = honoish()
      await securityHeaders(c, async () => { c.res = new Response('{}', { status }) })
      expect(c.res.status).toBe(status)
      expect(c.res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(c.res.headers.get('Strict-Transport-Security')).toContain('max-age=')
      expect(c.res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
      expect(c.res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(c.res.headers.get('Cache-Control')).toBe('no-store')
    }
  })
  it('keeps a Cache-Control the handler chose', async () => {
    const c = honoish()
    await securityHeaders(c, async () => { c.res = new Response('x', { headers: { 'Cache-Control': 'public, max-age=60' } }) })
    expect(c.res.headers.get('Cache-Control')).toBe('public, max-age=60')
  })
  it('preserves the response body', async () => {
    const c = honoish()
    await securityHeaders(c, async () => { c.res = new Response('hello') })
    expect(await c.res.text()).toBe('hello')
  })
})

describe('validateEnv', () => {
  const good = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 'a'.repeat(48), RESEND_API_KEY: 'r', PAYSTACK_SECRET_KEY: 'p', ANTHROPIC_API_KEY: 'a', EMAIL_FROM: 'x <x@y.z>', FRONTEND_URL: 'https://passthrough.dev', RATE_LIMIT_KV: {}, RESUMES_BUCKET: {}, FIX_QUEUE: {}, NODE_ENV: 'production' }
  it('a complete environment has no fatal problems and no warnings', () => {
    expect(validateEnv(good)).toEqual({ fatal: [], warnings: [] })
  })
  it('a missing JWT_SECRET / Supabase credential is FATAL', () => {
    for (const k of ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
      const env = { ...good }; delete env[k]
      expect(validateEnv(env).fatal.join(' ')).toContain(k)
    }
  })
  it('a SHORT or placeholder JWT_SECRET only WARNS — an existing working deployment is never taken down by a stricter check', () => {
    const short = validateEnv({ ...good, JWT_SECRET: 'short-secret' })
    expect(short.fatal).toEqual([]); expect(short.warnings.join(' ')).toContain('shorter than 32')
    expect(validateEnv({ ...good, JWT_SECRET: 'replace_with_minimum_32_char_random_string' }).warnings.join(' ')).toContain('placeholder')
  })
  it('flags a FRONTEND_URL trailing slash and a missing scheme', () => {
    expect(validateEnv({ ...good, FRONTEND_URL: 'https://passthrough.dev/' }).warnings.join(' ')).toContain('trailing slash')
    expect(validateEnv({ ...good, FRONTEND_URL: 'passthrough.dev' }).warnings.join(' ')).toContain('http')
  })
  it('flags missing feature secrets and bindings without failing', () => {
    const env = { ...good }; delete env.RESEND_API_KEY; delete env.FIX_QUEUE
    const r = validateEnv(env)
    expect(r.fatal).toEqual([])
    expect(r.warnings.join(' ')).toContain('RESEND_API_KEY'); expect(r.warnings.join(' ')).toContain('FIX_QUEUE')
  })
  it('warns loudly if the rate-limit bypass is left on in production', () => {
    expect(validateEnv({ ...good, RATE_LIMIT_BYPASS_IPS: '1.2.3.4' }).warnings.join(' ')).toContain('RATE_LIMIT_BYPASS_IPS')
    expect(validateEnv({ ...good, RATE_LIMIT_BYPASS_IPS: '1.2.3.4', NODE_ENV: 'development' }).warnings.join(' ')).not.toContain('RATE_LIMIT_BYPASS_IPS')
  })
  it('flags a promo that is switched on but already expired / unparseable', () => {
    expect(validateEnv({ ...good, PROMO_ACTIVE: 'true', PROMO_ENDS_AT: '2020-01-01T00:00:00Z' }).warnings.join(' ')).toContain('has passed')
    expect(validateEnv({ ...good, PROMO_ACTIVE: 'true', PROMO_ENDS_AT: 'soon' }).warnings.join(' ')).toContain('unparseable')
    expect(validateEnv({ ...good, PROMO_ACTIVE: 'false', PROMO_ENDS_AT: '2020-01-01T00:00:00Z' }).warnings).toEqual([])
  })
})

describe('envCheck middleware', () => {
  let realErr; beforeEach(() => { realErr = console.error; console.error = () => {}; envCheck._reset() })
  afterEach(() => { console.error = realErr; envCheck._reset() })
  it('passes requests through when configuration is usable', async () => {
    let passed = false
    await envCheck({ env: { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 's' }, json: (b, s) => ({ b, s }) }, async () => { passed = true })
    expect(passed).toBe(true)
  })
  it('answers 503 (with Retry-After) instead of failing confusingly when a critical setting is missing', async () => {
    let passed = false
    const res = await envCheck({ env: { SUPABASE_URL: 'u' }, json: (b, s, h) => ({ b, s, h }) }, async () => { passed = true })
    expect(passed).toBe(false); expect(res.s).toBe(503); expect(res.h['Retry-After']).toBe('60')
    expect(JSON.stringify(res.b)).not.toContain('JWT_SECRET')     // never leak which setting is missing to the public
  })
  it('exposes a status for the health endpoint', () => {
    expect(envCheck.status({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 's' }).configured).toBe(true)
    envCheck._reset()
    expect(envCheck.status({}).configured).toBe(false)
  })
})
