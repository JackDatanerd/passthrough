// Scan / ATS round 11: the failed-upgrade credit, the retry clock, the AI-less score, the silent no-op retry notice
// and the "rescan my improved version" input.
import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { scanRowToCamel, toClientScan } from '../src/lib/mappers.js'

let t
afterEach(() => { t?.restore?.(); t = null })

const aiOk = score => ({ success: true, data: { aiScore: score, missingKeywords: ['k8s'] } })

function load(stubs = {}, dbFn = () => undefined) {
  const rpcs = []
  const db = createFakeSupabase(q => { if (q.op === 'rpc') { rpcs.push([q.name, q.args]); return { data: true, error: null } } return dbFn(q) })
  const ai = { calls: 0, results: [] }
  const loaded = loadWithStubs('controllers/scan.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/claude.service.js': {
      scoreResumeWithAI: async () => { ai.calls++; const r = ai.results.length ? ai.results.shift() : { success: false }; if (r instanceof Error) throw r; return r },
      extractJson: x => (typeof x === 'string' ? JSON.parse(x) : x),
    },
    ...stubs,
  })
  return { ...loaded, db, rpcs, ai }
}

describe('B2 - the waiting screen counts from when THIS attempt began', () => {
  it('a retried scan reports the slot-spent time, not its original creation', () => {
    const row = { id: 's', created_at: '2026-10-01T00:00:00Z', scan_slot_spent_at: '2026-10-16T10:00:00Z' }
    expect(toClientScan(scanRowToCamel(row)).scanStartedAt).toBe('2026-10-16T10:00:00Z')
  })
  it('a scan never retried falls back to created_at; the server-only stamp itself stays private', () => {
    const out = toClientScan(scanRowToCamel({ id: 's', created_at: '2026-10-01T00:00:00Z' }))
    expect(out.scanStartedAt).toBe('2026-10-01T00:00:00Z')
    expect(out).not.toHaveProperty('scanSlotSpentAt')
    expect(out).not.toHaveProperty('upgradeCreditGrantedAt')
  })
})

describe('B1 - a failed Badge -> Fix upgrade has its own compensation', () => {
  it('an upgrade grant goes through grant_upgrade_credit_once, never the per-round marker the Badge already used', async () => {
    t = load()
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') { t.rpcs.push([q.name, q.args]); return { data: true, error: null } }
      return { data: { status: 'SUCCESS' }, error: null }
    })
    const ok = await t.mod.__test.grantFixCreditOnce({}, db, { id: 's1', userId: 'u1', fixPaymentId: null }, 0, 'upgrade soft failure', { upgrade: true })
    expect(ok).toBe(true)
    expect(t.rpcs.map(r => r[0])).toContain('grant_upgrade_credit_once')
    expect(t.rpcs.map(r => r[0])).not.toContain('grant_fix_credit_once')
  })
  it('a normal round still uses the per-round marker', async () => {
    t = load()
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') { t.rpcs.push([q.name, q.args]); return { data: true, error: null } }
      return { data: { status: 'SUCCESS' }, error: null }
    })
    await t.mod.__test.grantFixCreditOnce({}, db, { id: 's1', userId: 'u1', fixPaymentId: null }, 1, 'retries exhausted')
    expect(t.rpcs.map(r => r[0])).toContain('grant_fix_credit_once')
  })
})

describe('B3 - a score with no AI half cannot carry the credential', () => {
  it('a blended score is unchanged and flagged', () => {
    t = load()
    const r = t.mod.__test.blendAiScore(90, aiOk(90), 'x')
    expect(r.aiBlended).toBe(true)
    expect(r.finalScore).toBe(90)
    expect(r.aiMissingKeywords).toEqual(['k8s'])
  })
  it('an AI failure holds a high rule score just under the badge line (the pass line is untouched)', () => {
    t = load()
    const r = t.mod.__test.blendAiScore(95, { success: false }, 'x')
    expect(r.aiBlended).toBe(false)
    expect(r.finalScore).toBe(79)
    expect(t.mod.__test.blendAiScore(76, { success: false }, 'x').finalScore).toBe(76)
  })
  it('an unparseable AI reply is the same as no reply', () => {
    t = load()
    expect(t.mod.__test.blendAiScore(95, { success: true, data: { aiScore: 'high' } }, 'x')).toMatchObject({ aiBlended: false, finalScore: 79 })
  })
  it('the AI call gets one second chance, and stops as soon as it has a usable answer', async () => {
    t = load()
    t.ai.results = [{ success: false }, aiOk(80)]
    const r = await t.mod.__test.fetchAiScore({}, 'resume', 'jd', 'x')
    expect(t.ai.calls).toBe(2)
    expect(r.success).toBe(true)
    t.ai.calls = 0; t.ai.results = [aiOk(70)]
    await t.mod.__test.fetchAiScore({}, 'resume', 'jd', 'x')
    expect(t.ai.calls).toBe(1)
  })
  it('two failures return the failure (no throw) so the caller degrades', async () => {
    t = load()
    t.ai.results = [new Error('boom'), { success: false }]
    const r = await t.mod.__test.fetchAiScore({}, 'resume', 'jd', 'x')
    expect(r.success).toBe(false)
    expect(t.ai.calls).toBe(2)
  })
})

