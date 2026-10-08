import { describe, it, expect, afterEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createWorld } from './helpers/memoryDb.cjs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'

// Round-5 (fresh, independent) audit of Section 7 (Verify).

const CODE = 'AB3XY7K2PQ'
const DOCX = new TextEncoder().encode('docx contents')
const PDF  = new TextEncoder().encode('pdf contents')
const OLD_HASH = 'a'.repeat(64)

let t
afterEach(() => t?.restore())

// ── B1 ──────────────────────────────────────────────────────────────────────
// The old lookup passed a JS array of objects to .contains() on a jsonb column. Against the REAL
// supabase-js that is serialized as a Postgres array literal — `cs.{[object Object]}` — which
// Postgres rejects, so every lookup that did not match a CURRENT file threw. The in-memory test
// double accepted the array, which is why 60 verify tests passed with the endpoint broken. These
// tests drive the controller through the REAL client with a stand-in for PostgREST that, like
// Postgres, refuses malformed jsonb.
describe('ROUND-5 AUDIT FIX (bug, high): by-hash lookups of non-current files reach the database as valid jsonb', () => {
  function realClientHarness({ historyRows = {}, tombstoneHashes = {} } = {}) {
    const seen = []
    const fakeFetch = async (url) => {
      const u = decodeURIComponent(String(url).replace(/\+/g, ' '))
      seen.push(u)
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const hist = /resume_hash_history=cs\.(.*?)(?:&|$)/.exec(u)
      if (hist) {
        let operand
        try { operand = JSON.parse(hist[1]) } catch (_) { return json({ code: '22P02', message: 'invalid input syntax for type json' }, 400) }
        if (!Array.isArray(operand)) return json({ code: '22P02', message: 'malformed array literal' }, 400)
        const [kind, hash] = Object.entries(operand[0] || {})[0] || []
        const row = historyRows[`${kind}:${hash}`]
        return json(row ? [row] : [])
      }
      const tomb = /verification_tombstone_hashes\?.*hash=eq\.([a-f0-9]{64})/.exec(u)
      if (tomb) return json(tombstoneHashes[tomb[1]] ? [tombstoneHashes[tomb[1]]] : [])
      return json([])   // current-hash equality lookups: nothing
    }
    const real = createClient('https://x.supabase.co', 'k', { global: { fetch: fakeFetch }, auth: { persistSession: false } })
    const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => real } })
    const hdr = { 'cf-connecting-ip': '203.0.113.5', 'user-agent': 'Mozilla/5.0' }
    const ctx = hash => ({
      env: { NODE_ENV: 'production' },
      req: { param: () => hash, query: () => undefined, header: n => hdr[n.toLowerCase()] },
      header: () => {}, json: (d, s = 200) => ({ status: s, data: d }), body: d => d, get: () => null, executionCtx: { waitUntil() {} },
    })
    return { mod, restore, ctx, seen }
  }

  it('a superseded .docx is found through the history column', async () => {
    t = realClientHarness({ historyRows: { [`docx:${OLD_HASH}`]: { verification_code: CODE, verification_status: 'ACTIVE' } } })
    const r = await t.mod.lookupByHash(t.ctx(OLD_HASH))
    expect(r.status).toBe(200)
    expect(r.data.data).toMatchObject({ code: CODE, match: 'previous', kind: 'docx', revoked: false })
  })

  it('a superseded PDF is found too', async () => {
    t = realClientHarness({ historyRows: { [`pdf:${OLD_HASH}`]: { verification_code: CODE, verification_status: 'REVOKED' } } })
    const r = await t.mod.lookupByHash(t.ctx(OLD_HASH))
    expect(r.data.data).toMatchObject({ code: CODE, match: 'previous', kind: 'pdf', revoked: true })
  })

  it('an unknown file is a clean 404 NO_MATCH, not a thrown database error', async () => {
    t = realClientHarness()
    const r = await t.mod.lookupByHash(t.ctx('b'.repeat(64)))
    expect(r.status).toBe(404)
    expect(r.data.code).toBe('NO_MATCH')
  })

  it('the history queries go out as a JSON string operand — never `[object Object]`', async () => {
    t = realClientHarness()
    await t.mod.lookupByHash(t.ctx(OLD_HASH))
    const historyUrls = t.seen.filter(u => u.includes('resume_hash_history=cs.'))
    expect(historyUrls).toHaveLength(2)
    expect(historyUrls.some(u => u.includes('[object'))).toBe(false)
    expect(historyUrls[0]).toContain(`cs.[{"docx":"${OLD_HASH}"}]`)
    expect(historyUrls[1]).toContain(`cs.[{"pdf":"${OLD_HASH}"}]`)
  })

  it('a file from a DELETED page is now actually reachable: "removed", after the history lookups', async () => {
    t = realClientHarness({ tombstoneHashes: { [OLD_HASH]: { code: 'GONE99' } } })
    const r = await t.mod.lookupByHash(t.ctx(OLD_HASH))
    expect(r.status).toBe(200)
    expect(r.data.data).toMatchObject({ code: 'GONE99', match: 'removed', removed: true })
  })

  it('historyContains builds the operand as a string', async () => {
    const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => ({}) } })
    t = { restore }
    expect(mod.historyContains('docx', OLD_HASH)).toBe(`[{"docx":"${OLD_HASH}"}]`)
    expect(typeof mod.historyContains('pdf', OLD_HASH)).toBe('string')
  })

  it('the in-memory test double no longer accepts the array form that hid this bug', async () => {
    const world = createWorld({ scans: [{ id: 's', resume_hash_history: [{ docx: OLD_HASH }] }] })
    await expect(Promise.resolve(world.db.from('scans').select('id').contains('resume_hash_history', [{ docx: OLD_HASH }])))
      .rejects.toMatchObject({ code: '22P02' })
    const ok = await world.db.from('scans').select('id').contains('resume_hash_history', JSON.stringify([{ docx: OLD_HASH }]))
    expect(ok.data).toHaveLength(1)
  })
})

