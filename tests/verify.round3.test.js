import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'

// Round-3 (fresh, independent) audit of Section 7 (Verify).

const CODE = 'AB3XY7'
const DOCX = new TextEncoder().encode('docx contents')
const PDF  = new TextEncoder().encode('pdf contents')
// Mirrors BADGE_IP_QUOTA in verify.controller.js — not exported, so kept in
// step here rather than imported.
const BADGE_IP_QUOTA = 1200

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

describe('SECTION 7 AUDIT FIX (bug): badge cost quota respects RATE_LIMIT_BYPASS_IPS', () => {
  it('an IP over the badge cost quota is 429d — unless it is on the bypass list', async () => {
    t = harness(await seedRow())
    const ip = '198.51.100.20'
    // Pre-exhaust the quota directly (looping BADGE_IP_QUOTA times would work but is slow) —
    // same fixed-window shape consumeSlot itself writes.
    await t.KV.put(`rl:verifybadge:${ip}`, JSON.stringify({ count: BADGE_IP_QUOTA, windowStart: Date.now(), refunds: 0 }))

    const blocked = await t.mod.getBadge(t.ctx({ ip }))
    expect(blocked.status).toBe(429)

    // Every other verify limiter (isVerifyMissLimited included, a few lines below this
    // one in getBadge) already honors RATE_LIMIT_BYPASS_IPS — this quota was the one gap.
    const bypassed = await t.mod.getBadge(t.ctx({ ip, env: { RATE_LIMIT_BYPASS_IPS: ip } }))
    expect(bypassed.status).toBe(200)
    expect(bypassed.data).toContain('Passthrough Verified')
  })
})
