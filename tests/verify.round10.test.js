import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'
import { EXPOSED_HEADERS } from '../src/middleware/cors.js'

// Round-10 (fresh clone) audit of Section 7 (Verify).
const CODE = 'AB3XY7K2PQ'
const CODE2 = 'ZK4MN8PQ2R'
const DOCX = new TextEncoder().encode('docx contents')
const PDF  = new TextEncoder().encode('pdf contents')
const H = ch => ch.repeat(64)
const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

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

function harness(rows, { stubs = {} } = {}) {
  const world = createWorld({ scans: rows })
  world.rpcs.increment_verification_views = () => ({ data: null, error: null })
  const { mod, restore } = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db }, ...stubs })
  const KV = kv()
  const ctx = ({ code = CODE, ip = '203.0.113.9', ua = 'Mozilla/5.0 Chrome', query = {}, files = { d: DOCX, p: PDF }, body } = {}) => {
    const out = {}
    const hdr = { 'cf-connecting-ip': ip, 'user-agent': ua }
    return {
      env: { RESUMES_BUCKET: bucket(files), RATE_LIMIT_KV: KV, NODE_ENV: 'production', FRONTEND_URL: 'https://usepassthrough.com' },
      req: { method: 'GET', param: () => code, query: k => query[k], header: n => hdr[n.toLowerCase()], url: `https://api.example/api/verify/${code}`, json: async () => { if (body === undefined) throw new Error('no body'); return body } },
      get: () => null, executionCtx: { waitUntil: () => {} },
      header: (k, v) => { out[k] = v },
      json: (data, status = 200, h = {}) => ({ status, data, headers: { ...out, ...h } }),
      body: (data, status = 200) => ({ status, data, headers: out }),
    }
  }
  return { mod, world, ctx, restore }
}
let t
afterEach(() => t?.restore())

describe('B1: owner alerts are deduped per page, not per subject', () => {
  it('a missing-file alert carries a dedupeKey naming the page, so two pages are two alerts', async () => {
    const calls = []
    const stubs = { 'services/email.service.js': { sendOwnerAlert: async (_e, subject, body, opts) => { calls.push({ subject, body, opts }) } } }
    t = harness([await seedRow(), await seedRow({ id: 'scan2', verification_code: CODE2 })], { stubs })
    await t.mod.getVerification(t.ctx({ files: {}, ip: '198.51.100.5' }))
    await t.mod.getVerification(t.ctx({ code: CODE2, files: {}, ip: '198.51.100.6' }))
    expect(calls).toHaveLength(2)
    expect(calls[0].opts.dedupeKey).toContain(CODE)
    expect(calls[1].opts.dedupeKey).toContain(CODE2)
    expect(calls[0].opts.dedupeKey).not.toBe(calls[1].opts.dedupeKey)
  })
  it('a report alert carries a per-page dedupeKey too', async () => {
    const calls = []
    const stubs = { 'services/email.service.js': { sendOwnerAlert: async (_e, subject, body, opts) => { calls.push({ subject, opts }) }, sendVerificationReported: async () => {} } }
    t = harness([await seedRow(), await seedRow({ id: 'scan2', verification_code: CODE2 })], { stubs })
    t.world.t.verification_reports = t.world.t.verification_reports || []
    await t.mod.reportVerification(t.ctx({ body: { reason: 'FAKE' }, ip: '198.51.100.1' }))
    await t.mod.reportVerification(t.ctx({ code: CODE2, body: { reason: 'FAKE' }, ip: '198.51.100.2' }))
    const keys = calls.filter(c => c.subject === 'Verification page reported').map(c => c.opts && c.opts.dedupeKey)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })
})

describe('B2: a file hash that comes back is listed once, with its latest supersession', () => {
  it('history A, B, A with current C: A appears once, superseded at the current verified_at', async () => {
    t = harness([await seedRow({
      resume_hash: H('c'), resume_pdf_hash: null, verified_at: '2026-05-01T00:00:00Z',
      resume_hash_history: [{ docx: H('a'), at: '2026-01-01T00:00:00Z' }, { docx: H('b'), at: '2026-02-01T00:00:00Z' }, { docx: H('a'), at: '2026-03-01T00:00:00Z' }],
    })])
    const prev = (await t.mod.getVerification(t.ctx())).data.data.fingerprints.previous
    const aEntries = prev.filter(p => p.hash === H('a'))
    expect(aEntries).toHaveLength(1)
    expect(aEntries[0].at).toBe('2026-05-01T00:00:00Z')
    expect(prev.find(p => p.hash === H('b')).at).toBe('2026-03-01T00:00:00Z')
  })
  it('an ordinary history is unchanged', async () => {
    t = harness([await seedRow({
      resume_hash: H('c'), resume_pdf_hash: null, verified_at: '2026-05-01T00:00:00Z',
      resume_hash_history: [{ docx: H('a'), at: '2026-01-01T00:00:00Z' }, { docx: H('b'), at: '2026-02-01T00:00:00Z' }],
    })])
    const prev = (await t.mod.getVerification(t.ctx())).data.data.fingerprints.previous
    expect(prev).toEqual([{ kind: 'docx', hash: H('a'), at: '2026-02-01T00:00:00Z' }, { kind: 'docx', hash: H('b'), at: '2026-05-01T00:00:00Z' }])
  })
})

describe('B4: the download digest headers are readable by the SPA', () => {
  it.each(['X-Passthrough-SHA256', 'X-Passthrough-Integrity'])('exposes %s', h => {
    expect(EXPOSED_HEADERS).toContain(h)
  })
})

describe('admin report queue (source-level, like round 8)', () => {
  it('the server lists OPEN reports oldest first and closed ones newest first', () => {
    // Round 12: the original expression here was inverted (OPEN newest-first); behaviour is asserted in verify.round12.test.js.
    expect(read('../src/controllers/admin.controller.js')).toContain("ascending: status === 'OPEN'")
  })
  it('the panel refills after a review and stays visible while reports remain beyond the page', () => {
    const src = read('../frontend/src/pages/admin/VerificationReports.jsx')
    expect(src).toContain('await load(true)')
    expect(src).toContain('reports.length === 0 && total === 0')
    expect(src).not.toMatch(/if \(reports\.length === 0\) return null/)
  })
})

describe('Verify.jsx round-10 behaviour (source-level)', () => {
  const src = read('../frontend/src/pages/Verify.jsx')
  it('only the newest file check may write results or own the spinner', () => {
    expect(src).toContain('const checkSeq = useRef(0)')
    expect(src).toMatch(/mine === checkSeq\.current/)
    expect(src).toMatch(/checkSeq\.current\+\+; setChecking\(false\)/)   // a pasted fingerprint cancels a pending file check
  })
  it('files can be dropped on the check card, and files past the limit are announced', () => {
    expect(src).toContain('onDrop={handleDrop}')
    expect(src).toContain('picked.length > MAX_CHECK_FILES')
  })
  it('the score is green only when the page is verified, amber when it passed but the file did not check out', () => {
    expect(src).toContain("data.verified ? 'text-green-700' : data.passed ? 'text-amber-600' : 'text-red-600'")
  })
})
