import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'
import { badgeCacheKeyForCode } from '../src/lib/badgeCache.js'
import { recordTombstones, hashesOfRow } from '../src/lib/verification.js'

// Round-4 (fresh, independent) audit of Section 7 (Verify).

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
    resume_hash_history: [], verify_expose_docx: true, verify_expose_pdf: true, verify_hide_name: false,
    verification_status: 'ACTIVE', verification_revoked_at: null, user_id: null, ...over,
  }
}

function harness(row, extra = {}) {
  const world = createWorld({ scans: [row], ...extra })
  world.rpcs.increment_verification_views = () => ({ data: null, error: null })
  world.rpcs.increment_verification_downloads = () => ({ data: null, error: null })
  const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db } })
  const KV = kv()
  const ctx = ({ code = CODE, ip = '203.0.113.9', headers = {}, query = {}, files = { d: DOCX, p: PDF }, env = {} } = {}) => {
    const out = {}
    const hdr = { 'cf-connecting-ip': ip, 'user-agent': 'Mozilla/5.0 Chrome', ...headers }
    return {
      env: { RESUMES_BUCKET: bucket(files), RATE_LIMIT_KV: KV, NODE_ENV: 'production', ...env },
      req: { param: n => (n === 'hash' ? code : code), query: k => query[k], header: n => hdr[n.toLowerCase()], url: `https://api.example/api/verify/${code}/badge.svg` },
      get: () => null, executionCtx: { waitUntil: () => {} },
      header: (k, v) => { out[k] = v },
      json: (data, status = 200, h = {}) => ({ status, data, headers: { ...out, ...h } }),
      body: (data, status = 200) => ({ status, data, headers: out }),
    }
  }
  return { mod, world, ctx, KV, restore }
}

// A Cache API stand-in keyed by the request URL, like Cloudflare's.
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

describe('ROUND-4 AUDIT FIX (bug, security): badge cache key cannot be steered onto a real page', () => {
  it('dot-segment spellings no longer collapse to the real code\'s cache key', () => {
    const real = badgeCacheKeyForCode(CODE).url
    for (const evil of [`../${CODE}`, `./${CODE}`, `x/../${CODE}`, `${CODE}/.`])
      expect(badgeCacheKeyForCode(evil).url).not.toBe(real)
    expect(real).toBe(`https://verify-badge.passthrough.internal/${CODE}`)   // a real code is unchanged
  })

  it('a malformed code never reads or writes the cache, and the real page\'s entry is untouched', async () => {
    const { store, puts } = installCache()
    t = harness(await seedRow())
    const good = await t.mod.getBadge(t.ctx())
    expect(good.data).toContain('Passthrough Verified')
    const realUrl = badgeCacheKeyForCode(CODE).url
    expect(store.has(realUrl)).toBe(true)
    const putsBefore = puts.length

    for (const evil of [`../${CODE}`, `x/../${CODE}`, '..', 'ab/cd']) {
      const r = await t.mod.getBadge(t.ctx({ code: evil }))
      expect(String(r.data)).toContain('not found')
    }
    expect(puts.length).toBe(putsBefore)                       // nothing was cached for any of them
    const again = await t.mod.getBadge(t.ctx())                // a cache hit → a real Response
    expect(await again.text()).toContain('Passthrough Verified')   // the real badge is still the real badge
  })
})

