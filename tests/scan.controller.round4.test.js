// Scan/ATS round 4 — controller behaviour: failure codes, retry/refund clock, the refunded-purchase guard,
// stale-checkout cleanup, personalised file names.
import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const HOUR = 3600_000
const todayUtc = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d }
const yesterday = () => new Date(todayUtc().getTime() - 6 * HOUR).toISOString()
const minutesAgo = m => new Date(Date.now() - m * 60_000).toISOString()

function ctxOf(env, over = {}) {
  return {
    env,
    get: k => (k === 'user' ? ('user' in over ? over.user : { id: 'u1', emailVerified: true }) : undefined),
    req: { param: () => 's1', query: k => (over.query ?? {})[k], header: () => undefined, json: async () => over.body ?? {} },
    header: () => undefined,
    executionCtx: { waitUntil: () => {} },
    json: (body, status = 200) => ({ body, status }),
  }
}
let t
afterEach(() => t?.restore())

// ── retry-scan ──────────────────────────────────────────────────────────────────────────────────────────
describe('retryScan: deterministic failures and the slot clock', () => {
  function setup(opts = {}) {
    const state = { updates: [], rpcs: [], queued: [] }
    const scan = { id: 's1', user_id: 'u1', status: 'ERROR', fix_purchased: false, input_mode: 'file', resume_path: 'r/1.pdf', created_at: yesterday(), full_ats_report: opts.report ?? null }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q); return { data: [{ id: 's1' }], error: null } }
      if (q.op === 'rpc') { state.rpcs.push(q.name); return { data: q.name === 'increment_scan_count_if_under_limit' ? true : true, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return { mod, restore, state, env: { FIX_QUEUE: { send: async m => { state.queued.push(m) } } } }
  }
  it.each(['NO_TEXT', 'ENCRYPTED_PDF', 'TOO_MANY_PAGES', 'TOO_SHORT', 'UNREADABLE_FILE'])('%s: 409, says what to do, spends nothing and queues nothing', async code => {
    t = setup({ report: { error: 'x', errorCode: code } })
    const res = await t.mod.retryScan(ctxOf(t.env))
    expect(res.status).toBe(409)
    expect(res.body.failure).toMatchObject({ code, retryable: false })
    expect(res.body.message.length).toBeGreaterThan(20)
    expect(t.state.rpcs).toEqual([])
    expect(t.state.queued).toEqual([])
    expect(t.state.updates).toEqual([])
  })
  it('a system failure (or one with no code) is still retryable', async () => {
    for (const report of [{ error: 'boom', errorCode: 'SYSTEM' }, { error: 'old row, no code' }, null]) {
      t = setup({ report })
      expect((await t.mod.retryScan(ctxOf(t.env))).status).toBe(200)
      t.restore()
    }
  })
  it('stamps when the NEW slot was spent, so a failed retry can be refunded', async () => {
    t = setup({ report: { errorCode: 'SYSTEM' } })
    await t.mod.retryScan(ctxOf(t.env))
    const stamp = t.state.updates.find(u => 'scan_slot_spent_at' in u.patch)
    expect(stamp).toBeTruthy()
    expect(Date.now() - Date.parse(stamp.patch.scan_slot_spent_at)).toBeLessThan(5000)
  })
  it('a missing scan_slot_spent_at column never breaks the retry', async () => {
    const state = { queued: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', user_id: 'u1', status: 'ERROR', fix_purchased: false, input_mode: 'file', resume_path: 'k' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return 'scan_slot_spent_at' in q.patch ? { data: null, error: { message: 'column "scan_slot_spent_at" does not exist' } } : { data: [{ id: 's1' }], error: null }
      if (q.op === 'rpc') return { data: true, error: null }
    })
    const m = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    t = m
    const res = await m.mod.retryScan(ctxOf({ FIX_QUEUE: { send: async x => { state.queued.push(x) } } }))
    expect(res.status).toBe(200)
    expect(state.queued).toHaveLength(1)
  })
})

