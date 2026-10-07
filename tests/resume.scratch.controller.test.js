import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

let t
afterEach(() => t?.restore())
let realErr; beforeEach(() => { realErr = console.error; console.error = () => {} }); afterEach(() => { console.error = realErr })

const validJd = 'A '.repeat(30) + 'valid job description with enough characters to pass the fifty character minimum.'
const DATA = { name: 'Jane Doe', email: 'jane@x.com', skills: ['Go'], experience: [{ company: 'Acme', title: 'Dev', bullets: ['Built'] }] }

describe('createScan — fill-it-in-myself (resumeDataJson)', () => {
  function csCtx(over = {}) {
    const sent = []
    return {
      env: { RESUMES_BUCKET: { put: async () => {}, delete: async () => {} }, FIX_QUEUE: { send: async m => { sent.push(m) } } },
      get: k => ({ uploadedFile: null, formFields: over.fields ?? {}, user: over.user }[k]),
      req: {}, json: (body, status = 200) => ({ body, status }),
      executionCtx: { waitUntil: p => p.catch(() => {}) }, __sent: sent,
    }
  }
  function setup() {
    const inserts = []
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'insert') { inserts.push(q.values); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'select') return { data: null, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [], error: null }
    })
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { isBypassed: () => false, anonScanSlotKey: () => 'rl:anonscan:test', refundAnonScanSlot: async () => {}, hitQuota: async () => true },
      'services/jd.parser.js': { fetchJobDescriptionFromUrl: async () => ({ success: true, text: 'F'.repeat(80) }) },
    })
    return { ...m, inserts, db }
  }
  const fields = (extra = {}) => ({ jobDescriptionText: validJd, resumeDataJson: JSON.stringify(DATA), contactName: 'Jane Doe', contactEmail: 'jane@x.com', ...extra })

  it('stores the typed data as the scan\'s structured resume, as a from-scratch scan', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: fields() }))
    expect(res.body.success).toBe(true)
    expect(t.inserts[0]).toMatchObject({ input_mode: 'brain_dump', original_resume_data: { name: 'Jane Doe', skills: ['Go'] } })
  })
  it('an empty form is a 400, never a scan that can only fail', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: fields({ resumeDataJson: JSON.stringify({ name: 'Jane' }) }) }))
    expect(res.status).toBe(400)
    expect(t.inserts).toHaveLength(0)
  })
  it('malformed JSON is a 400', async () => {
    t = setup()
    expect((await t.mod.createScan(csCtx({ fields: fields({ resumeDataJson: '{nope' }) }))).status).toBe(400)
  })
  it('cannot be combined with a pasted brain dump (two sources of truth)', async () => {
    t = setup()
    expect((await t.mod.createScan(csCtx({ fields: fields({ brainDumpText: 'x'.repeat(150) }) }))).status).toBe(400)
  })
})

describe('runAtsScan — from-scratch scans', () => {
  function setup(opts = {}) {
    const state = { updates: [], structured: [], refunds: [], scored: 0 }
    const scan = { id: 's1', input_mode: 'brain_dump', job_description_text: 'JD', user_id: opts.userId ?? null,
      created_at: opts.createdAt ?? new Date().toISOString(), raw_brain_dump_text: opts.raw ?? 'I did things. '.repeat(20),
      original_resume_data: opts.original ?? null, contact_name: opts.contactName ?? null, contact_email: opts.contactEmail ?? null }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: opts.userRow ?? null, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q); return { data: [{ id: 's1' }], error: null } }
    })
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { isBypassed: () => false, refundAnonScanSlot: async (_e, k) => { state.refunds.push(k) } },
      'services/resume.parser.js': {
        structureBrainDump: async (_env, raw, o) => { state.structured.push(o); return opts.structureResult ?? { resumeData: { name: null, email: null, skills: ['Go'], experience: [{ company: 'A', title: 'B', bullets: ['x'.repeat(40)] }] } } },
        serializeResumeData: d => `${d.name}\n` + 'filler line for the scorer\n'.repeat(20),
      },
      'services/ats.service.js': {
        scoreResume: () => { state.scored++; return { score: 70, keywordScore: 70, formatScore: 70, sectionsScore: 70, contentScore: 70, detail: {} } },
        detectRoleCategory: () => 'x', detectSeniority: () => 'mid',
      },
      'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: false }), extractJson: x => x },
      'services/email.service.js': {},
    })
    return { ...m, state, db, env: {} }
  }
  const persisted = (state) => state.updates.map(u => u.patch).find(p => p?.original_resume_data)

  it('the queue\'s long timeout reaches the structuring call; the fallback path keeps the default', async () => {
    t = setup()
    await t.mod.runAtsScan(t.env, t.db, 's1', null, { structureTimeoutMs: 90000 })
    expect(t.state.structured[0]).toEqual({ timeoutMs: 90000 })
    t.restore(); t = setup()
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.structured[0]).toEqual({})
  })
  it('data that was already structured (typed form / rescan / interrupted rerun) is not sent to the model again', async () => {
    t = setup({ original: { name: 'Typed Name', email: 'a@b.co', skills: ['Go'], experience: [{ company: 'A', title: 'B', bullets: ['x'.repeat(40)] }] } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.structured).toHaveLength(0)
    expect(persisted(t.state).original_resume_data.name).toBe('Typed Name')
  })
  it('an anonymous visitor\'s own name and email fill what the structuring left empty', async () => {
    t = setup({ contactName: 'Visitor V', contactEmail: 'v@x.com' })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(persisted(t.state).original_resume_data).toMatchObject({ name: 'Visitor V', email: 'v@x.com' })
  })
  it('a structuring failure gives the anonymous visitor their hourly slot back', async () => {
    t = setup({ structureResult: { resumeData: null, parseError: true, parseErrorMessage: 'Could not structure your background.' } })
    const out = await t.mod.runAtsScan(t.env, t.db, 's1', null, { anonRlKey: 'rl:anonscan:1.2.3.4' })
    expect(out.success).toBe(false)
    expect(t.state.refunds).toEqual(['rl:anonscan:1.2.3.4'])
  })
  it('"tell us more" (too little text) is the person\'s to fix: no refund', async () => {
    t = setup({ structureResult: { resumeData: null, parseError: true, parseErrorMessage: 'Please tell us more about your background.' } })
    await t.mod.runAtsScan(t.env, t.db, 's1', null, { anonRlKey: 'rl:anonscan:1.2.3.4' })
    expect(t.state.refunds).toEqual([])
  })
  it('no refund for a scan older than the limiter window, or when no key was passed', async () => {
    const fail = { resumeData: null, parseError: true, parseErrorMessage: 'Could not structure your background.' }
    t = setup({ structureResult: fail, createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() })
    await t.mod.runAtsScan(t.env, t.db, 's1', null, { anonRlKey: 'rl:anonscan:x' })
    expect(t.state.refunds).toEqual([])
    t.restore(); t = setup({ structureResult: fail })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.refunds).toEqual([])
  })
  it('once the scan has a result the pasted text is wiped from the row', async () => {
    t = setup()
    await t.mod.runAtsScan(t.env, t.db, 's1')
    const done = t.state.updates.map(u => u.patch).find(p => p?.status === 'COMPLETED' || p?.status === 'SCANNED' || 'raw_brain_dump_text' in (p || {}))
    expect(done).toBeTruthy()
    expect(done.raw_brain_dump_text).toBeNull()
  })
})

