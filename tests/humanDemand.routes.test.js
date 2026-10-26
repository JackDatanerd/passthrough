import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createFakeSupabase } = require_('./helpers/fakeSupabase.cjs')
const { Hono } = require_('hono')

const VID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
let t
afterEach(() => { t?.restore(); t = null })

// The real router, mounted the way src/index.js mounts it, with the real app-level 404 handler.
function app() {
  const db = createFakeSupabase(q => (q.op === 'upsert' ? { data: [{ id: 'w' }], error: null } : undefined))
  t = loadWithStubs('routes/human-demand.routes.js', { 'config/supabase.js': { getSupabase: () => db } })
  const a = new Hono()
  a.route('/api/human-demand', t.mod)
  a.notFound(c => c.json({ success: false, message: 'Not found.' }, 404))
  t.db = db
  return a
}
const post = (a, path, body, env) => a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)

describe('flag OFF (unset, "false" or anything but "true"): the routes do not exist', () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
    it(`HUMAN_DEMAND_ENABLED=${JSON.stringify(flag)} -> 404 on all three paths, nothing written`, async () => {
      const a = app()
      const env = flag === undefined ? {} : { HUMAN_DEMAND_ENABLED: flag }
      for (const [method, path, body] of [
        ['GET', `/api/human-demand/config?vid=${VID}`], ['POST', '/api/human-demand/events', { event: 'button_shown', visitorId: VID }],
        ['POST', '/api/human-demand/waitlist', { visitorId: VID, tier: 'polish', email: 'a@b.co', consent: true }],
      ]) {
        const res = method === 'GET' ? await a.request(path, {}, env) : await post(a, path, body, env)
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(await res.json()).toEqual({ success: false, message: 'Not found.' })
      }
      expect(t.db.calls).toHaveLength(0)
    })
  }
})

describe('flag ON', () => {
  const env = { HUMAN_DEMAND_ENABLED: 'true' }
  it('serves config, takes an event and a waitlist join', async () => {
    const a = app()
    const cfg = await a.request(`/api/human-demand/config?vid=${VID}`, {}, env)
    expect(cfg.status).toBe(200)
    expect((await cfg.json()).data.variant).toMatch(/^(low|base|high)$/)
    expect((await post(a, '/api/human-demand/events', { event: 'button_shown', visitorId: VID }, env)).status).toBe(200)
    const w = await post(a, '/api/human-demand/waitlist', { visitorId: VID, tier: 'polish', email: 'a@b.co', consent: true }, env)
    expect(w.status).toBe(200)
    expect((await w.json()).data.joined).toBe(true)
  })
  it('a malformed body is a 400, not a crash', async () => {
    const a = app()
    const res = await a.request('/api/human-demand/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }, env)
    expect(res.status).toBe(400)
  })
  it('the waitlist limiter answers 429 with Retry-After once its bucket is spent', async () => {
    const calls = []
    const rlMod = require_('../src/middleware/rateLimiter.js')
    const original = rlMod.runOp
    rlMod.runOp = async (e, op, args) => { calls.push(args); return { allowed: false, retryAfter: 42 } }
    try {
      const a = app()
      const res = await post(a, '/api/human-demand/waitlist', { visitorId: VID, tier: 'polish', email: 'a@b.co', consent: true }, env)
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBe('42')
      expect(calls[0]).toMatchObject({ max: 10, windowSeconds: 3600 })
      expect(calls[0].key).toMatch(/^rl:hdwaitlist:/)
      expect(t.db.calls).toHaveLength(0)
    } finally { rlMod.runOp = original }
  })
})

describe('wiring', () => {
  it('src/index.js mounts the router at /api/human-demand and nothing else about it', () => {
    const src = fs.readFileSync('src/index.js', 'utf8')
    expect(src).toMatch(/app\.route\('\/api\/human-demand',\s+humanDemandRoutes\)/)
    expect(src).toMatch(/require\('\.\/routes\/human-demand\.routes'\)/)
  })
})
