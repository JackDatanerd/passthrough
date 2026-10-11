import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes, sha256 } from '../src/lib/crypto.js'
import { isBotUserAgent } from '../src/lib/verification.js'
import { renderQrPng, renderQrSvg } from '../src/lib/qr.js'

// Round-9 (fresh clone) audit of Section 7 (Verify).
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

function harness(row, { tables = {}, stubs = {} } = {}) {
  const world = createWorld({ scans: row ? [row] : [], ...tables })
  world.rpcs.increment_verification_views = () => ({ data: null, error: null })
  const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db }, ...stubs })
  const KV = kv()
  const ctx = ({ code = CODE, ip = '203.0.113.9', ua = 'Mozilla/5.0 Chrome', query = {}, files = { d: DOCX, p: PDF }, body, env = {} } = {}) => {
    const out = {}
    const hdr = { 'cf-connecting-ip': ip, 'user-agent': ua }
    return {
      env: { RESUMES_BUCKET: bucket(files), RATE_LIMIT_KV: KV, NODE_ENV: 'production', FRONTEND_URL: 'https://passthrough.dev', ...env },
      req: { method: 'GET', param: () => code, query: k => query[k], header: n => hdr[n.toLowerCase()], url: `https://api.example/api/verify/${code}`, json: async () => { if (body === undefined) throw new Error('no body'); return body } },
      get: () => null, executionCtx: { waitUntil: () => {} },
      header: (k, v) => { out[k] = v },
      json: (data, status = 200, h = {}) => ({ status, data, headers: { ...out, ...h } }),
      body: (data, status = 200) => ({ status, data, headers: out }),
    }
  }
  return { mod, world, ctx, restore }
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

describe('B1: the badge does not read a cached integrity verdict (staleness is one minute, not two)', () => {
  it('a tampered file shows on the badge even while the PAGE still holds the earlier "verified" verdict', async () => {
    installCache()
    t = harness(await seedRow())
    expect((await t.mod.getVerification(t.ctx())).data.data.integrityStatus).toBe('verified')   // warms the 60s verdict cache
    const tampered = { d: new TextEncoder().encode('tampered'), p: PDF }
    const badge = await t.mod.getBadge(t.ctx({ files: tampered }))
    expect(String(badge.data)).toContain('scan 85/100')                                          // not "Passthrough Verified"
    expect(String(badge.data)).not.toContain('>85/100<')
    // the page, which is allowed the cached verdict, still says verified inside its own 60 seconds
    expect((await t.mod.getVerification(t.ctx({ files: tampered }))).data.data.integrityStatus).toBe('modified')   // badge wrote the fresh verdict back
  })
  it('the page still reuses the verdict inside the TTL (no extra R2 reads)', async () => {
    installCache()
    t = harness(await seedRow())
    const a = await t.mod.getVerification(t.ctx())
    const b = await t.mod.getVerification(t.ctx({ files: {} }))   // R2 now empty: only a cache hit can still say verified
    expect(a.data.data.integrityStatus).toBe('verified')
    expect(b.data.data.integrityStatus).toBe('verified')
  })
})

describe('gap: the page says when the integrity verdict was made', () => {
  it('returns integrityCheckedAt, and a cache hit keeps the ORIGINAL time', async () => {
    installCache()
    t = harness(await seedRow())
    const a = (await t.mod.getVerification(t.ctx())).data.data
    expect(Number.isNaN(Date.parse(a.integrityCheckedAt))).toBe(false)
    await new Promise(r => setTimeout(r, 15))
    const b = (await t.mod.getVerification(t.ctx())).data.data
    expect(b.integrityCheckedAt).toBe(a.integrityCheckedAt)
  })
  it('an entry cached before this round (bare status) still reads, with an unknown time', async () => {
    const store = installCache()
    const row = await seedRow()
    t = harness(row)
    const tag = `${row.resume_hash.slice(0, 12)}-${row.resume_pdf_hash.slice(0, 12)}-p1`
    store.set(`https://verify-integrity.passthrough.internal/${CODE}/${tag}`, new Response('verified'))
    const r = (await t.mod.getVerification(t.ctx({ files: {} }))).data.data
    expect(r.integrityStatus).toBe('verified')
    expect(r.integrityCheckedAt).toBeNull()
  })
})

describe('B7: a link-preview fetch does not carry the fingerprint history', () => {
  const history = [{ docx: 'a'.repeat(64), pdf: 'b'.repeat(64), at: '2026-01-01T00:00:00.000Z' }]
  it('preview=1 drops `previous`, a normal load keeps it', async () => {
    t = harness(await seedRow({ resume_hash_history: history }))
    const preview = (await t.mod.getVerification(t.ctx({ query: { preview: '1' } }))).data.data
    const page = (await t.mod.getVerification(t.ctx())).data.data
    expect(preview.fingerprints.previous).toEqual([])
    expect(preview.fingerprints.docx).toBeTruthy()
    expect(page.fingerprints.previous.length).toBe(2)
  })
})

