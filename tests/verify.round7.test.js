import { describe, it, expect, afterEach } from 'vitest'
import zlib from 'node:zlib'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'
import { badgeCacheKeyForCode, purgeBadgeCache, BADGE_FORMATS } from '../src/lib/badgeCache.js'
import { renderSharePng, CARD_W, CARD_H } from '../src/lib/badgePng.js'
import { isBotUserAgent } from '../src/lib/verification.js'

// Round-7 (fresh clone) audit of Section 7 (Verify).

const CODE = 'AB3XY7K2PQ'
const DOCX = new TextEncoder().encode('docx contents')
const PDF  = new TextEncoder().encode('pdf contents')

const bucket = (files, counter) => ({ async get(k) { if (counter) counter.n++; const b = files[k]; return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null } })
const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, m } }

async function seedRow(over = {}) {
  return {
    id: 'scan1', verification_code: CODE, candidate_first_name: 'Ada', ats_score: 60, fix_ats_score: 85,
    verified_at: '2026-03-01T00:00:00.000Z', role_category: 'software_engineering', seniority_level: 'senior', verification_views: 0,
    resume_ats_path: 'd', resume_pdf_path: 'p', resume_hash: await sha256Bytes(DOCX), resume_pdf_hash: await sha256Bytes(PDF),
    resume_hash_history: [], verify_expose_docx: true, verify_expose_pdf: true, verify_hide_name: false,
    verification_status: 'ACTIVE', verification_revoked_at: null, user_id: null, ...over,
  }
}

function harness(row) {
  const world = createWorld({ scans: [row] })
  world.rpcs.increment_verification_views = () => ({ data: null, error: null })
  const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db } })
  const KV = kv()
  const reads = { n: 0 }
  const ctx = ({ code = CODE, ip = '203.0.113.9', headers = {}, query = {}, files = { d: DOCX, p: PDF } } = {}) => {
    const out = {}
    const hdr = { 'cf-connecting-ip': ip, 'user-agent': 'Mozilla/5.0 Chrome', ...headers }
    return {
      env: { RESUMES_BUCKET: bucket(files, reads), RATE_LIMIT_KV: KV, NODE_ENV: 'production' },
      req: { method: 'GET', param: () => code, query: k => query[k], header: n => hdr[n.toLowerCase()], url: `https://api.example/api/verify/${code}` },
      get: () => null, executionCtx: { waitUntil: () => {} },
      header: (k, v) => { out[k] = v },
      json: (data, status = 200, h = {}) => ({ status, data, headers: { ...out, ...h } }),
      body: (data, status = 200) => ({ status, data, headers: out }),
    }
  }
  return { mod, world, ctx, reads, restore }
}

function installCache() {
  const store = new Map()
  globalThis.caches = { default: {
    match: async req => { const r = store.get(req.url); return r ? r.clone() : undefined },
    put: async (req, res) => { store.set(req.url, res.clone()) },
    delete: async req => store.delete(req.url),
  } }
  return store
}
let t
const hadCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
afterEach(() => { t?.restore(); if (hadCaches) Object.defineProperty(globalThis, 'caches', hadCaches); else delete globalThis.caches })

function parsePng(buf) {
  const b = Buffer.from(buf); const chunks = []
  let o = 8
  while (o < b.length) { const len = b.readUInt32BE(o); chunks.push({ type: b.toString('ascii', o + 4, o + 8), data: b.subarray(o + 8, o + 8 + len) }); o += 12 + len }
  return chunks
}

describe('bot detection: Cubot handsets are people', () => {
  it('does not flag a Cubot phone UA, still flags real bots', () => {
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 11; CUBOT_X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36')).toBe(false)
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 11; Cubot P50) Chrome/120 Mobile Safari/537.36')).toBe(false)
    expect(isBotUserAgent('Googlebot/2.1 (+http://www.google.com/bot.html) Cubot')).toBe(true)
  })
})

describe('integrity verdict cache', () => {
  it('a second page load inside the TTL does not re-read R2', async () => {
    installCache()
    t = harness(await seedRow())
    const a = await t.mod.getVerification(t.ctx())
    const afterFirst = t.reads.n
    expect(afterFirst).toBe(2)
    const b = await t.mod.getVerification(t.ctx())
    expect(t.reads.n).toBe(afterFirst)
    expect(b.data.data.integrityStatus).toBe('verified')
    expect(b.data.data.verified).toBe(true)
    expect(a.data.data.verified).toBe(true)
  })
  it('regenerating a delivery (new hash) changes the key, so a stale "verified" is not reused', async () => {
    installCache()
    t = harness(await seedRow())
    await t.mod.getVerification(t.ctx())
    t.world.t.scans[0].resume_hash = await sha256Bytes(new TextEncoder().encode('different'))
    const r = await t.mod.getVerification(t.ctx())
    expect(r.data.data.integrityStatus).toBe('modified')
    expect(r.data.data.verified).toBe(false)
  })
  it('"unknown" (an R2 failure) is never cached', async () => {
    const store = installCache()
    t = harness(await seedRow())
    const ctx = t.ctx(); ctx.env.RESUMES_BUCKET = { get: async () => { throw new Error('r2 down') } }
    const r = await t.mod.getVerification(ctx)
    expect(r.data.data.integrityStatus).toBe('unknown')
    expect([...store.keys()].some(k => k.includes('verify-integrity'))).toBe(false)
  })
  it('revocation is NOT cached: a revoked page answers 410 immediately', async () => {
    installCache()
    t = harness(await seedRow())
    await t.mod.getVerification(t.ctx())
    t.world.t.scans[0].verification_status = 'REVOKED'
    expect((await t.mod.getVerification(t.ctx())).status).toBe(410)
  })
  it('works with no Cache API at all (local/dev)', async () => {
    delete globalThis.caches
    t = harness(await seedRow())
    expect((await t.mod.getVerification(t.ctx())).data.data.verified).toBe(true)
  })
})