describe('downloadDraft / downloadDraftPdf', () => {
  function setup(opts = {}) {
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jané Doe', skills: ['Go'] } }
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: scan, error: null } : undefined))
    const headers = {}; let htmlSeen = null
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('docx') },
      'services/pdf.service.js': { generateResumePDF: async (_e, html) => { htmlSeen = html; if (opts.pdfFails) throw new Error('browser down'); return Buffer.from('%PDF') } },
    })
    const ctx = {
      env: {}, get: () => ({ id: 'u1', emailVerified: true }),
      req: { param: () => 's1', query: () => undefined },
      json: (body, status = 200) => ({ body, status }),
      header: (k, v) => { headers[k] = v }, body: b => ({ rawBody: b, status: 200 }),
    }
    return { ...m, ctx, headers, html: () => htmlSeen }
  }
  it('names the docx after the person, not "resume-draft"', async () => {
    t = setup()
    await t.mod.downloadDraft(t.ctx)
    expect(t.headers['Content-Disposition']).toBe('attachment; filename="jane-doe-resume-draft.docx"')
  })
  it('falls back to a plain name when there is none', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { skills: ['Go'] } } })
    await t.mod.downloadDraft(t.ctx)
    expect(t.headers['Content-Disposition']).toBe('attachment; filename="resume-draft.docx"')
  })
  it('serves the PDF, rendered from the draft with no credential line', async () => {
    t = setup()
    const res = await t.mod.downloadDraftPdf(t.ctx)
    expect(res.status).toBe(200)
    expect(t.headers['Content-Type']).toBe('application/pdf')
    expect(t.headers['Content-Disposition']).toMatch(/jane-doe-resume-draft\.pdf/)
    expect(t.html()).toContain('Doe')
  })
  it('a renderer outage is a friendly 502 that points at the docx', async () => {
    t = setup({ pdfFails: true })
    const res = await t.mod.downloadDraftPdf(t.ctx)
    expect(res.status).toBe(502)
    expect(res.body.message).toMatch(/docx/)
  })
  it('the PDF route keeps the same ownership and mode checks as the docx', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else' } })
    expect((await t.mod.downloadDraftPdf(t.ctx)).status).toBe(403)
    t.restore(); t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file' } })
    expect((await t.mod.downloadDraftPdf(t.ctx)).status).toBe(400)
  })
})

describe('dead-lettered anonymous from-scratch scan', () => {
  it('hands the visitor\'s hourly slot back (fresh scan, key present) but not for an old scan', async () => {
    const keys = []
    t = loadWithStubs('services/deadletter.service.js', { 'middleware/rateLimiter.js': { refundAnonScanSlot: async (_e, k) => { keys.push(k) } } })
    const run = async created => {
      const db = createFakeSupabase(q => (q.table === 'scans' && q.op === 'update') ? { data: [{ id: 's1', user_id: null, created_at: created }], error: null } : undefined)
      await t.mod.handleDeadLetterBatch({ messages: [{ body: { type: 'runAtsScan', scanId: 's1', anonRlKey: 'rl:anonscan:9.9.9.9' }, ack() {} }] }, {}, db, { sendOwnerAlert: async () => {} })
    }
    await run(new Date().toISOString())
    expect(keys).toEqual(['rl:anonscan:9.9.9.9'])
    keys.length = 0
    await run('2020-01-01T00:00:00Z')
    expect(keys).toEqual([])
  })
})