describe('refund rules key on when the slot was spent, not when the scan was created', () => {
  function setup(anonSpy = []) {
    const rpcs = []
    const db = createFakeSupabase(q => { if (q.op === 'rpc') { rpcs.push([q.name, q.args]); return { data: true, error: null } } })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { refundAnonScanSlot: async (_e, k) => { anonSpy.push(k) }, anonScanSlotKey: () => 'k' },
    })
    return { mod, restore, db, rpcs, anonSpy }
  }
  it('an account scan CREATED yesterday but RETRIED today is refunded when the retry fails on our side', async () => {
    t = setup()
    await t.mod.__test.refundScanQuota(t.db, { userId: 'u1', createdAt: yesterday(), scanSlotSpentAt: minutesAgo(5) }, 'retry failed')
    expect(t.rpcs).toEqual([['decrement_scan_count', { p_user_id: 'u1' }]])
  })
  it('a slot spent yesterday is not refunded today (the daily counter has already reset)', async () => {
    t = setup()
    await t.mod.__test.refundScanQuota(t.db, { userId: 'u1', createdAt: yesterday(), scanSlotSpentAt: yesterday() }, 'x')
    await t.mod.__test.refundScanQuota(t.db, { userId: 'u1', createdAt: yesterday() }, 'x')   // no stamp: falls back to created_at
    expect(t.rpcs).toEqual([])
  })
  it('a scan created today and never retried is refunded exactly as before', async () => {
    t = setup()
    await t.mod.__test.refundScanQuota(t.db, { userId: 'u1', createdAt: minutesAgo(3) }, 'x')
    expect(t.rpcs).toHaveLength(1)
  })
  it('an anonymous scan created hours ago but retried a few minutes ago gets its hourly slot back', async () => {
    t = setup()
    await t.mod.__test.refundScanSlot({}, t.db, { userId: null, createdAt: minutesAgo(180), scanSlotSpentAt: minutesAgo(4) }, 'x', 'anon-key')
    expect(t.anonSpy).toEqual(['anon-key'])
  })
  it('an anonymous slot spent over 55 minutes ago is not handed back', async () => {
    t = setup()
    await t.mod.__test.refundScanSlot({}, t.db, { userId: null, createdAt: minutesAgo(180), scanSlotSpentAt: minutesAgo(70) }, 'x', 'anon-key')
    await t.mod.__test.refundScanSlot({}, t.db, { userId: null, createdAt: minutesAgo(180) }, 'x', 'anon-key')
    expect(t.anonSpy).toEqual([])
  })
})

// ── refunded / disputed purchases ───────────────────────────────────────────────────────────────────────
describe('a reversed purchase stops costing us calls', () => {
  const SCAN = { id: 's1', user_id: 'u1', fix_tier: 'FIX', status: 'FIX_DELIVERED', fix_purchased: true, fix_payment_id: 'p1', fix_ats_score: 60, fix_retry_count: 0, rewritten_resume_data: { name: 'J' }, job_description_text: 'j'.repeat(80) }
  function setup(paymentStatus, opts = {}) {
    const state = { rpcs: [], queued: [], alerts: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: opts.scan ?? SCAN, error: null }
      if (q.table === 'payments' && q.op === 'select') return opts.paymentsError ? { data: null, error: { message: 'db down' } } : { data: paymentStatus ? { status: paymentStatus } : null, error: null }
      if (q.op === 'rpc') { state.rpcs.push(q.name); return { data: q.name === 'increment_fix_retry_if_available' ? 1 : true, error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async (...a) => { state.alerts.push(a) } },
    })
    return { mod, restore, state, db, env: { FIX_QUEUE: { send: async m => { state.queued.push(m) } } } }
  }
  it.each(['REFUNDED', 'DISPUTED'])('retryFix is refused for a %s purchase — no retry is spent, nothing is queued', async status => {
    t = setup(status)
    const res = await t.mod.retryFix(ctxOf(t.env))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PURCHASE_REVERSED')
    expect(t.state.rpcs).toEqual([])
    expect(t.state.queued).toEqual([])
  })
  it('retryFix still works for a live purchase', async () => {
    t = setup('SUCCESS')
    expect((await t.mod.retryFix(ctxOf(t.env))).status).toBe(200)
    expect(t.state.queued).toHaveLength(1)
  })
  it('regenerating the PDF, writing a cover letter and editing the delivered resume are refused for a refunded purchase', async () => {
    for (const [fn, scan] of [
      ['regeneratePdf', SCAN],
      ['generateCoverLetter', SCAN],
      ['updateDeliveredResume', SCAN],
    ]) {
      t = setup('REFUNDED', { scan })
      const res = await t.mod[fn](ctxOf(t.env, { body: { resumeData: { name: 'J', summary: 'x'.repeat(30) } } }))
      expect(res.status, fn).toBe(403)
      expect(res.body.code, fn).toBe('PURCHASE_REVERSED')
      t.restore()
    }
  })
  it('fails OPEN: a payment row that cannot be read never punishes the customer for our outage', async () => {
    t = setup('SUCCESS', { paymentsError: true })
    expect(await t.mod.__test.purchaseIsLive(t.db, SCAN_CAMEL())).toBe(true)
    t.restore(); t = setup(null)
    expect(await t.mod.__test.purchaseIsLive(t.db, SCAN_CAMEL())).toBe(true)
    expect(await t.mod.__test.purchaseIsLive(t.db, { fixPaymentId: null })).toBe(true)
  })
  it('the compensating free credit is NOT granted for a refunded purchase (refund AND credit)', async () => {
    t = setup('REFUNDED')
    expect(await t.mod.__test.grantFixCreditOnce({}, t.db, SCAN_CAMEL(), 0, 'retries exhausted')).toBe(false)
    expect(t.state.rpcs).not.toContain('grant_fix_credit_once')
  })
  it('the credit is still granted for a live purchase', async () => {
    t = setup('SUCCESS')
    expect(await t.mod.__test.grantFixCreditOnce({}, t.db, SCAN_CAMEL(), 0, 'retries exhausted')).toBe(true)
    expect(t.state.rpcs).toContain('grant_fix_credit_once')
  })
})
function SCAN_CAMEL() { return { id: 's1', userId: 'u1', fixPaymentId: 'p1' } }