// ── B2 ──────────────────────────────────────────────────────────────────────
describe('ROUND-5 AUDIT FIX (bug): a live badge is held at the edge for 60s, not 300s', () => {
  const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } } }
  const bucket = files => ({ async get(k) { const b = files[k]; return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null } })
  function installCache() {
    const store = new Map(); const puts = []
    globalThis.caches = { default: {
      match: async req => { const r = store.get(req.url); return r ? r.clone() : undefined },
      put: async (req, res) => { puts.push({ url: req.url, res }); store.set(req.url, res.clone()) },
      delete: async req => store.delete(req.url),
    } }
    return { puts }
  }
  const hadCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  afterEach(() => { if (hadCaches) Object.defineProperty(globalThis, 'caches', hadCaches); else delete globalThis.caches })

  async function run(rowOver = {}, code = CODE) {
    const row = {
      id: 'scan1', verification_code: CODE, ats_score: 60, fix_ats_score: 85, resume_ats_path: 'd', resume_pdf_path: 'p',
      resume_hash: await sha256Bytes(DOCX), resume_pdf_hash: await sha256Bytes(PDF), verification_status: 'ACTIVE', ...rowOver,
    }
    const world = createWorld({ scans: [row] })
    t = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db } })
    const out = {}
    const hdr = { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 Chrome' }
    const c = {
      env: { RESUMES_BUCKET: bucket({ d: DOCX, p: PDF }), RATE_LIMIT_KV: kv(), NODE_ENV: 'production' },
      req: { param: () => code, query: () => undefined, header: n => hdr[n.toLowerCase()], url: 'https://api.example/x' },
      get: () => null, executionCtx: { waitUntil: () => {} },
      header: (k, v) => { out[k] = v }, json: (data, status = 200) => ({ status, data, headers: out }), body: (data, status = 200) => ({ status, data, headers: out }),
    }
    return t.mod.getBadge(c)
  }

  it('verified / scan / revoked badges are cached 60s at the edge', async () => {
    const { puts } = installCache()
    await run()
    expect(puts[0].res.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('a revoked badge is also 60s (it can be restored)', async () => {
    const { puts } = installCache()
    await run({ verification_status: 'REVOKED' })
    expect(puts[0].res.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('"not found" can never flip state, so it keeps the long TTL that absorbs scrapers', async () => {
    const { puts } = installCache()
    await run({}, 'ZZ3XY7K2PQ')
    expect(puts[0].res.headers.get('cache-control')).toBe('public, max-age=300')
  })

  it('the client-facing max-age is unchanged (<= 30s)', async () => {
    installCache()
    const r = await run()
    expect(r.headers['Cache-Control']).toBe('public, max-age=30')
  })
})

// ── B3 / B4 ─────────────────────────────────────────────────────────────────
describe('ROUND-5 AUDIT FIX (bug): adminBackfillPdfHashes', () => {
  const bucket = files => ({ get: async k => files[k] ? { arrayBuffer: async () => files[k].buffer.slice(files[k].byteOffset, files[k].byteOffset + files[k].byteLength) } : null })

  function setup(resolver, { purged = [] } = {}) {
    const db = createFakeSupabase(resolver)
    const { mod, restore } = loadWithStubs('controllers/admin.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'lib/badgeCache.js': { purgeBadgeCache: async code => { purged.push(code) }, badgeCache: () => null, badgeCacheKeyForCode: c => c },
    })
    const c = (over = {}) => ({
      env: over.env ?? {}, get: () => ({ id: 'admin-1' }),
      req: { query: () => undefined, param: () => 'id-1', json: async () => over.body ?? {} },
      json: (body, status = 200) => ({ body, status }),
    })
    return { mod, restore, c, db }
  }
  const audits = []
  const scanRows = n => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, resume_pdf_path: `p${i}.pdf`, verification_code: `CODE${i}` }))

  it('walks rows in id order and returns a cursor, so a row that can never be filled is passed over', async () => {
    const rows = scanRows(50)
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: rows, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 'x' }], error: null }
      if (q.table === 'admin_audit_log') return { data: null, error: null }
    })
    // every object missing from storage: nothing can be filled, yet the page must still advance
    const res = await t.mod.adminBackfillPdfHashes(t.c({ env: { RESUMES_BUCKET: bucket({}) } }))
    expect(res.body.data).toMatchObject({ checked: 50, filled: 0, missing: 50, remaining: true, nextAfter: rows[49].id })
    const sel = t.db.calls.find(c => c.table === 'scans' && c.op === 'select')
    expect(sel.orders).toEqual([['id', { ascending: true }]])
    expect(res.body.data.missingScanIds).toHaveLength(50)
  })

  it('the next call resumes after the cursor', async () => {
    const after = '00000000-0000-4000-8000-000000000049'
    t = setup(q => (q.table === 'scans' && q.op === 'select' ? { data: [], error: null } : undefined))
    const res = await t.mod.adminBackfillPdfHashes(t.c({ body: { after }, env: { RESUMES_BUCKET: bucket({}) } }))
    const sel = t.db.calls.find(c => c.table === 'scans' && c.op === 'select')
    expect(sel.filters).toContainEqual(['gt', 'id', after])
    expect(res.body.data).toMatchObject({ checked: 0, remaining: false, nextAfter: null })
  })

  it('ignores a malformed cursor instead of passing it to the database', async () => {
    t = setup(q => (q.table === 'scans' && q.op === 'select' ? { data: [], error: null } : undefined))
    await t.mod.adminBackfillPdfHashes(t.c({ body: { after: "x'; drop table scans" }, env: { RESUMES_BUCKET: bucket({}) } }))
    const sel = t.db.calls.find(c => c.table === 'scans' && c.op === 'select')
    expect(sel.filters.some(f => f[0] === 'gt')).toBe(false)
  })

  it('purges the cached badge of every page it fingerprints (partial -> verified changes the badge)', async () => {
    const purged = []
    const rows = scanRows(2)
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: rows, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 'x' }], error: null }
    }, { purged })
    await t.mod.adminBackfillPdfHashes(t.c({ env: { RESUMES_BUCKET: bucket({ 'p0.pdf': PDF, 'p1.pdf': PDF }) } }))
    expect(purged).toEqual(['CODE0', 'CODE1'])
  })

  it('does not purge a page whose fingerprint was filled by someone else first (update matched nothing)', async () => {
    const purged = []
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scanRows(1), error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [], error: null }
    }, { purged })
    const res = await t.mod.adminBackfillPdfHashes(t.c({ env: { RESUMES_BUCKET: bucket({ 'p0.pdf': PDF }) } }))
    expect(res.body.data.filled).toBe(0)
    expect(purged).toEqual([])
  })

  it('writes an audit entry with counts only, and none when there was nothing to do', async () => {
    const logged = []
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scanRows(2), error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 'x' }], error: null }
      if (q.table === 'admin_audit_log') { logged.push(q.values); return { data: null, error: null } }
    })
    await t.mod.adminBackfillPdfHashes(t.c({ env: { RESUMES_BUCKET: bucket({ 'p0.pdf': PDF }) } }))
    expect(logged).toEqual([{ actor_id: 'admin-1', action: 'verification.backfill_pdf_hashes', target_type: 'verification', target_id: null, detail: { checked: 2, filled: 1, missing: 1 } }])
    t.restore()

    const quiet = []
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: [], error: null }
      if (q.table === 'admin_audit_log') { quiet.push(q.values); return { data: null, error: null } }
    })
    await t.mod.adminBackfillPdfHashes(t.c({ env: { RESUMES_BUCKET: bucket({}) } }))
    expect(quiet).toEqual([])
  })
})

