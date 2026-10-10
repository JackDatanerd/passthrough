import { describe, it, expect, afterEach } from 'vitest'
import zlib from 'node:zlib'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'
import { badgeCacheKeyForCode, purgeBadgeCache } from '../src/lib/badgeCache.js'
import { renderBadgePng } from '../src/lib/badgePng.js'
import { publicFirstName, isPublicSafeName } from '../src/lib/text.js'

// Round-6 (fresh, independent) audit of Section 7 (Verify).

const CODE = 'AB3XY7K2PQ'
const DOCX = new TextEncoder().encode('docx contents')
const PDF  = new TextEncoder().encode('pdf contents')

const bucket = files => ({ async get(k) { const b = files[k]; return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null } })
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

function harness(row, { stubs = {} } = {}) {
  const world = createWorld({ scans: [row] })
  const counts = { views: 0, downloads: 0 }
  world.rpcs.increment_verification_views = () => { counts.views++; return { data: null, error: null } }
  world.rpcs.increment_verification_downloads = () => { counts.downloads++; return { data: null, error: null } }
  const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db }, ...stubs })
  const KV = kv()
  const ctx = ({ code = CODE, ip = '203.0.113.9', method = 'GET', headers = {}, query = {}, files = { d: DOCX, p: PDF }, env = {} } = {}) => {
    const out = {}
    const hdr = { 'cf-connecting-ip': ip, 'user-agent': 'Mozilla/5.0 Chrome', ...headers }
    const bg = []
    return {
      bg,
      env: { RESUMES_BUCKET: bucket(files), RATE_LIMIT_KV: KV, NODE_ENV: 'production', ...env },
      req: { method, param: () => code, query: k => query[k], header: n => hdr[n.toLowerCase()], url: `https://api.example/api/verify/${code}` },
      get: () => null, executionCtx: { waitUntil: p => bg.push(p) },
      header: (k, v) => { out[k] = v },
      json: (data, status = 200, h = {}) => ({ status, data, headers: { ...out, ...h } }),
      body: (data, status = 200) => ({ status, data, headers: out }),
    }
  }
  return { mod, world, ctx, counts, KV, restore }
}

function installCache() {
  const store = new Map(); const puts = []
  globalThis.caches = { default: {
    match: async req => { const r = store.get(req.url); return r ? r.clone() : undefined },
    put: async (req, res) => { puts.push({ url: req.url, res }); store.set(req.url, res.clone()) },
    delete: async req => store.delete(req.url),
  } }
  return { store, puts }
}

let t
const hadCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
afterEach(() => { t?.restore(); if (hadCaches) Object.defineProperty(globalThis, 'caches', hadCaches); else delete globalThis.caches })

// ── B2: the public first name ──────────────────────────────────────────────
describe('ROUND-6 AUDIT FIX (bug): the public first name is vetted, at derivation AND at read time', () => {
  it('ordinary names of every script pass', () => {
    for (const [input, out] of [['Ada Lovelace', 'Ada'], ['李 雷', '李'], ['Åsa Berg', 'Åsa'], ['محمد علي', 'محمد'], ['Jean-Luc Picard', 'Jean-Luc'],
      ["O'Neil Burke", "O'Neil"], ['J.R. Smith', 'J.R.'], ['Maximilian Ruiz', 'Maximilian']])
      expect(publicFirstName(input)).toBe(out)
  })
  it('a link, an address, a domain, a phone number or a very long token is not a name', () => {
    for (const bad of ['https://evil.example/claim-prize', 'www.pay-here.example John', 'a@b.co', 'pay.example', 'Call-+1-555-0100-for-a-refund', 'x'.repeat(41)])
      expect(publicFirstName(bad)).toBeNull()
    expect(isPublicSafeName('x'.repeat(40))).toBe(true)
  })
  it('a name stored BEFORE this fix is vetted when the page is read', async () => {
    t = harness(await seedRow({ candidate_first_name: 'https://evil.example/claim-your-prize-now' }))
    const r = await t.mod.getVerification(t.ctx())
    expect(r.data.data.candidateFirstName).toBeNull()
    expect(r.data.data.atsScore).toBe(85)   // the rest of the page is untouched
  })
  it('a normal stored name still shows, and "hide name" still wins', async () => {
    t = harness(await seedRow())
    expect((await t.mod.getVerification(t.ctx())).data.data.candidateFirstName).toBe('Ada')
    t.restore()
    t = harness(await seedRow({ verify_hide_name: true }))
    expect((await t.mod.getVerification(t.ctx())).data.data.candidateFirstName).toBeNull()
  })
})

