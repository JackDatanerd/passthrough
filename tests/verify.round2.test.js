import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'

// Round-2 audit of Section 7 (Verify): limiter scopes, badge behaviour, trusted preview.

const CODE = 'AB3XY7'
const DOCX = new TextEncoder().encode('docx contents')
const PDF  = new TextEncoder().encode('pdf contents')

const bucket = files => ({ async get(k) { const b = files[k]; return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null } })
const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, m } }

async function seedRow(over = {}) {
  return {
    id: 'scan1', verification_code: CODE, candidate_first_name: 'Ada', ats_score: 60, fix_ats_score: 85,
    verified_at: '2026-03-01T00:00:00.000Z', role_category: 'ENGINEERING', seniority_level: 'SENIOR', verification_views: 0,
    resume_ats_path: 'd', resume_pdf_path: 'p', resume_hash: await sha256Bytes(DOCX), resume_pdf_hash: await sha256Bytes(PDF),
    resume_hash_history: [], verify_expose_docx: false, verify_expose_pdf: false, verify_hide_name: false,
    verification_status: 'ACTIVE', verification_revoked_at: null, user_id: null, ...over,
  }
}

function harness(row) {
  const world = createWorld({ scans: [row] })
  world.rpcs.increment_verification_views = () => ({ data: null, error: null })
  const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db } })
  const KV = kv()
  const ctx = ({ code = CODE, ip = '203.0.113.9', headers = {}, query = {}, files = { d: DOCX, p: PDF }, env = {} } = {}) => {
    const out = {}
    const hdr = { 'cf-connecting-ip': ip, 'user-agent': 'Mozilla/5.0 Chrome', ...headers }
    return {
      env: { RESUMES_BUCKET: bucket(files), RATE_LIMIT_KV: KV, NODE_ENV: 'production', ...env },
      req: { param: () => code, query: k => query[k], header: n => hdr[n.toLowerCase()], url: `https://api.example/api/verify/${code}/badge.svg` },
      get: () => null, executionCtx: { waitUntil: () => {} },
      header: (k, v) => { out[k] = v },
      json: (data, status = 200, h = {}) => ({ status, data, headers: { ...out, ...h } }),
      body: (data, status = 200) => ({ status, data, headers: out }),
    }
  }
  return { mod, world, ctx, KV, restore }
}

let t
afterEach(() => t?.restore())

describe('badge — always a real image, with its own miss budget', () => {
  it('answers an unknown code with a grey "not found" SVG (cacheable), not JSON', async () => {
    t = harness(await seedRow())
    const res = await t.mod.getBadge(t.ctx({ code: 'QQQQQQ' }))
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/svg+xml; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('public, max-age=300')
    expect(res.data).toContain('not found')
  })

  it('REGRESSION: 30+ stale-code badge hits from one IP no longer lock out a valid page lookup or badge', async () => {
    t = harness(await seedRow())
    for (let i = 0; i < 40; i++) await t.mod.getBadge(t.ctx({ code: 'ZZZZZ' + 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[i % 32] }))
    const page = await t.mod.getVerification(t.ctx())
    expect(page.status).toBe(200)
    expect(page.data.data.verified).toBe(true)
    const badge = await t.mod.getBadge(t.ctx())
    expect(badge.status).toBe(200)
    expect(badge.data).toContain('85/100')
  })

  it('the badge still has an enumeration brake: past its own (higher) budget it answers 429', async () => {
    t = harness(await seedRow())
    const rl = require('../src/middleware/rateLimiter.js')
    let res
    for (let i = 0; i < rl.VERIFY_BADGE_MISS_MAX + 1; i++) res = await t.mod.getBadge(t.ctx({ code: 'QQQQQQ', ip: '198.51.100.4' }))
    expect(res.status).toBe(429)
    expect(res.headers['Retry-After']).toBeDefined()
  })

  it('says "Verified" only when integrity checks out; the unsettled case gets a short cache lifetime', async () => {
    t = harness(await seedRow())
    const ok = await t.mod.getBadge(t.ctx())
    expect(ok.data).toContain('Passthrough Verified')
    expect(ok.headers['Cache-Control']).toBe('public, max-age=300')
    const blip = await t.mod.getBadge(t.ctx({ files: { d: DOCX /* pdf missing → unknown */ } }))
    expect(blip.data).not.toContain('Passthrough Verified')
    expect(blip.data).toContain('scan 85/100')
    expect(blip.headers['Cache-Control']).toBe('public, max-age=60')
  })

  it('a revoked page reads "revoked"', async () => {
    t = harness(await seedRow({ verification_status: 'REVOKED' }))
    expect((await t.mod.getBadge(t.ctx())).data).toContain('revoked')
  })
})