describe('preview now carries the real verdict', () => {
  it('?preview=1 returns the checked verdict and still counts no view', async () => {
    installCache()
    t = harness(await seedRow())
    const r = await t.mod.getVerification(t.ctx({ query: { preview: '1' } }))
    expect(r.data.data.integrityStatus).toBe('verified')
    expect(r.data.data.verified).toBe(true)
    expect(r.data.data.verificationViews).toBe(0)
  })
  it('a modified file previews as not verified', async () => {
    installCache()
    t = harness(await seedRow())
    const r = await t.mod.getVerification(t.ctx({ query: { preview: '1' }, files: { d: new TextEncoder().encode('tampered'), p: PDF } }))
    expect(r.data.data.integrityStatus).toBe('modified')
    expect(r.data.data.verified).toBe(false)
  })
})

describe('by-hash no longer spends the page budget', () => {
  it('50 unknown hashes from one IP leave /:code readable', async () => {
    t = harness(await seedRow())
    for (let i = 0; i < 50; i++) {
      const c = t.ctx(); c.req.param = () => String(i).padStart(64, 'c')
      expect((await t.mod.lookupByHash(c)).status).toBe(404)
    }
    expect((await t.mod.getVerification(t.ctx())).status).toBe(200)
  })
})

describe('share card', () => {
  it('renderSharePng is a valid 1200x630 indexed PNG with ink in the status colour and text', () => {
    const png = renderSharePng({ headline: 'PASSTHROUGH VERIFIED', big: '85/100', sub: 'ATS SCORE', footer: 'CODE AB3XY7K2PQ', color: '#15803d' })
    const chunks = parsePng(png)
    expect(chunks.map(c => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND'])
    expect(chunks[0].data.readUInt32BE(0)).toBe(CARD_W)
    expect(chunks[0].data.readUInt32BE(4)).toBe(CARD_H)
    expect([...chunks[1].data.subarray(6, 9)]).toEqual([0x15, 0x80, 0x3d])
    const rowBytes = Math.ceil(CARD_W / 4)
    const raw = zlib.inflateSync(chunks[2].data)
    expect(raw.length).toBe(CARD_H * (1 + rowBytes))
    const px = (x, y) => (raw[y * (1 + rowBytes) + 1 + (x >> 2)] >> (6 - (x & 3) * 2)) & 3
    expect(px(10, 10)).toBe(2)       // top bar
    expect(px(10, 300)).toBe(0)      // white
    let dark = 0
    for (let y = 150; y < 420; y++) for (let x = 0; x < CARD_W; x++) if (px(x, y) === 1) dark++
    expect(dark).toBeGreaterThan(5000)   // the big score
  })
  it('never overflows the canvas with long text', () => {
    expect(() => renderSharePng({ headline: 'X'.repeat(200), big: '9'.repeat(100), sub: 'Y'.repeat(300), footer: 'Z'.repeat(300) })).not.toThrow()
  })
  it('getCardPng serves image/png under its own cache key and reuses it', async () => {
    const store = installCache()
    t = harness(await seedRow())
    const r = await t.mod.getCardPng(t.ctx())
    expect(r.headers['Content-Type']).toBe('image/png')
    expect(Buffer.from(r.data).subarray(1, 4).toString()).toBe('PNG')
    expect(Buffer.from(r.data).readUInt32BE(16)).toBe(CARD_W)
    expect(store.has(badgeCacheKeyForCode(CODE, 'card').url)).toBe(true)
    expect(badgeCacheKeyForCode(CODE, 'card').url).not.toBe(badgeCacheKeyForCode(CODE, 'png').url)
    const before = t.reads.n
    await t.mod.getCardPng(t.ctx())
    expect(t.reads.n).toBe(before)
  })
  it('a not-found / revoked code still gets a real card; a malformed code is uncached', async () => {
    const store = installCache()
    t = harness(await seedRow({ verification_status: 'REVOKED' }))
    expect(Buffer.from((await t.mod.getCardPng(t.ctx())).data).subarray(1, 4).toString()).toBe('PNG')
    const bad = await t.mod.getCardPng(t.ctx({ code: `../${CODE}` }))
    expect(bad.headers['Content-Type']).toBe('image/png')
    expect([...store.keys()].filter(k => k.includes('card')).length).toBe(1)
  })
  it('purgeBadgeCache clears the card too, and is routed at /:code/card.png', async () => {
    const store = installCache()
    expect(BADGE_FORMATS).toContain('card')
    t = harness(await seedRow())
    await t.mod.getCardPng(t.ctx())
    await purgeBadgeCache(CODE)
    expect([...store.keys()].filter(k => k.includes('card'))).toHaveLength(0)
    const routesPath = require.resolve('../src/routes/verify.routes.js')
    delete require.cache[routesPath]
    const routes = require(routesPath)
    const { Hono } = require('hono')
    const app = new Hono(); app.route('/api/verify', routes)
    const res = await app.request(`/api/verify/${CODE}/card.png`, { headers: { 'cf-connecting-ip': '198.51.100.9' } }, { RESUMES_BUCKET: bucket({ d: DOCX, p: PDF }), NODE_ENV: 'production' })
    expect(res.headers.get('content-type')).toBe('image/png')
  })
})