// ── B4: HEAD ───────────────────────────────────────────────────────────────
describe('ROUND-6 AUDIT FIX (bug): a HEAD request is never counted as a view or a download', () => {
  it('GET counts a view (control); HEAD does not', async () => {
    t = harness(await seedRow())
    await t.mod.getVerification(t.ctx({ ip: '198.51.100.1' }))
    expect(t.counts.views).toBe(1)
    await t.mod.getVerification(t.ctx({ ip: '198.51.100.2', method: 'HEAD' }))
    expect(t.counts.views).toBe(1)
  })
  it('a HEAD download is not counted either; a GET download is', async () => {
    t = harness(await seedRow())
    await t.mod.downloadVerifiedFile(t.ctx({ ip: '198.51.100.3', method: 'HEAD', query: { type: 'pdf' } }))
    expect(t.counts.downloads).toBe(0)
    await t.mod.downloadVerifiedFile(t.ctx({ ip: '198.51.100.4', query: { type: 'pdf' } }))
    expect(t.counts.downloads).toBe(1)
  })
})

// ── B5: a stored file that is gone ─────────────────────────────────────────
describe('ROUND-6 AUDIT FIX (bug): "no such object" is "missing", not a transient "unknown"', () => {
  it('a file R2 does not have is reported as missing (and the page is not verified)', async () => {
    t = harness(await seedRow())
    const r = await t.mod.getVerification(t.ctx({ files: {} }))
    expect(r.data.data.integrityStatus).toBe('missing')
    expect(r.data.data.verified).toBe(false)
  })
  it('a PDF that is gone while the Word file is fine is missing too', async () => {
    t = harness(await seedRow())
    const r = await t.mod.getVerification(t.ctx({ files: { d: DOCX } }))
    expect(r.data.data.integrityStatus).toBe('missing')
  })
  it('an R2 FAILURE stays "unknown" (that one really is transient)', async () => {
    t = harness(await seedRow())
    const ctx = t.ctx()
    ctx.env.RESUMES_BUCKET = { get: async () => { throw new Error('R2 unavailable') } }
    expect((await t.mod.getVerification(ctx)).data.data.integrityStatus).toBe('unknown')
  })
  it('an owner edit between the row read and the object read is "unknown", not "missing"', async () => {
    t = harness(await seedRow())
    const ctx = t.ctx()
    // The edit repoints the row and deletes the old object right as we look for it.
    ctx.env.RESUMES_BUCKET = { get: async () => { await t.world.db.from('scans').update({ resume_ats_path: 'd2' }).eq('id', 'scan1'); return null } }
    expect((await t.mod.getVerification(ctx)).data.data.integrityStatus).toBe('unknown')
  })
  it('the operator is told ONCE per page per day, and a healthy page tells nobody', async () => {
    const alerts = []
    const stubs = { 'services/email.service.js': { sendOwnerAlert: async (_env, subject, body) => { alerts.push({ subject, body }) } } }
    t = harness(await seedRow(), { stubs })
    await t.mod.getVerification(t.ctx({ files: {}, ip: '198.51.100.5' }))
    await t.mod.getVerification(t.ctx({ files: {}, ip: '198.51.100.6' }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].body).toContain(CODE)
    await t.mod.getVerification(t.ctx({ ip: '198.51.100.7' }))
    expect(alerts).toHaveLength(1)
  })
  it('the badge says "scan", never "Verified", for a page whose file is gone', async () => {
    t = harness(await seedRow())
    const r = await t.mod.getBadge(t.ctx({ files: {} }))
    expect(String(r.data)).toContain('scan 85/100')
    expect(String(r.data)).not.toContain('Verified')
  })
})