describe('ROUND-4 AUDIT FIX (bug): badge client caching is short, edge caching is not', () => {
  it('clients get <= 30s; the stored edge copy keeps the full TTL', async () => {
    const { puts } = installCache()
    t = harness(await seedRow())
    const r = await t.mod.getBadge(t.ctx())
    expect(r.headers['Cache-Control']).toBe('public, max-age=30')
    // Round 5: a live badge's edge TTL is 60s (cache.delete only purges one data center, so the TTL is the real bound).
    expect(puts[0].res.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('a cache hit is re-served with client headers, not the edge TTL', async () => {
    installCache()
    t = harness(await seedRow())
    await t.mod.getBadge(t.ctx())
    const hit = await t.mod.getBadge(t.ctx())
    expect(hit.headers.get('cache-control')).toBe('public, max-age=30')
  })

  it('the unsettled (integrity could not run) badge is still capped at 30s for clients and 30s at the edge', async () => {
    const { puts } = installCache()
    t = harness(await seedRow())
    const ctx = t.ctx()
    ctx.env.RESUMES_BUCKET = { get: async () => { throw new Error('R2 unavailable') } }   // the check could not run → 'unknown'
    const r = await t.mod.getBadge(ctx)
    expect(r.headers['Cache-Control']).toBe('public, max-age=30')
    expect(puts[0].res.headers.get('cache-control')).toBe('public, max-age=30')
  })
})

describe('ROUND-4 AUDIT (feature gap): a genuine file from a DELETED page is "removed", not "forged"', () => {
  const H = 'a'.repeat(64)

  it('by-hash answers with the tombstoned code, without recording a miss', async () => {
    t = harness(await seedRow(), { verification_tombstone_hashes: [{ hash: H, code: 'GONE99' }] })
    const r = await t.mod.lookupByHash(t.ctx({ code: H, ip: '198.51.100.7' }))
    expect(r.status).toBe(200)
    expect(r.data.data).toMatchObject({ code: 'GONE99', match: 'removed', removed: true })
    expect([...t.KV.m.keys()].some(k => k.startsWith('rl:vmiss'))).toBe(false)
  })

  it('an unknown hash is still NO_MATCH (and, since round 7, no longer counts as a miss)', async () => {
    t = harness(await seedRow(), { verification_tombstone_hashes: [] })
    const r = await t.mod.lookupByHash(t.ctx({ code: 'b'.repeat(64), ip: '198.51.100.8' }))
    expect(r.status).toBe(404)
    expect(r.data.code).toBe('NO_MATCH')
    expect([...t.KV.m.keys()].some(k => k.startsWith('rl:vmiss'))).toBe(false)
  })

  it('a missing tombstone-hash table fails soft to NO_MATCH', async () => {
    t = harness(await seedRow())
    t.world.failNext('verification_tombstone_hashes', 'select', { message: 'relation does not exist' })
    const r = await t.mod.lookupByHash(t.ctx({ code: 'c'.repeat(64), ip: '198.51.100.9' }))
    expect(r.status).toBe(404)
  })

  it('a live page still wins over any tombstone', async () => {
    const row = await seedRow()
    t = harness(row, { verification_tombstone_hashes: [{ hash: row.resume_hash, code: 'OLD111' }] })
    const r = await t.mod.lookupByHash(t.ctx({ code: row.resume_hash }))
    expect(r.data.data).toMatchObject({ code: CODE, match: 'current' })
  })
})

describe('recordTombstones keeps every fingerprint the page ever covered', () => {
  const h = c => c.repeat(64)
  const mkDb = () => {
    const seen = []
    return { seen, from: table => ({ upsert: async (rows, opts) => { seen.push({ table, rows, opts }); return { error: null } } }) }
  }

  it('hashesOfRow collects current + superseded docx/pdf hashes, deduped, valid only', () => {
    const row = { resume_hash: h('a'), resume_pdf_hash: h('b'), resume_hash_history: [{ docx: h('a'), pdf: h('c') }, { docx: h('d'), pdf: null }, { docx: 'not-a-hash' }] }
    expect(hashesOfRow(row).sort()).toEqual([h('a'), h('b'), h('c'), h('d')])
    expect(hashesOfRow(null)).toEqual([])
  })

  it('writes the code AND its hashes; plain-string callers still work', async () => {
    const db = mkDb()
    await recordTombstones(db, [{ verification_code: 'AB3XY7', resume_hash: h('a'), resume_pdf_hash: h('b'), resume_hash_history: [] }, 'CD4ZW8', null])
    const tombs = db.seen.find(s => s.table === 'verification_tombstones')
    const hashes = db.seen.find(s => s.table === 'verification_tombstone_hashes')
    expect(tombs.rows).toEqual([{ code: 'AB3XY7' }, { code: 'CD4ZW8' }])
    expect(hashes.rows).toEqual([{ hash: h('a'), code: 'AB3XY7' }, { hash: h('b'), code: 'AB3XY7' }])
    expect(hashes.opts).toMatchObject({ onConflict: 'hash', ignoreDuplicates: true })
  })

  it('does not touch the hash table when there are no hashes, and never throws if it is missing', async () => {
    const db = mkDb()
    await recordTombstones(db, ['AB3XY7'])
    expect(db.seen.map(s => s.table)).toEqual(['verification_tombstones'])
    const broken = { from: table => ({ upsert: async () => { if (table === 'verification_tombstone_hashes') throw new Error('boom'); return { error: null } } }) }
    await expect(recordTombstones(broken, [{ verification_code: 'AB3XY7', resume_hash: h('a') }])).resolves.toBeUndefined()
  })
})

describe('ROUND-4 AUDIT (feature gap): owners see whether a file was actually downloaded', () => {
  let calls
  beforeEach(() => { calls = [] })
  const withRpc = async over => { t = harness(await seedRow(over)); t.world.rpcs.increment_verification_downloads = a => { calls.push(a.p_code); return { data: null, error: null } } }

  it('counts a served download once per visitor per file type per day', async () => {
    await withRpc()
    const a = await t.mod.downloadVerifiedFile(t.ctx({ query: { type: 'docx' } }))
    expect(a.status).toBe(200)
    await t.mod.downloadVerifiedFile(t.ctx({ query: { type: 'docx' } }))   // same visitor, same type
    await t.mod.downloadVerifiedFile(t.ctx({ query: { type: 'pdf' } }))    // same visitor, other type
    expect(calls).toEqual([CODE, CODE])
  })

  it('does not count bots, refused files or files that failed their fingerprint', async () => {
    await withRpc({ verify_expose_docx: false })
    await t.mod.downloadVerifiedFile(t.ctx({ query: { type: 'docx' } }))                                          // 403
    await t.mod.downloadVerifiedFile(t.ctx({ query: { type: 'pdf' }, headers: { 'user-agent': 'curl/8' } }))      // bot
    await t.mod.downloadVerifiedFile(t.ctx({ query: { type: 'pdf' }, files: { d: DOCX, p: new TextEncoder().encode('tampered') }, ip: '198.51.100.30' }))   // 409
    expect(calls).toEqual([])
  })
})