// ── delete ──────────────────────────────────────────────────────────────────────────────────────────────
describe('deleteScan closes a stale checkout instead of leaving it payable', () => {
  function setup() {
    const state = { payments: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', updated_at: new Date(Date.now() - 5 * HOUR).toISOString(), resume_path: 'r/1.pdf' }, error: null }
      if (q.table === 'payments' && q.op === 'select') return { count: 0, error: null }
      if (q.table === 'payments') { state.payments.push(q); return { data: [{ id: 'p-old', referral_reservation_id: null }], error: null } }
      if (q.table === 'scans' && q.op === 'delete') return { data: { id: 's1' }, error: null }
      if (q.op === 'rpc') return { data: true, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return { mod, restore, state, env: { RESUMES_BUCKET: { delete: async () => {} } } }
  }
  it('moves any older PENDING payment for the scan to ABANDONED before deleting, and touches nothing else', async () => {
    t = setup()
    expect((await t.mod.deleteScan(ctxOf(t.env))).status).toBe(200)
    expect(t.state.payments).toHaveLength(1)
    expect(t.state.payments[0].patch).toEqual({ status: 'ABANDONED' })
    expect(t.state.payments[0].filters).toEqual(expect.arrayContaining([['eq', 'scan_id', 's1'], ['eq', 'status', 'PENDING']]))
  })
})

// ── file names and failure payloads ─────────────────────────────────────────────────────────────────────
describe('delivered file names', () => {
  const stem = n => loadStem(n)
  function loadStem(name) {
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {})
    const out = mod.__test.deliveredFileStem({ name }); restore(); return out
  }
  it.each([
    ['Jane Doe', 'Jane-Doe-Resume'],
    ['  Jane   O\'Neil-Smith ', 'Jane-O-Neil-Smith-Resume'],
    ['José Núñez', 'Jose-Nunez-Resume'],
    ['张伟', 'Resume'],
    ['', 'Resume'],
    [undefined, 'Resume'],
    ['A'.repeat(80), `${'A'.repeat(40)}-Resume`],
  ])('%j -> %s', (name, expected) => expect(stem(name)).toBe(expected))
  it('never produces a path separator or quote, whatever the name holds', () => {
    expect(stem('../../etc/passwd"; rm -rf')).toMatch(/^[A-Za-z0-9-]+$/)
  })
  it('the download uses the candidate\'s name for both the .docx and the .pdf', async () => {
    const headers = {}
    const db = createFakeSupabase(q => q.table === 'scans' ? { data: { id: 's1', user_id: 'u1', fix_purchased: true, resume_ats_path: 'a', resume_pdf_path: 'p', rewritten_resume_data: { name: 'Jane Doe' } }, error: null } : undefined)
    const m = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    t = m
    for (const [type, ext] of [['ats', 'docx'], ['pdf', 'pdf']]) {
      const ctx = { ...ctxOf({ RESUMES_BUCKET: { get: async () => ({ body: 'x' }) } }, { query: { type } }), header: (k, v) => { headers[k] = v }, body: b => ({ streamed: b }) }
      await m.mod.downloadFile(ctx)
      expect(headers['Content-Disposition']).toBe(`attachment; filename="Jane-Doe-Resume.${ext}"`)
    }
  })
})

describe('failure payload', () => {
  it('only an ERROR scan has one; the code decides retryable', () => {
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {})
    t = { restore }
    const f = mod.__test.buildFailure
    expect(f({ errorCode: 'NO_TEXT' }, 'COMPLETE_PASS')).toBe(null)
    expect(f(null, 'ERROR')).toMatchObject({ code: 'SYSTEM', retryable: true })
    expect(f({ errorCode: 'ENCRYPTED_PDF' }, 'ERROR')).toMatchObject({ code: 'ENCRYPTED_PDF', retryable: false })
    expect(f({ errorCode: 'NEEDS_MORE_DETAIL', error: 'Add the name of your last employer.' }, 'ERROR').message).toBe('Add the name of your last employer.')
    expect(f({ errorCode: 'STRUCTURE_FAILED', error: 'Could not structure (x)' }, 'ERROR').message).not.toMatch(/Could not structure \(x\)/)
  })
})