describe('ROUND-5 AUDIT FIX (feature gap): admin takedowns of public verification pages are audit-logged', () => {
  function setup(resolver) {
    const db = createFakeSupabase(resolver)
    const { mod, restore } = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const c = (over = {}) => ({
      env: {}, get: () => ({ id: 'admin-1' }),
      req: { query: () => undefined, param: () => over.param ?? 'scan-1', json: async () => over.body ?? {} },
      json: (body, status = 200) => ({ body, status }),
    })
    return { mod, restore, c }
  }

  it('revoke logs verification.revoke against the scan', async () => {
    const logged = []
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 'scan-1', verification_code: 'ABC123' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 'scan-1', verification_code: 'ABC123' }], error: null }
      if (q.table === 'admin_audit_log') { logged.push(q.values); return { data: null, error: null } }
    })
    await t.mod.adminSetVerification(t.c({ body: { action: 'revoke' } }))
    expect(logged).toEqual([{ actor_id: 'admin-1', action: 'verification.revoke', target_type: 'scan', target_id: 'scan-1', detail: {} }])
  })

  it('restore logs verification.restore', async () => {
    const logged = []
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 'scan-1', verification_code: 'ABC123' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 'scan-1', verification_code: 'ABC123' }], error: null }
      if (q.table === 'admin_audit_log') { logged.push(q.values); return { data: null, error: null } }
    })
    await t.mod.adminSetVerification(t.c({ body: { action: 'restore' } }))
    expect(logged.map(l => l.action)).toEqual(['verification.restore'])
  })

  it('a no-op (already revoked by the same reason) logs nothing', async () => {
    const logged = []
    t = setup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 'scan-1', verification_code: 'ABC123', verification_status: 'REVOKED', verification_revoked_reason: 'ADMIN' }, error: null }
      if (q.table === 'admin_audit_log') { logged.push(q.values); return { data: null, error: null } }
    })
    const res = await t.mod.adminSetVerification(t.c({ body: { action: 'revoke' } }))
    expect(res.body.data.changed).toBe(false)
    expect(logged).toEqual([])
  })

  it('banning a user logs how many pages were taken down — a count, never codes', async () => {
    const logged = []
    t = setup(q => {
      if (q.table === 'users' && q.op === 'select') return { data: { status: 'ACTIVE', role: 'SEEKER' }, error: null }
      if (q.table === 'users' && q.op === 'update') return { data: { id: 'u2', status: 'BANNED', role: 'SEEKER' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1', verification_code: 'AAA111' }, { id: 's2', verification_code: 'BBB222' }], error: null }
      if (q.table === 'admin_audit_log') { logged.push(q.values); return { data: null, error: null } }
    })
    await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { status: 'BANNED' } }))
    const entry = logged.find(l => l.action === 'user.verifications_revoked')
    expect(entry).toMatchObject({ target_type: 'user', target_id: 'u2', detail: { count: 2 } })
    expect(JSON.stringify(entry)).not.toMatch(/AAA111|BBB222/)
  })

  it('banning a user with no live pages adds no verification entry', async () => {
    const logged = []
    t = setup(q => {
      if (q.table === 'users' && q.op === 'select') return { data: { status: 'ACTIVE', role: 'SEEKER' }, error: null }
      if (q.table === 'users' && q.op === 'update') return { data: { id: 'u2', status: 'BANNED', role: 'SEEKER' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [], error: null }
      if (q.table === 'admin_audit_log') { logged.push(q.values); return { data: null, error: null } }
    })
    await t.mod.adminUpdateUser(t.c({ param: 'u2', body: { status: 'BANNED' } }))
    expect(logged.some(l => l.action.startsWith('user.verifications'))).toBe(false)
  })
})
