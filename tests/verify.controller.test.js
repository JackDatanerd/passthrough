import { describe, it, expect, afterEach } from 'vitest'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'

const CODE = 'AB3XY7' // valid against SHORT_CODE_CHARS/SHORT_CODE_LENGTH

const DOCX_BYTES = new TextEncoder().encode('docx contents')
const PDF_BYTES = new TextEncoder().encode('pdf contents')
const OTHER_BYTES = new TextEncoder().encode('tampered contents')

function bucket(files) {
  // files: { [key]: Uint8Array | undefined }
  return {
    async get(key) {
      const bytes = files[key]
      if (!bytes) return null
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    },
  }
}

function kv() {
  const m = new Map()
  return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } }
}

async function seedRow(over = {}) {
  const docxHash = await sha256Bytes(DOCX_BYTES)
  const pdfHash = await sha256Bytes(PDF_BYTES)
  return {
    id: 'scan1',
    verification_code: CODE,
    candidate_first_name: 'Ada',
    ats_score: 60,
    fix_ats_score: 85,
    verified_at: new Date().toISOString(),
    role_category: 'ENGINEERING',
    seniority_level: 'SENIOR',
    verification_views: 0,
    resume_ats_path: 'ats/scan1.docx',
    resume_pdf_path: 'pdf/scan1.pdf',
    resume_hash: docxHash,
    resume_pdf_hash: pdfHash,
    resume_hash_history: [],
    verify_expose_docx: false,
    verify_expose_pdf: false,
    verify_hide_name: false,
    verification_status: 'ACTIVE',
    verification_revoked_at: null,
    user_id: null,
    ...over,
  }
}

function harness(row) {
  const world = createWorld({ scans: [row] })
  world.rpcs.increment_verification_views = () => ({ data: null, error: null })
  const pending = []
  const { mod, restore } = loadWithStubs('controllers/verify.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
  })
  function makeCtx({ files = {}, query = {} } = {}) {
    return {
      env: { RESUMES_BUCKET: bucket(files), RATE_LIMIT_KV: kv() },
      req: {
        param: () => CODE,
        query: k => query[k],
        header: () => '',
      },
      executionCtx: { waitUntil: p => pending.push(p) },
      header: () => {},
      json: (data, status = 200) => ({ status, data }),
      body: (data, status = 200) => ({ status, data }),
    }
  }
  return { mod, world, makeCtx, drain: () => Promise.all(pending), restore }
}

let t
afterEach(() => t?.restore())

describe('checkIntegrity / getVerification — PDF coverage (bug fix)', () => {
  it('reports "verified" when both the docx and the pdf match their stored hashes', async () => {
    const row = await seedRow()
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES, [row.resume_pdf_path]: PDF_BYTES } })
    const res = await t.mod.getVerification(c)
    await t.drain()
    expect(res.data.data.integrityStatus).toBe('verified')
    expect(res.data.data.verified).toBe(true)
  })

  it('reports "modified" when the docx matches but the PDF object has been tampered with', async () => {
    // This is exactly the bug: before the fix, checkIntegrity never looked at
    // the PDF at all, so this scenario read "verified".
    const row = await seedRow()
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES, [row.resume_pdf_path]: OTHER_BYTES } })
    const res = await t.mod.getVerification(c)
    await t.drain()
    expect(res.data.data.integrityStatus).toBe('modified')
    expect(res.data.data.verified).toBe(false)
  })

  it('reports "unknown" (not "verified") when the PDF is on file but missing from R2', async () => {
    const row = await seedRow()
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES /* no pdf key */ } })
    const res = await t.mod.getVerification(c)
    await t.drain()
    expect(res.data.data.integrityStatus).toBe('unknown')
    expect(res.data.data.verified).toBe(false)
  })

  it('still reports "verified" for a scan with no PDF on file at all (docx-only, legacy row)', async () => {
    const row = await seedRow({ resume_pdf_path: null, resume_pdf_hash: null })
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES } })
    const res = await t.mod.getVerification(c)
    await t.drain()
    expect(res.data.data.integrityStatus).toBe('verified')
    expect(res.data.data.verified).toBe(true)
  })
})

