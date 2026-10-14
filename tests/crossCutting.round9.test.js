import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import rl from '../src/middleware/rateLimiter.js'

// Cross-cutting infra round 9.
function kvStore() { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
const mk = (env, method, p, ip = '66.249.84.1') => ({
  env, req: { method, path: p, header: h => (h === 'cf-connecting-ip' ? ip : undefined), query: () => undefined },
  get: () => undefined, set: () => {}, json: (body, status) => ({ body, status }),
})
const hit = async c => { let passed = false; const res = await rl.general(c, async () => { passed = true }); return passed ? 200 : res.status }

describe('one-click opt-outs are exempt from the generic per-IP bucket', () => {
  for (const [method, p] of [
    ['POST', '/api/outcomes/unsubscribe'], ['GET', '/api/outcomes/unsubscribe'], ['POST', '/api/outcomes/unsubscribe/'],
    ['POST', '/api/employer-leads/unsubscribe'], ['POST', '/api/employer-leads/remove'],
  ]) {
    it(`${method} ${p} is never answered by \`general\` (shared mail-provider IPs)`, async () => {
      const env = { RATE_LIMIT_KV: kvStore(), NODE_ENV: 'production' }
      let last
      for (let i = 0; i < 130; i++) last = await hit(mk(env, method, p))
      expect(last).toBe(200)
    })
  }
  it('other outcomes routes stay on the generic limiter', async () => {
    const env = { RATE_LIMIT_KV: kvStore(), NODE_ENV: 'production' }
    let last
    for (let i = 0; i < 101; i++) last = await hit(mk(env, 'GET', '/api/outcomes/pending'))
    expect(last).toBe(429)
  })
  it('a different method on the opt-out path is not exempt', async () => {
    const env = { RATE_LIMIT_KV: kvStore(), NODE_ENV: 'production' }
    let last
    for (let i = 0; i < 101; i++) last = await hit(mk(env, 'DELETE', '/api/outcomes/unsubscribe'))
    expect(last).toBe(429)
  })
})

describe('DEPLOYMENT.md keeps what the code depends on', () => {
  const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'DEPLOYMENT.md'), 'utf8')
  it('lists every Resend event the webhook controller records', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'controllers', 'resend-webhook.controller.js'), 'utf8')
    const recorded = /RECORDED = new Set\(\[([^\]]*)\]\)/.exec(src)[1].match(/email\.[a-z_]+/g)
    expect(recorded.length).toBeGreaterThan(0)
    for (const ev of recorded) expect(doc, ev).toContain('`' + ev + '`')
  })
  it('documents the optional variables the code reads (REVERSAL_CHECKS_PER_RUN)', () => {
    expect(doc).toContain('REVERSAL_CHECKS_PER_RUN')
  })
  it('keeps one migration note per recent migration that must be applied before deploy', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
    for (const n of ['0083', '0084']) {
      expect(fs.readdirSync(dir).some(f => f.startsWith(n + '_')), n).toBe(true)
      expect(doc, `DEPLOYMENT.md has no note for migration ${n}`).toMatch(new RegExp(`migration ${n}\\b`))
    }
  })
})
