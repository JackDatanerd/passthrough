import { describe, it, expect } from 'vitest'
const bodyLimit = require('../src/middleware/bodyLimit')
const errorHandler = require('../src/middleware/errorHandler')
const upload = require('../src/middleware/upload')

const fakeCtx = () => ({ env: {}, req: { header: () => undefined }, json: (b, s) => ({ b, s }) })

describe('cross-cutting round 13: lone surrogates at the door', () => {
  it('stripNul drops a lone high surrogate in a value and keeps a real pair', () => {
    const out = bodyLimit.stripNul(JSON.parse('{"a":"hi \\ud83d","b":"ok \\ud83d\\ude80","c":["x\\udc00"]}'))
    expect(out.a).toBe('hi ')
    expect(out.b).toBe('ok 🚀')
    expect(out.c[0]).toBe('x')
  })
  it('stripNul cleans keys too, and still defines __proto__ as an own property', () => {
    const out = bodyLimit.stripNul(JSON.parse('{"k\\ud83d":1,"__pro\\u0000to__":{"x":1}}'))
    expect(Object.keys(out)).toContain('k')
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
  it('cleanFilename never leaves half an emoji at the 255 cut', () => {
    const name = 'a'.repeat(254) + '🚀.pdf'
    const out = upload.cleanFilename(name)
    expect(out.length).toBeLessThanOrEqual(255)
    expect(/[\ud800-\udbff]$/.test(out)).toBe(false)
    expect(upload.cleanFilename('x\ud83d.pdf')).toBe('x.pdf')
  })
  it('errorHandler answers a Postgres JSON-text 22P02 as a 400, but any other 22P02 stays a 500', () => {
    const e1 = Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' })
    expect(errorHandler(e1, fakeCtx()).s).toBe(400)
    const e2 = Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: '22P02' })
    expect(errorHandler(e2, fakeCtx()).s).toBe(500)
  })
})

// ── the `general` exemptions must follow real routes ─────────────────────────────────────────────────────────────
describe('cross-cutting round 13: general-limiter exemptions are route-faithful', () => {
  const rl = require('../src/middleware/rateLimiter')
  const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } } }
  const ctx = (method, path, env) => ({
    env, req: { method, path, header: h => (h === 'cf-connecting-ip' ? '198.51.100.7' : undefined), query: () => undefined },
    get: () => undefined, set: () => {}, json: (b, s) => ({ status: s }),
  })
  const run = async (method, path, n = 130) => {
    const env = { RATE_LIMIT_KV: kv(), NODE_ENV: 'production' }
    let last
    for (let i = 0; i < n; i++) { let passed = false; const r = await rl.general(ctx(method, path, env), async () => { passed = true }); last = passed ? 200 : r.status }
    return last
  }
  it.each([
    ['POST', '/api/webhooks/paystack'], ['POST', '/api/webhooks/resend/'],
    ['GET', '/api/verify/AB3XY7'], ['GET', '/api/verify/AB3XY7/badge.png'], ['GET', '/api/verify/by-hash/abc'], ['POST', '/api/verify/AB3XY7/report'],
  ])('%s %s keeps its own limiter and skips the generic bucket', async (m, p) => { expect(await run(m, p)).toBe(200) })
  it.each([
    ['GET', '/api/verify/a/b/c'], ['GET', '/api/verify/AB3XY7/nope'], ['GET', '/api/verifyzzz'], ['POST', '/api/verify/AB3XY7'],
    ['POST', '/api/webhooks/zzz'], ['GET', '/api/webhooks/paystack'], ['GET', '/api/scan/abc/'], ['DELETE', '/api/profile/scans/'],
    ['POST', '/api/outcomes/unsubscribe/'],
  ])('%s %s (no route there: a 404) is counted by the generic bucket', async (m, p) => { expect(await run(m, p)).toBe(429) })
})
