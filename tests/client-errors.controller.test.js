import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSIsInNpZCI6InMxIn0.abcDEF123_-xyz'

let t
function setup({ quota = () => true } = {}) {
  const alerts = []
  const quotaCalls = []
  const { mod, restore } = loadWithStubs('controllers/client-errors.controller.js', {
    'middleware/rateLimiter.js': { hitQuota: async (env, key, max, win) => { quotaCalls.push({ key, max, win }); return quota(key, quotaCalls.length) } },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message, opts) => { alerts.push({ subject, message, opts }); return true } },
  })
  return { mod, restore, alerts, quotaCalls }
}
const ctx = (body, { env = { RATE_LIMIT_KV: {} }, headers = {}, rawJson } = {}) => ({
  env,
  req: {
    header: h => headers[h.toLowerCase()],
    json: async () => { if (rawJson instanceof Error) throw rawJson; return body },
  },
  json: (b, status = 200) => ({ body: b, status }),
})
const good = { kind: 'render', message: "Cannot read properties of undefined (reading 'map')", stack: 'Error\n at X (assets/index-abc.js:1:2)', path: '/scan/11111111-1111-4111-8111-111111111111', build: 'assets/index-abc.js' }

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { t?.restore(); t = null; vi.restoreAllMocks() })

describe('POST /api/client-errors', () => {
  it('mails one alert for a new error, scrubbed and keyed by its fingerprint', async () => {
    t = setup()
    const res = await t.mod.reportClientError(ctx({ ...good, message: `fetch failed for jane@example.com ${JWT}` }))
    expect(res).toEqual({ body: { success: true }, status: 200 })
    await new Promise(r => setImmediate(r))
    expect(t.alerts).toHaveLength(1)
    const a = t.alerts[0]
    expect(a.subject).toBe('Frontend error: render on /scan/:id')
    expect(a.message).not.toMatch(/jane@|eyJ/)
    expect(a.message).toMatch(/unverified/i)
    expect(a.opts.dedupeKey).toMatch(/^clienterr:[0-9a-f]{32}$/)
  })

  it('stays quiet for an error already reported today (and still answers 200)', async () => {
    t = setup({ quota: key => !key.startsWith('rl:clienterr:') || key === 'rl:clienterr:all' ? true : false })
    const res = await t.mod.reportClientError(ctx(good))
    expect(res.status).toBe(200)
    expect(t.alerts).toHaveLength(0)
    expect(t.quotaCalls[0]).toMatchObject({ max: 1, win: 86400 })
  })

  it('stops at the hourly ceiling however many DIFFERENT errors arrive', async () => {
    t = setup({ quota: key => key !== 'rl:clienterr:all' })
    const res = await t.mod.reportClientError(ctx(good))
    expect(res.status).toBe(200)
    expect(t.alerts).toHaveLength(0)
    const all = t.quotaCalls.find(c => c.key === 'rl:clienterr:all')
    expect(all).toMatchObject({ max: t.mod.GLOBAL_ALERTS_PER_HOUR, win: 3600 })
  })

  it('without a quota backend nothing is mailed (the de-dupe cannot be trusted), but the log line is still written', async () => {
    t = setup()
    const res = await t.mod.reportClientError(ctx(good, { env: {} }))
    expect(res.status).toBe(200)
    expect(t.alerts).toHaveLength(0)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[client-error] render /scan/:id'))
  })

  it('refuses a malformed, empty or oversized report', async () => {
    t = setup()
    expect((await t.mod.reportClientError(ctx(null, { rawJson: new SyntaxError('bad') }))).status).toBe(400)
    expect((await t.mod.reportClientError(ctx({ message: '  ' }))).status).toBe(400)
    expect((await t.mod.reportClientError(ctx('just a string'))).status).toBe(400)
    expect((await t.mod.reportClientError(ctx(good, { headers: { 'content-length': String(t.mod.MAX_BODY_BYTES + 1) } }))).status).toBe(413)
    expect(t.alerts).toHaveLength(0)
  })

  it('never fails the caller when the alert path throws', async () => {
    t = setup({ quota: () => { throw new Error('backend exploded') } })
    const res = await t.mod.reportClientError(ctx(good))
    expect(res).toEqual({ body: { success: true }, status: 200 })
  })
})