describe('page lookups — miss accounting', () => {
  it('counts a genuine miss, and 30 of them answer 429 with Retry-After', async () => {
    t = harness(await seedRow())
    let res
    for (let i = 0; i < 31; i++) res = await t.mod.getVerification(t.ctx({ code: 'QQQQQQ', ip: '198.51.100.5' }))
    expect(res.status).toBe(429)
    expect(res.headers['Retry-After']).toBe('900')
  })

  it('does NOT count a malformed code (it never touches the DB and reveals nothing)', async () => {
    t = harness(await seedRow())
    for (let i = 0; i < 40; i++) await t.mod.getVerification(t.ctx({ code: 'nope', ip: '198.51.100.6' }))
    expect((await t.mod.getVerification(t.ctx({ ip: '198.51.100.6' }))).status).toBe(200)
  })

  it('does NOT let a browser-reported sub-resource load (<img>, no-cors) spend the visitor\'s budget', async () => {
    t = harness(await seedRow())
    for (let i = 0; i < 40; i++)
      await t.mod.getVerification(t.ctx({ code: 'QQQQQQ', ip: '198.51.100.7', headers: { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' } }))
    expect((await t.mod.getVerification(t.ctx({ ip: '198.51.100.7' }))).status).toBe(200)
  })

  it('the SPA\'s own XHR (Sec-Fetch-Dest: empty, cors) IS counted', async () => {
    t = harness(await seedRow())
    for (let i = 0; i < 30; i++)
      await t.mod.getVerification(t.ctx({ code: 'QQQQQQ', ip: '198.51.100.8', headers: { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' } }))
    expect((await t.mod.getVerification(t.ctx({ ip: '198.51.100.8' }))).status).toBe(429)
  })

  it('a trusted preview (shared secret) is exempt from the limiter and records no misses', async () => {
    t = harness(await seedRow())
    const env = { VERIFY_PREVIEW_KEY: 's3cret' }
    const headers = { 'x-preview-key': 's3cret' }
    for (let i = 0; i < 50; i++) await t.mod.getVerification(t.ctx({ code: 'QQQQQQ', ip: '198.51.100.9', env, headers, query: { preview: '1' } }))
    expect((await t.mod.getVerification(t.ctx({ ip: '198.51.100.9', env, headers, query: { preview: '1' } }))).status).toBe(200)
    // …and a WRONG key gets no exemption
    for (let i = 0; i < 30; i++) await t.mod.getVerification(t.ctx({ code: 'QQQQQQ', ip: '198.51.100.10', env, headers: { 'x-preview-key': 'wrong' }, query: { preview: '1' } }))
    expect((await t.mod.getVerification(t.ctx({ ip: '198.51.100.10', env, headers: { 'x-preview-key': 'wrong' } }))).status).toBe(429)
  })
})

describe('general limiter no longer covers /api/verify/*', () => {
  it('skips the verify path but still applies to ordinary routes', () => {
    const rl = require('../src/middleware/rateLimiter.js')
    expect(rl.verifyRead).toBeTypeOf('function')
    // the skip predicate is exercised through the middleware: 101 calls on a verify path all pass
    const kvs = kv()
    const c = path => ({ env: { RATE_LIMIT_KV: kvs }, req: { method: 'GET', path, header: h => (h === 'cf-connecting-ip' ? '192.0.2.1' : undefined) }, json: (d, s) => ({ status: s }) })
    return (async () => {
      let last
      for (let i = 0; i < 110; i++) last = await rl.general(c('/api/verify/AB3XY7/badge.svg'), async () => 'next')
      expect(last).toBe('next')
      let blocked
      for (let i = 0; i < 110; i++) blocked = await rl.general(c('/api/auth/me'), async () => 'next')
      expect(blocked.status).toBe(429)
    })()
  })
})