describe('gap - rescan the improved (delivered) version', () => {
  const validJd = 'A '.repeat(30) + 'valid job description with enough characters to pass the fifty character minimum.'
  const ORIGINAL = { name: 'Orig', email: 'o@x.com', skills: ['Go'] }
  const REWRITTEN = { name: 'Rewritten', email: 'o@x.com', skills: ['Go', 'Rust'] }
  const EDITED = { name: 'Edited', email: 'o@x.com', skills: ['Go', 'Rust', 'SQL'] }
  const SRC = '33333333-3333-3333-3333-333333333333'
  function ctxOf(fields) {
    return {
      env: { RESUMES_BUCKET: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }), put: async () => {}, delete: async () => {} }, FIX_QUEUE: { send: async () => {} } },
      get: k => ({ uploadedFile: null, formFields: fields, user: { id: 'u1', email: 'o@x.com', scansToday: 0, emailVerified: true } }[k]),
      req: {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: p => p.catch(() => {}) },
    }
  }
  function setup(srcOver = {}) {
    const inserts = []
    const src = { id: SRC, user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'FIX', input_mode: 'file', resume_path: 'k',
      resume_mime_type: 'application/pdf', original_resume_data: ORIGINAL, rewritten_resume_data: REWRITTEN, user_edited_resume_data: null, fix_payment_id: null, ...srcOver }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'insert') { inserts.push(q.values); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'select') return { data: src, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's' }], error: null }
      if (q.table === 'users') return { data: { scans_today: 1 }, error: null }
      return { data: { status: 'SUCCESS' }, error: null }
    })
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { isBypassed: () => false, anonScanSlotKey: () => 'k', refundAnonScanSlot: async () => {}, hitQuota: async () => true },
    })
    return { ...m, inserts, db }
  }
  const realErr = console.error
  afterEach(() => { console.error = realErr })

  it('scans the owner\'s edit when there is one, else the delivered rewrite - never the original upload, and never re-parses a file', async () => {
    console.error = () => {}
    // As stored in production: an owner's edit writes BOTH columns (round 16 - rewritten_resume_data is the delivered content).
    t = setup({ user_edited_resume_data: EDITED, rewritten_resume_data: EDITED })
    const res = await t.mod.createScan(ctxOf({ jobDescriptionText: validJd, sourceScanId: SRC, rescanVersion: 'delivered' }))
    expect(res.body.success).toBe(true)
    expect(t.inserts[0]).toMatchObject({ input_mode: 'saved_profile', original_resume_data: EDITED })
    expect(t.inserts[0].resume_path ?? null).toBeNull()
    t.restore(); t = setup()
    await t.mod.createScan(ctxOf({ jobDescriptionText: validJd, sourceScanId: SRC, rescanVersion: 'delivered' }))
    expect(t.inserts[0].original_resume_data).toEqual(REWRITTEN)
  })
  it('without the flag a file scan still rescans the original upload', async () => {
    console.error = () => {}
    t = setup()
    await t.mod.createScan(ctxOf({ jobDescriptionText: validJd, sourceScanId: SRC }))
    expect(t.inserts[0]).toMatchObject({ input_mode: 'file' })
  })
  it('is a 400 when there is no delivered version to use', async () => {
    console.error = () => {}
    t = setup({ status: 'COMPLETE_PASS', fix_purchased: false, rewritten_resume_data: null })
    const res = await t.mod.createScan(ctxOf({ jobDescriptionText: validJd, sourceScanId: SRC, rescanVersion: 'delivered' }))
    expect(res.status).toBe(400)
    expect(t.inserts).toHaveLength(0)
  })
})