describe('B6: a removed page is not a miss', () => {
  function limiterStub() {
    const misses = []
    return { misses, stub: { isVerifyMissLimited: async () => false, recordVerifyMiss: async (...a) => { misses.push(a) }, hitQuota: async () => true, isBypassed: () => false } }
  }
  it('a tombstoned code answers 410 and records no miss', async () => {
    const l = limiterStub()
    t = harness(null, { tables: { verification_tombstones: [{ code: CODE }] }, stubs: { 'middleware/rateLimiter.js': l.stub } })
    const r = await t.mod.getVerification(t.ctx())
    expect(r.status).toBe(410); expect(r.data.code).toBe('REMOVED')
    expect(l.misses).toHaveLength(0)
  })
  it('an unknown code is still a miss', async () => {
    const l = limiterStub()
    t = harness(null, { tables: { verification_tombstones: [] }, stubs: { 'middleware/rateLimiter.js': l.stub } })
    expect((await t.mod.getVerification(t.ctx())).status).toBe(404)
    expect(l.misses).toHaveLength(1)
  })
})

describe('bot filter: in-app browsers are people, link-preview fetchers are not', () => {
  it('Pinterest / Quora in-app browsers count; their fetchers and the other chat crawlers do not', () => {
    expect(isBotUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [Pinterest/iOS]')).toBe(false)
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 Quora/4.0')).toBe(false)
    for (const ua of ['Pinterest/0.2 (+http://www.pinterest.com/bot.html)', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'TelegramBot (like TwitterBot)', 'Mozilla/5.0 Quora Link Preview/1.0', 'SkypeUriPreview Preview/0.5', 'Slack-ImgProxy', 'WhatsApp/2.23.20.0', '']) expect(isBotUserAgent(ua)).toBe(true)
  })
})

describe('B2/B3: the reporter key is the network only, and is keyed', () => {
  it('same network, different User-Agent => same key; different network => different key', async () => {
    t = harness(await seedRow())
    const env = { JWT_SECRET: 'x'.repeat(40) }
    const a = await t.mod.reporterKey(env, '203.0.113.9')
    expect(await t.mod.reporterKey(env, '203.0.113.9')).toBe(a)
    expect(await t.mod.reporterKey(env, '2001:db8:1:2::1')).toBe(await t.mod.reporterKey(env, '2001:db8:1:ffff::9'))   // same /48
    expect(await t.mod.reporterKey(env, '203.0.113.10')).not.toBe(a)
  })
  it('is not a bare hash of the address (cannot be enumerated), and changes with the secret', async () => {
    t = harness(await seedRow())
    const a = await t.mod.reporterKey({ JWT_SECRET: 'x'.repeat(40) }, '203.0.113.9')
    expect(a).not.toBe(await sha256('203.0.113.9'))
    expect(a).not.toBe(await sha256('report-v2|203.0.113.9'))
    expect(a).not.toBe(await t.mod.reporterKey({ JWT_SECRET: 'y'.repeat(40) }, '203.0.113.9'))
  })
  it('a second report from the same network with another User-Agent is absorbed (one row)', async () => {
    t = harness(await seedRow(), { tables: { verification_reports: [] } })
    t.world.unique.verification_reports = [['code', 'reporter_hash']]
    const env = { JWT_SECRET: 'x'.repeat(40) }
    await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE' }, ua: 'Mozilla/5.0 Chrome', env }))
    await t.mod.reportVerification(t.ctx({ body: { reason: 'WRONG' }, ua: 'curl/8.0 (rotated)', env }))
    expect(t.world.t.verification_reports).toHaveLength(1)
  })
})

describe('gap: the page owner is told their page was reported', () => {
  function setup({ reason = 'WRONG', user = { id: 'u1', name: 'Ada', email: 'ada@example.com', status: 'ACTIVE', deleted_at: null }, quotaAllows = true } = {}) {
    const sent = []
    const quotas = []
    const stubs = {
      'middleware/rateLimiter.js': { isVerifyMissLimited: async () => false, recordVerifyMiss: async () => {}, isBypassed: () => false, hitQuota: async (env, key, max, win) => { quotas.push([key, max, win]); return key.startsWith('rl:verifyreportowner:') ? quotaAllows : true } },
      'services/email.service.js': { sendOwnerAlert: async () => {}, sendVerificationReported: async (...a) => { sent.push(a) } },
    }
    return { sent, quotas, stubs, reason, user }
  }
  async function run(s, rowOver = {}) {
    t = harness(await seedRow({ user_id: s.user ? s.user.id : null, ...rowOver }), { tables: { verification_reports: [], users: s.user ? [s.user] : [] }, stubs: s.stubs })
    t.world.unique.verification_reports = [['code', 'reporter_hash']]
    return t.mod.reportVerification(t.ctx({ body: { reason: s.reason, details: 'secret reporter words', email: 'reader@example.com' }, env: { RATE_LIMIT_KV: {} } }))
  }
  it('e-mails the owner the KIND of problem — never the reporter or what they wrote', async () => {
    const s = setup(); const r = await run(s)
    expect(r.status).toBe(200)
    expect(s.sent).toHaveLength(1)
    const [, , to, name, info] = s.sent[0]
    expect(to).toBe('ada@example.com'); expect(name).toBe('Ada')
    expect(info.code).toBe(CODE); expect(info.pageUrl).toBe(`https://passthrough.dev/v/${CODE}`)
    expect(JSON.stringify([to, name, info])).not.toMatch(/secret reporter words|reader@example\.com/)
  })
  it('is limited to one notice per page per 3 days', async () => {
    const s = setup({ quotaAllows: false }); expect((await run(s)).status).toBe(200)
    expect(s.sent).toHaveLength(0)
    expect(s.quotas.find(q => q[0] === `rl:verifyreportowner:${CODE}`).slice(1)).toEqual([1, 3 * 24 * 60 * 60])
  })
  it('does not notify for MINE, for a deleted/banned owner, or a page with no owner', async () => {
    for (const s of [setup({ reason: 'MINE' }), setup({ user: { id: 'u1', name: 'A', email: 'a@x.y', status: 'ACTIVE', deleted_at: '2026-01-01' } }), setup({ user: { id: 'u1', name: 'A', email: 'a@x.y', status: 'BANNED', deleted_at: null } }), setup({ user: null })]) {
      expect((await run(s)).status).toBe(200); t.restore(); expect(s.sent).toHaveLength(0)
    }
  })
  it('an e-mail failure never fails the report', async () => {
    const s = setup(); s.stubs['services/email.service.js'].sendVerificationReported = async () => { throw new Error('resend down') }
    expect((await run(s)).status).toBe(200)
  })
})

describe('gap: QR code for the page link', () => {
  it('SVG: a real QR (one path, quiet zone, white background)', () => {
    const svg = renderQrSvg(`https://passthrough.dev/v/${CODE}`)
    expect(svg).toMatch(/^<svg /); expect(svg).toContain('viewBox="0 0 37 37"')   // 29 modules + 2 x 4 quiet
    expect(svg).toContain('fill="#fff"'); expect(svg.match(/<path /g)).toHaveLength(1)
  })
  it('PNG: valid signature, 1-bit grayscale, square, scale 8', () => {
    const png = Buffer.from(renderQrPng(`https://passthrough.dev/v/${CODE}`))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(37 * 8); expect(png.readUInt32BE(20)).toBe(37 * 8)
    expect(png[24]).toBe(1); expect(png[25]).toBe(0)
  })
  it('routes: a plausible code answers an image with the right headers; junk answers 404 and encodes nothing', async () => {
    t = harness(null)
    const png = t.mod.getQrPng(t.ctx())
    expect(png.headers['Content-Type']).toBe('image/png'); expect(png.headers['Cache-Control']).toBe('public, max-age=86400')
    expect(Buffer.from(png.data).subarray(1, 4).toString()).toBe('PNG')
    const svg = t.mod.getQrSvg(t.ctx({ code: CODE.toLowerCase(), env: { FRONTEND_URL: 'https://passthrough.dev/' } }))
    expect(svg.headers['Content-Type']).toMatch(/svg/); expect(svg.data).toContain('<svg')
    expect(t.mod.getQrPng(t.ctx({ code: `../${CODE}` })).status).toBe(404)
    expect(t.mod.getQrSvg(t.ctx({ code: 'nope' })).status).toBe(404)
  })
  it('is routed at /:code/qr.svg and /:code/qr.png', async () => {
    const { Hono } = require('hono')
    const routesPath = require.resolve('../src/routes/verify.routes.js')
    delete require.cache[routesPath]
    const app = new Hono(); app.route('/api/verify', require(routesPath))
    const env = { NODE_ENV: 'production', FRONTEND_URL: 'https://passthrough.dev' }
    for (const [ext, type] of [['png', 'image/png'], ['svg', 'image/svg+xml; charset=utf-8']]) {
      const res = await app.request(`/api/verify/${CODE}/qr.${ext}`, {}, env)
      expect(res.status).toBe(200); expect(res.headers.get('content-type')).toBe(type)
    }
  })
})