// ── Gap: the PNG badge ─────────────────────────────────────────────────────
function parsePng(bytes) {
  const buf = Buffer.from(bytes)
  expect([...buf.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const chunks = []
  let o = 8
  while (o < buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    const data = buf.subarray(o + 8, o + 8 + len)
    const crc = buf.readUInt32BE(o + 8 + len)
    chunks.push({ type, data, crc, crcOk: zlib.crc32(buf.subarray(o + 4, o + 8 + len)) === crc })
    o += 12 + len
  }
  return chunks
}

describe('ROUND-6 FEATURE GAP: the badge as a PNG', () => {
  it('encodes a structurally valid PNG: signature, chunk CRCs, IHDR, an IDAT that inflates to the right size', () => {
    const png = renderBadgePng('Passthrough Verified', '85/100', '#15803d')
    const chunks = parsePng(png)
    expect(chunks.map(c => c.type)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])
    expect(chunks.every(c => c.crcOk)).toBe(true)
    const ihdr = chunks[0].data
    const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4)
    expect(height).toBe(40)
    expect(width).toBeGreaterThan(200)
    expect([ihdr[8], ihdr[9]]).toEqual([2, 3])                                   // 2-bit, indexed
    const raw = zlib.inflateSync(chunks[3].data)
    expect(raw.length).toBe(height * (1 + Math.ceil(width / 4)))
    expect([...chunks[1].data.subarray(6, 9)]).toEqual([0x15, 0x80, 0x3d])       // the value colour
    expect(png.length).toBeLessThan(8000)
  })
  it('is deterministic, widens with its text, and survives characters it has no glyph for', () => {
    const a = renderBadgePng('Passthrough', 'scan 72/100', '#b45309')
    expect(Buffer.from(renderBadgePng('Passthrough', 'scan 72/100', '#b45309')).equals(Buffer.from(a))).toBe(true)
    const wide = parsePng(renderBadgePng('Passthrough Verified', '100/100', '#15803d'))[0].data.readUInt32BE(0)
    const narrow = parsePng(renderBadgePng('Passthrough', 'revoked', '#6b7280'))[0].data.readUInt32BE(0)
    expect(wide).toBeGreaterThan(narrow)
    expect(() => renderBadgePng('Pässthrough', '✓ ok', 'not-a-colour')).not.toThrow()
  })
  it('ink really lands on the canvas: both halves have text pixels, corners are transparent', () => {
    const chunks = parsePng(renderBadgePng('Passthrough', 'revoked', '#6b7280'))
    const width = chunks[0].data.readUInt32BE(0), rowBytes = Math.ceil(width / 4)
    const raw = zlib.inflateSync(chunks[3].data)
    const px = (x, y) => (raw[y * (1 + rowBytes) + 1 + (x >> 2)] >> (6 - (x & 3) * 2)) & 3
    expect(px(0, 0)).toBe(0)                                                      // rounded corner
    expect(px(width - 1, 39)).toBe(0)
    let textPixels = 0
    for (let y = 0; y < 40; y++) for (let x = 0; x < width; x++) if (px(x, y) === 3) textPixels++
    expect(textPixels).toBeGreaterThan(150)
    expect(px(3, 20)).toBe(1)                                                     // label background
    expect(px(width - 3, 20)).toBe(2)                                             // value background
  })

  it('getBadgePng serves image/png, caches it under its OWN key with the edge TTL, and re-serves hits as PNG with client headers', async () => {
    const { puts, store } = installCache()
    t = harness(await seedRow())
    const r = await t.mod.getBadgePng(t.ctx())
    expect(r.headers['Content-Type']).toBe('image/png')
    expect(r.headers['Cache-Control']).toBe('public, max-age=30')
    expect(Buffer.from(r.data).subarray(1, 4).toString()).toBe('PNG')
    // Round 7: the integrity verdict is cached next to the image; only the badge entries count here.
    const badgePuts = puts.filter(p => !p.url.includes('verify-integrity'))
    expect(badgePuts).toHaveLength(1)
    expect(badgePuts[0].url).toBe(badgeCacheKeyForCode(CODE, 'png').url)
    expect(badgePuts[0].url).not.toBe(badgeCacheKeyForCode(CODE, 'svg').url)
    expect(badgePuts[0].res.headers.get('cache-control')).toBe('public, max-age=60')
    expect([...store.keys()].filter(k => !k.includes('verify-integrity'))).toHaveLength(1)
    const hit = await t.mod.getBadgePng(t.ctx())
    expect(hit.headers.get('content-type')).toBe('image/png')
    expect(hit.headers.get('cache-control')).toBe('public, max-age=30')
  })
  it('the SVG and PNG entries do not shadow each other', async () => {
    installCache()
    t = harness(await seedRow())
    const svg = await t.mod.getBadge(t.ctx())
    expect(String(svg.data)).toContain('<svg')
    const png = await t.mod.getBadgePng(t.ctx())
    expect(Buffer.from(png.data).subarray(1, 4).toString()).toBe('PNG')
    const svgHit = await t.mod.getBadge(t.ctx())
    expect(svgHit.headers.get('content-type')).toContain('image/svg+xml')
  })
  it('a malformed code gets an uncached "not found" PNG and never touches the cache', async () => {
    const { puts } = installCache()
    t = harness(await seedRow())
    const r = await t.mod.getBadgePng(t.ctx({ code: `../${CODE}` }))
    expect(r.headers['Content-Type']).toBe('image/png')
    expect(puts).toHaveLength(0)
  })
  it('revoke / restore purge BOTH formats', async () => {
    const { store } = installCache()
    t = harness(await seedRow())
    await t.mod.getBadge(t.ctx()); await t.mod.getBadgePng(t.ctx())
    const badgeKeys = () => [...store.keys()].filter(k => !k.includes('verify-integrity'))
    expect(badgeKeys()).toHaveLength(2)
    await purgeBadgeCache(CODE)
    expect(badgeKeys()).toHaveLength(0)
  })
  it('is routed at /:code/badge.png', async () => {
    t = harness(await seedRow())
    const routesPath = require.resolve('../src/routes/verify.routes.js')
    delete require.cache[routesPath]
    const routes = require(routesPath)
    const { Hono } = require('hono')
    const app = new Hono(); app.route('/api/verify', routes)
    const res = await app.request(`/api/verify/${CODE}/badge.png`, { headers: { 'cf-connecting-ip': '198.51.100.9' } },
      { RESUMES_BUCKET: bucket({ d: DOCX, p: PDF }), NODE_ENV: 'production' }, { waitUntil() {} })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG')
    delete require.cache[routesPath]
  })
})