describe('fingerprintsFor — "current until" date on a superseded version (bug fix)', () => {
  // FIX (Section 7 audit): resume_hash_history entries store each old
  // version's OWN verified_at (when IT became current), not the date it was
  // superseded. The API's `fingerprints.previous[].at` — and the "current
  // until" copy on the Verify page — must report the LATTER: the moment a
  // reader's older file stopped being current. That's the next history
  // entry's `at` (or the row's own verified_at for the most recent
  // superseded entry), never the entry's own `at`.
  it('a single superseded version is "current until" the row\'s (current) verified_at, not its own verified_at', async () => {
    const oldDocxHash = await sha256Bytes(OTHER_BYTES)
    const oldAt = '2026-01-01T00:00:00.000Z'   // when the OLD version became current
    const currentAt = '2026-03-01T00:00:00.000Z' // when the CURRENT version took over (= when old was superseded)
    const row = await seedRow({
      verified_at: currentAt,
      resume_hash_history: [{ docx: oldDocxHash, pdf: null, at: oldAt }],
    })
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES, [row.resume_pdf_path]: PDF_BYTES } })
    const res = await t.mod.getVerification(c)
    await t.drain()
    const prev = res.data.data.fingerprints.previous.find(p => p.hash === oldDocxHash)
    expect(prev.kind).toBe('docx')
    expect(prev.at).toBe(currentAt)   // NOT oldAt — that's the bug this test guards against
  })

  it('with two superseded rounds, each is "current until" the NEXT round\'s at, not its own', async () => {
    const h1 = await sha256Bytes(new TextEncoder().encode('round 1 docx'))
    const h2 = await sha256Bytes(new TextEncoder().encode('round 2 docx'))
    const at1 = '2026-01-01T00:00:00.000Z'
    const at2 = '2026-02-01T00:00:00.000Z'
    const atCurrent = '2026-03-01T00:00:00.000Z'
    const row = await seedRow({
      verified_at: atCurrent,
      resume_hash_history: [
        { docx: h1, pdf: null, at: at1 },
        { docx: h2, pdf: null, at: at2 },
      ],
    })
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES, [row.resume_pdf_path]: PDF_BYTES } })
    const res = await t.mod.getVerification(c)
    await t.drain()
    const prevs = res.data.data.fingerprints.previous
    expect(prevs.find(p => p.hash === h1).at).toBe(at2)         // round 1 ended when round 2 started
    expect(prevs.find(p => p.hash === h2).at).toBe(atCurrent)   // round 2 ended when the current version started
  })

  it('a docx and pdf superseded in the SAME round share the same "current until" date', async () => {
    const oldDocx = await sha256Bytes(new TextEncoder().encode('old docx'))
    const oldPdf = await sha256Bytes(new TextEncoder().encode('old pdf'))
    const roundAt = '2026-01-01T00:00:00.000Z'
    const currentAt = '2026-03-01T00:00:00.000Z'
    const row = await seedRow({
      verified_at: currentAt,
      resume_hash_history: [{ docx: oldDocx, pdf: oldPdf, at: roundAt }],
    })
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES, [row.resume_pdf_path]: PDF_BYTES } })
    const res = await t.mod.getVerification(c)
    await t.drain()
    const prevs = res.data.data.fingerprints.previous
    expect(prevs.find(p => p.kind === 'docx').at).toBe(currentAt)
    expect(prevs.find(p => p.kind === 'pdf').at).toBe(currentAt)
  })

  it('falls back to null when neither a next round nor a row verified_at is available', async () => {
    const oldDocx = await sha256Bytes(new TextEncoder().encode('old docx'))
    const row = await seedRow({
      verified_at: null,
      resume_hash_history: [{ docx: oldDocx, pdf: null, at: '2026-01-01T00:00:00.000Z' }],
    })
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES, [row.resume_pdf_path]: PDF_BYTES } })
    const res = await t.mod.getVerification(c)
    await t.drain()
    expect(res.data.data.fingerprints.previous.find(p => p.hash === oldDocx).at).toBeNull()
  })
})

describe('getBadge — integrity-gated "Verified" claim (bug fix)', () => {
  it('shows the green "Verified" badge when score passes AND integrity checks out', async () => {
    const row = await seedRow()
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES, [row.resume_pdf_path]: PDF_BYTES } })
    const res = await t.mod.getBadge(c)
    expect(res.data).toContain('Passthrough Verified')
    expect(res.data).toContain('85/100')
    expect(res.data).toContain('#15803d') // green
  })

  it('does NOT claim "Verified" when the score passes but the stored file has been modified', async () => {
    // This is the bug: previously the badge keyed off score alone, so this
    // exact scenario rendered a green "Passthrough Verified" badge even
    // though the live page (getVerification) would say "Modified".
    const row = await seedRow()
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: OTHER_BYTES, [row.resume_pdf_path]: PDF_BYTES } })
    const res = await t.mod.getBadge(c)
    expect(res.data).not.toContain('Passthrough Verified')
    expect(res.data).toContain('scan 85/100')
    expect(res.data).toContain('#b45309') // amber
  })

  it('never runs the integrity check (no R2 read) for a below-threshold score', async () => {
    const row = await seedRow({ fix_ats_score: 50 })
    t = harness(row)
    // No files registered in the bucket — if getBadge tried to read R2 here
    // it would see a miss and this would still pass, so assert directly that
    // no R2 read was attempted.
    let reads = 0
    const c = t.makeCtx()
    c.env.RESUMES_BUCKET = { async get() { reads++; return null } }
    const res = await t.mod.getBadge(c)
    expect(res.data).toContain('scan 50/100')
    expect(reads).toBe(0)
  })

  it('shows "revoked" regardless of score or integrity', async () => {
    const row = await seedRow({ verification_status: 'REVOKED' })
    t = harness(row)
    const c = t.makeCtx({ files: { [row.resume_ats_path]: DOCX_BYTES, [row.resume_pdf_path]: PDF_BYTES } })
    const res = await t.mod.getBadge(c)
    expect(res.data).toContain('revoked')
    expect(res.data).not.toContain('Passthrough Verified')
  })
})
