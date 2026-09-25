import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// SECTION 12 AUDIT: scan.controller.js (1,772 lines, 22 functions) had ZERO
// test coverage — the single largest gap in the backend, and the file that
// runs the actual product (scan -> fix -> credit/retry -> verification).
// This batch covers the request-scoped handlers that don't need the
// background-job machinery mocked out: initiateFix, redeemCredit, retryFix,
// updateVerifyVisibility, downloadFile, getScanHistory. redeemCredit and
// retryFix get the closest look — both are atomic-RPC, credit-spending
// flows with an explicit compensating-refund path on failure, exactly the
// shape of bug (money/credits vanishing on a transient error) a test can
// catch that manual QA won't.

function baseCtx(over = {}) {
  const queueSent = []
  return {
    env: { FIX_QUEUE: { send: async m => { if (over.queueThrows) throw over.queueThrows; queueSent.push(m) } }, PAYSTACK_CURRENCY: 'USD', ...over.env },
    get: k => (k === 'user' ? (over.user ?? { id: 'u1', emailVerified: true }) : undefined),
    req: {
      param: () => over.param ?? 's1',
      query: k => (over.query ?? {})[k],
      json: async () => over.body ?? {},
    },
    json: (body, status = 200) => ({ body, status }),
    header: () => {},
    body: b => ({ rawBody: b }),
    __queueSent: queueSent,
  }
}
let t
afterEach(() => t?.restore())

describe('initiateFix', () => {
  function setup(opts) {
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: opts.scan ?? null, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/referral.service.js': { resolvePrice: async () => opts.priced ?? { amount: 1900, currency: 'USD', referralApplied: false } },
    })
    return { mod, restore, db }
  }

  it('403s when the scan belongs to someone else', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else', status: 'COMPLETE_PASS' } })
    const res = await t.mod.initiateFix(baseCtx({ body: { fixTier: 'FIX' } }))
    expect(res.status).toBe(403)
  })

  it('400s when the scan is not yet complete', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'SCANNING' } })
    const res = await t.mod.initiateFix(baseCtx({ body: { fixTier: 'FIX' } }))
    expect(res.status).toBe(400)
  })

  it('400s when already purchased', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: true } })
    const res = await t.mod.initiateFix(baseCtx({ body: { fixTier: 'FIX' } }))
    expect(res.status).toBe(400)
  })

  it('400s a BADGE request below the badge threshold', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', ats_score: 79 } })
    const res = await t.mod.initiateFix(baseCtx({ body: { fixTier: 'BADGE' } }))
    expect(res.status).toBe(400)
  })

  it('allows a BADGE request exactly at the threshold', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', ats_score: 80 }, priced: { amount: 3900, currency: 'USD', referralApplied: false } })
    const res = await t.mod.initiateFix(baseCtx({ body: { fixTier: 'BADGE' } }))
    expect(res.body.success).toBe(true)
  })

  it('rejects an invalid fixTier', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS' } })
    await expect(t.mod.initiateFix(baseCtx({ body: { fixTier: 'GOLD' } }))).rejects.toThrow()
  })
})

describe('redeemCredit', () => {
  function setup(opts = {}) {
    const state = { paymentInserts: [], scanUpdates: [], refundCalls: [], alerts: [], paymentFailUpdates: [] }
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: false }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.op === 'rpc' && q.name === 'redeem_free_fix_credit') return { data: opts.redeemed ?? true, error: opts.redeemErr || null }
      if (q.op === 'rpc' && q.name === 'increment_free_fix_credits') { state.refundCalls.push(q.args); return { data: true, error: opts.refundErr || null } }
      if (q.table === 'payments' && q.op === 'insert') { state.paymentInserts.push(q.values); return { data: { id: 'pay1' }, error: opts.paymentInsertErr || null } }
      if (q.table === 'payments' && q.op === 'update') { state.paymentFailUpdates.push(q.patch); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'update') { state.scanUpdates.push(q); return { data: opts.claimed ?? [{ id: 's1' }], error: opts.claimErr || null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async (...a) => { state.alerts.push(a) } },
    })
    return { mod, restore, state, db }
  }

  it('403s for someone else\'s scan, and never spends a credit', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else', status: 'COMPLETE_PASS' } })
    const res = await t.mod.redeemCredit(baseCtx())
    expect(res.status).toBe(403)
    expect(t.db.calls.some(c => c.op === 'rpc')).toBe(false)
  })

  it('400s when already purchased, before spending a credit', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', fix_purchased: true } })
    const res = await t.mod.redeemCredit(baseCtx())
    expect(res.status).toBe(400)
    expect(t.db.calls.some(c => c.op === 'rpc')).toBe(false)
  })

  it('400s with no credits available', async () => {
    t = setup({ redeemed: false })
    const res = await t.mod.redeemCredit(baseCtx())
    expect(res.status).toBe(400)
    expect(t.state.paymentInserts).toHaveLength(0)
  })

  it('happy path: records a $0 payment, claims the scan, enqueues the fix job', async () => {
    t = setup()
    const ctx = baseCtx()
    const res = await t.mod.redeemCredit(ctx)
    expect(res.body.success).toBe(true)
    // AUDIT FIX (Section 3/4 pass, bug): fix_tier must be set on the credit
    // payment row itself, not just the scans row — see the matching comment
    // in scan.controller.js. Regression test for getPaymentHistory/
    // PaymentHistory.jsx showing "—" instead of "Fix + Credential".
    expect(t.state.paymentInserts[0]).toMatchObject({ amount_cents: 0, status: 'SUCCESS', fix_tier: 'FIX', scan_id: 's1', user_id: 'u1' })
    expect(t.state.scanUpdates[0].patch).toMatchObject({ fix_purchased: true, status: 'FIX_PURCHASED', fix_tier: 'FIX' })
    // the claim guard: must be scoped to fix_purchased still being false
    expect(t.state.scanUpdates[0].filters.some(f => f[0] === 'eq' && f[1] === 'fix_purchased' && f[2] === false)).toBe(true)
    expect(ctx.__queueSent).toEqual([{ type: 'generateFix', scanId: 's1' }])
  })

  it('lost claim (concurrent purchase): fails the $0 payment row, refunds the credit, still throws', async () => {
    t = setup({ claimed: [] })   // the atomic claim UPDATE won nothing
    await expect(t.mod.redeemCredit(baseCtx())).rejects.toThrow()
    expect(t.state.paymentFailUpdates).toEqual([{ status: 'FAILED' }])
    expect(t.state.refundCalls).toEqual([{ p_user_id: 'u1' }])
  })

  it('queue failure after a WON claim: refunds the credit but does NOT fail the $0 payment row (it is the scan\'s real owning payment)', async () => {
    t = setup()
    await expect(t.mod.redeemCredit(baseCtx({ queueThrows: new Error('queue down') }))).rejects.toThrow('queue down')
    expect(t.state.paymentFailUpdates).toHaveLength(0)
    expect(t.state.refundCalls).toEqual([{ p_user_id: 'u1' }])
  })

  it('refund itself failing sends an owner alert but still throws the original error', async () => {
    t = setup({ claimed: [] , refundErr: new Error('refund rpc down') })
    await expect(t.mod.redeemCredit(baseCtx())).rejects.toThrow('Scan was purchased concurrently')
    expect(t.state.alerts.length).toBe(1)
    expect(t.state.alerts[0][1]).toMatch(/refund failed/i)
  })
})

describe('retryFix', () => {
  function setup(opts = {}) {
    const state = { revertCalls: 0, alerts: [] }
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', fix_tier: 'FIX', status: 'FIX_DELIVERED', fix_ats_score: 60, fix_retry_count: 0 }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.op === 'rpc' && q.name === 'increment_fix_retry_if_available') return { data: 'newRetryCount' in opts ? opts.newRetryCount : 1, error: opts.rpcErr || null }
      if (q.op === 'rpc' && q.name === 'revert_fix_retry') { state.revertCalls++; return { data: true, error: opts.revertErr || null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async (...a) => { state.alerts.push(a) } },
    })
    return { mod, restore, state, db }
  }

  it('403s for a scan owned by someone else', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else' } })
    expect((await t.mod.retryFix(baseCtx())).status).toBe(403)
  })

  it('400s for a BADGE-tier scan (no rewrite to retry)', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', fix_tier: 'BADGE', status: 'FIX_DELIVERED' } })
    expect((await t.mod.retryFix(baseCtx())).status).toBe(400)
  })

  it('400s when the fix has not finished generating yet', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', fix_tier: 'FIX', status: 'FIX_GENERATING' } })
    expect((await t.mod.retryFix(baseCtx())).status).toBe(400)
  })

  it('400s when the fix already reached the badge threshold', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', fix_tier: 'FIX', status: 'FIX_DELIVERED', fix_ats_score: 80, fix_retry_count: 0 } })
    expect((await t.mod.retryFix(baseCtx())).status).toBe(400)
  })

  it('400s when retries are exhausted', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', fix_tier: 'FIX', status: 'FIX_DELIVERED', fix_ats_score: 60, fix_retry_count: 2 } })
    expect((await t.mod.retryFix(baseCtx())).status).toBe(400)
  })

  it('400s (a distinct, race-specific message) when the atomic RPC reports -1', async () => {
    t = setup({ newRetryCount: -1 })
    const res = await t.mod.retryFix(baseCtx())
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/already be in progress/i)
  })

  it('happy path: enqueues and reports retries remaining from MAX_FIX_RETRIES minus the new count', async () => {
    t = setup({ newRetryCount: 1 })
    const ctx = baseCtx()
    const res = await t.mod.retryFix(ctx)
    expect(res.body.success).toBe(true)
    expect(res.body.data.retriesRemaining).toBe(1)   // MAX_FIX_RETRIES(2) - 1
    expect(ctx.__queueSent).toEqual([{ type: 'generateFix', scanId: 's1' }])
  })

  it('queue failure after the RPC already spent a retry: reverts, still throws', async () => {
    t = setup({ newRetryCount: 1 })
    await expect(t.mod.retryFix(baseCtx({ queueThrows: new Error('queue down') }))).rejects.toThrow('queue down')
    expect(t.state.revertCalls).toBe(1)
  })

  it('revert ALSO failing sends an owner alert but still throws the original queue error', async () => {
    t = setup({ newRetryCount: 1, revertErr: new Error('revert rpc down') })
    await expect(t.mod.retryFix(baseCtx({ queueThrows: new Error('queue down') }))).rejects.toThrow('queue down')
    expect(t.state.alerts.length).toBe(1)
    expect(t.state.alerts[0][1]).toMatch(/enqueue and revert both failed/i)
  })
})

describe('updateVerifyVisibility', () => {
  function setup(opts = {}) {
    const state = { updates: [] }
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', verification_code: 'ABC123', verification_status: 'ACTIVE' }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q.patch); return { data: null, error: opts.updateErr || null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'lib/verification.js': {
        revokeVerification: async (...a) => { state.revokeArgs = a; return opts.revoked ?? true },
        restoreVerification: async (...a) => { state.restoreArgs = a; return opts.restored ?? true },
        REVOKE_REASON: { OWNER: 'OWNER', REFUND: 'REFUND', DISPUTE: 'DISPUTE', ADMIN: 'ADMIN' },
      },
    })
    return { mod, restore, state, db }
  }

  it('403s for someone else\'s scan', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else' } })
    expect((await t.mod.updateVerifyVisibility(baseCtx())).status).toBe(403)
  })

  it('400s when the scan has no verification page yet', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', verification_code: null } })
    expect((await t.mod.updateVerifyVisibility(baseCtx({ body: { exposeDocx: true } }))).status).toBe(400)
  })

  it('400s an empty/no-op body', async () => {
    t = setup()
    expect((await t.mod.updateVerifyVisibility(baseCtx({ body: {} }))).status).toBe(400)
  })

  it('updates only the fields actually present as booleans', async () => {
    t = setup()
    await t.mod.updateVerifyVisibility(baseCtx({ body: { exposeDocx: true, hideName: 'not-a-bool' } }))
    expect(t.state.updates[0]).toEqual({ verify_expose_docx: true })
  })

  it('published:false revokes with reason OWNER', async () => {
    t = setup()
    const res = await t.mod.updateVerifyVisibility(baseCtx({ body: { published: false } }))
    expect(t.state.revokeArgs[2]).toBe('OWNER')
    expect(res.body.data.verificationStatus).toBe('REVOKED')
    expect(res.body.data.published).toBe(false)
  })

  it('published:true on a revoked page attempts an owner-scoped restore', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', verification_code: 'ABC123', verification_status: 'REVOKED' } })
    const res = await t.mod.updateVerifyVisibility(baseCtx({ body: { published: true } }))
    expect(t.state.restoreArgs).toBeTruthy()
    expect(res.body.data.verificationStatus).toBe('ACTIVE')
  })

  it('403s with a specific message when restore fails (revoked by something other than the owner)', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', verification_code: 'ABC123', verification_status: 'REVOKED' }, restored: false })
    const res = await t.mod.updateVerifyVisibility(baseCtx({ body: { published: true } }))
    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/cannot be republished/i)
  })

  // ROUND-2 AUDIT FIX under test: a refused republish must change nothing —
  // previously the visibility flags in the SAME request body were written
  // before the republish was decided, so a 403 here could still silently
  // flip exposeDocx/exposePdf live.
  it('a refused republish (restore fails) writes NOTHING — visibility flags in the same request are not persisted as a side effect', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', verification_code: 'ABC123', verification_status: 'REVOKED' }, restored: false })
    const res = await t.mod.updateVerifyVisibility(baseCtx({ body: { published: true, exposeDocx: true, exposePdf: true } }))
    expect(res.status).toBe(403)
    expect(t.state.updates).toHaveLength(0)
  })

  it('published:true on an already-ACTIVE page is a no-op restore call (status stays ACTIVE, no error)', async () => {
    t = setup()   // verification_status: 'ACTIVE'
    const res = await t.mod.updateVerifyVisibility(baseCtx({ body: { published: true } }))
    expect(t.state.restoreArgs).toBeUndefined()
    expect(res.body.data.verificationStatus).toBe('ACTIVE')
  })
})

describe('downloadFile', () => {
  function setup(opts = {}) {
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', fix_purchased: true, resume_ats_path: 'ats-key', resume_pdf_path: 'pdf-key' }
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: scan, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return { mod, restore }
  }

  it('403s for someone else\'s scan', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else' } })
    const res = await t.mod.downloadFile(baseCtx({ query: { type: 'pdf' } }))
    expect(res.status).toBe(403)
  })

  it('403s when the fix was never purchased', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', fix_purchased: false } })
    const res = await t.mod.downloadFile(baseCtx({ query: { type: 'pdf' } }))
    expect(res.status).toBe(403)
  })

  it('403s with an EMAIL_NOT_VERIFIED code when the user has not verified their email', async () => {
    t = setup()
    const res = await t.mod.downloadFile(baseCtx({ query: { type: 'pdf' }, user: { id: 'u1', emailVerified: false } }))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED')
  })

  it('404s when the requested file is not ready (no path on the scan)', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', fix_purchased: true, resume_pdf_path: null } })
    const res = await t.mod.downloadFile(baseCtx({ query: { type: 'pdf' } }))
    expect(res.status).toBe(404)
  })

  it('404s when the path exists but the R2 object does not', async () => {
    t = setup()
    const ctx = baseCtx({ query: { type: 'pdf' }, env: { RESUMES_BUCKET: { get: async () => null } } })
    const res = await t.mod.downloadFile(ctx)
    expect(res.status).toBe(404)
  })

  it('serves the ATS docx vs the verified PDF based on ?type=', async () => {
    t = setup()
    let requestedKey = null
    const ctx = baseCtx({ query: { type: 'ats' }, env: { RESUMES_BUCKET: { get: async key => { requestedKey = key; return { body: 'filedata' } } } } })
    await t.mod.downloadFile(ctx)
    expect(requestedKey).toBe('ats-key')
  })

  // ROUND-2 AUDIT FIX under test: any type other than the two valid ones
  // used to silently fall through to the PDF branch instead of rejecting.
  it('400s an invalid ?type= instead of silently falling through to the PDF branch', async () => {
    t = setup()
    const res = await t.mod.downloadFile(baseCtx({ query: { type: 'exe' } }))
    expect(res.status).toBe(400)
  })
})

describe('getScanHistory', () => {
  function setup(rows, count = 0, over = {}) {
    const db = createFakeSupabase(q => {
      if (q.table !== 'scans') return undefined
      if (q.selectOpts?.head) return { count: over.total ?? count, error: null }
      if (over.rangeError) return { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' } }
      return { data: rows, error: null, count }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return { mod, restore, db }
  }

  it('scopes to the requesting user and maps rows to camelCase with pagination', async () => {
    t = setup([{ id: 's1', status: 'COMPLETE_PASS', ats_score: 80, passed: true, resume_original_name: 'r.pdf', input_mode: 'FILE', created_at: 't', fix_purchased: false, fix_tier: null, verification_code: null, verification_status: null, fix_ats_score: null, keyword_score: 1, format_score: 1, sections_score: 1, content_score: 1 }], 1)
    const res = await t.mod.getScanHistory(baseCtx({ query: { page: '1', limit: '10' } }))
    expect(res.body.data.scans[0]).toMatchObject({ id: 's1', atsScore: 80 })
    expect(res.body.data.total).toBe(1)
    const call = t.db.calls.find(c => c.table === 'scans')
    expect(call.filters.find(f => f[0] === 'eq')).toEqual(['eq', 'user_id', 'u1'])
  })

  it('clamps limit to MAX_SCAN_HISTORY_LIMIT (100) regardless of what is requested', async () => {
    t = setup([], 0)
    await t.mod.getScanHistory(baseCtx({ query: { limit: '999999' } }))
    const call = t.db.calls.find(c => c.table === 'scans')
    expect(call.range).toEqual([0, 99])
  })

  it('clamps page to at least 1', async () => {
    t = setup([], 0)
    await t.mod.getScanHistory(baseCtx({ query: { page: '-5', limit: '10' } }))
    const call = t.db.calls.find(c => c.table === 'scans')
    expect(call.range).toEqual([0, 9])
  })

  it('ignores an unrecognized status value', async () => {
    t = setup([], 0)
    await t.mod.getScanHistory(baseCtx({ query: { status: 'NOT_REAL' } }))
    const call = t.db.calls.find(c => c.table === 'scans')
    expect(call.filters.some(f => f[1] === 'status')).toBe(false)
  })

  it('applies a valid status filter', async () => {
    t = setup([], 0)
    await t.mod.getScanHistory(baseCtx({ query: { status: 'FIX_DELIVERED' } }))
    const call = t.db.calls.find(c => c.table === 'scans')
    expect(call.filters.find(f => f[1] === 'status')[2]).toBe('FIX_DELIVERED')
  })

  it('a page past the end is an empty page with the real total, not a 500', async () => {
    t = setup([], 0, { rangeError: true, total: 7 })
    const res = await t.mod.getScanHistory(baseCtx({ query: { page: '9', limit: '10', status: 'FIX_DELIVERED' } }))
    expect(res.body.data.scans).toEqual([])
    expect(res.body.data.total).toBe(7)
    const head = t.db.calls.find(c => c.selectOpts?.head)
    expect(head.filters.find(f => f[0] === 'eq' && f[1] === 'user_id')[2]).toBe('u1')
    expect(head.filters.find(f => f[1] === 'status')[2]).toBe('FIX_DELIVERED')
  })

  it('breaks created_at ties by id so a row cannot land on two pages or none', async () => {
    t = setup([], 0)
    await t.mod.getScanHistory(baseCtx({}))
    expect(t.db.calls.find(c => c.table === 'scans').orders.map(o => o[0])).toEqual(['created_at', 'id'])
  })

  it('sanitizes the search term before building the .or() filter', async () => {
    t = setup([], 0)
    await t.mod.getScanHistory(baseCtx({ query: { search: 'jo,(hn' } }))
    const call = t.db.calls.find(c => c.table === 'scans')
    const orExpr = (call.or || []).join(',')
    expect(orExpr).toContain('%john%')
    expect(orExpr).not.toContain('(hn')
  })
})

describe('deleteScan', () => {
  const HOUR = 3600_000
  function setup(opts = {}) {
    const r2 = { deleted: [], failOn: opts.r2Fail }
    const state = { deleted: 0, profileUpdates: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', updated_at: new Date(Date.now() - 5 * HOUR).toISOString(), resume_path: 'r/1.pdf', resume_ats_path: 'r/1-ats.docx', resume_pdf_path: 'r/1.out.pdf' }, error: null }
      if (q.table === 'payments') return { count: opts.pendingPayments ?? 0, error: null }
      if (q.table === 'scans' && q.op === 'delete') { state.deleted++; return { data: opts.deleteReturnsNothing ? null : { id: 's1' }, error: opts.deleteError || null } }
      if (q.table === 'users' && q.op === 'select') return { data: { saved_profile: opts.savedProfile ?? null }, error: null }
      if (q.table === 'users' && q.op === 'update') { state.profileUpdates.push(q.patch); return { error: null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const ctx = () => baseCtx({ env: { RESUMES_BUCKET: { delete: async k => { if (r2.failOn === k) throw new Error('r2 down'); r2.deleted.push(k) } } } })
    return { mod, restore, db, r2, state, ctx }
  }

  it('deletes the row scoped to the owner, then every R2 object stored for it', async () => {
    t = setup()
    const res = await t.mod.deleteScan(t.ctx())
    expect(res).toEqual({ body: { success: true, message: 'Scan deleted.' }, status: 200 })
    const del = t.db.calls.find(c => c.table === 'scans' && c.op === 'delete')
    expect(del.filters.filter(f => f[0] === 'eq')).toEqual([['eq', 'id', 's1'], ['eq', 'user_id', 'u1']])
    expect(t.r2.deleted.sort()).toEqual(['r/1-ats.docx', 'r/1.out.pdf', 'r/1.pdf'])
  })
  it('404s a scan that is not yours exactly like one that does not exist, touching nothing', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else', status: 'COMPLETE_PASS', updated_at: '2020-01-01' } })
    expect((await t.mod.deleteScan(t.ctx())).status).toBe(404)
    t.restore(); t = setup({ scan: null })
    expect((await t.mod.deleteScan(t.ctx())).status).toBe(404)
    expect(t.state.deleted).toBe(0)
    expect(t.r2.deleted).toEqual([])
  })
  it('409s while a job is still working on the scan, but not once it has been silent for an hour', async () => {
    for (const status of ['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING']) {
      t = setup({ scan: { id: 's1', user_id: 'u1', status, updated_at: new Date().toISOString(), resume_path: 'r' } })
      const res = await t.mod.deleteScan(t.ctx())
      expect(res.status, status).toBe(409)
      expect(t.state.deleted).toBe(0)
      t.restore()
    }
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'SCANNING', updated_at: new Date(Date.now() - 2 * HOUR).toISOString(), resume_path: 'r' } })
    expect((await t.mod.deleteScan(t.ctx())).status).toBe(200)
  })
  it('409s while a payment for the scan is in flight', async () => {
    t = setup({ pendingPayments: 1 })
    expect((await t.mod.deleteScan(t.ctx())).status).toBe(409)
    expect(t.state.deleted).toBe(0)
  })
  it('a paid scan can be deleted — the receipt survives via payments.scan_id on delete set null', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, verification_code: 'ABC', updated_at: '2020-01-01', resume_path: 'r/1.pdf' } })
    expect((await t.mod.deleteScan(t.ctx())).status).toBe(200)
    expect(t.db.calls.some(c => c.table === 'payments' && c.op !== 'select')).toBe(false)
  })
  it('a failing R2 delete never fails the request or skips the other objects', async () => {
    t = setup({ r2Fail: 'r/1-ats.docx' })
    const res = await t.mod.deleteScan(t.ctx())
    expect(res.status).toBe(200)
    expect(t.r2.deleted.sort()).toEqual(['r/1.out.pdf', 'r/1.pdf'])
  })
  it('a database error deleting the row propagates and no file is removed', async () => {
    t = setup({ deleteError: { message: 'db down' } })
    await expect(t.mod.deleteScan(t.ctx())).rejects.toBeTruthy()
    expect(t.r2.deleted).toEqual([])
  })
  it('clears the saved profile\'s source-scan pointer only when it pointed at this scan, keeping the profile itself', async () => {
    const profile = { resumeData: { name: 'J' }, sourceScanId: 's1', savedAt: 't' }
    t = setup({ savedProfile: profile })
    await t.mod.deleteScan(t.ctx())
    expect(t.state.profileUpdates).toEqual([{ saved_profile: { ...profile, sourceScanId: null } }])
    t.restore(); t = setup({ savedProfile: { ...profile, sourceScanId: 'other' } })
    await t.mod.deleteScan(t.ctx())
    expect(t.state.profileUpdates).toEqual([])
  })
})
// ─── Batch 2: getScanStatus, getScan, updateResumeData, downloadDraft ─────

describe('getScanStatus', () => {
  function setup(scan) {
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: scan, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return { mod, restore }
  }

  it('404s for an unknown scan', async () => {
    t = setup(null)
    expect((await t.mod.getScanStatus(baseCtx())).status).toBe(404)
  })

  it('403s a logged-in non-owner', async () => {
    t = setup({ id: 's1', user_id: 'someone-else', anon_token: null })
    expect((await t.mod.getScanStatus(baseCtx({ user: { id: 'u1' } }))).status).toBe(403)
  })

  it('403s an anonymous caller with a wrong/missing token', async () => {
    t = setup({ id: 's1', user_id: null, anon_token: 'real-token-123' })
    const res = await t.mod.getScanStatus(baseCtx({ user: null, query: { token: 'wrong' } }))
    expect(res.status).toBe(403)
  })

  it('allows the anon owner with the correct token', async () => {
    t = setup({ id: 's1', user_id: null, anon_token: 'real-token-123', status: 'SCANNING' })
    const res = await t.mod.getScanStatus(baseCtx({ user: null, query: { token: 'real-token-123' } }))
    expect(res.body.success).toBe(true)
  })

  it('computes badgeEligible from atsScore without persisting it, and is null when unscored', async () => {
    t = setup({ id: 's1', user_id: 'u1', ats_score: null, status: 'SCANNING' })
    const res = await t.mod.getScanStatus(baseCtx())
    expect(res.body.data.badgeEligible).toBe(null)
    t.restore()

    t = setup({ id: 's1', user_id: 'u1', ats_score: 80, status: 'COMPLETE_PASS' })
    const res2 = await t.mod.getScanStatus(baseCtx())
    expect(res2.body.data.badgeEligible).toBe(true)
  })
})

describe('getScan', () => {
  function setup(scan) {
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: scan, error: null } : undefined))
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return { mod, restore }
  }

  it('404s for an unknown scan', async () => {
    t = setup(null)
    expect((await t.mod.getScan(baseCtx())).status).toBe(404)
  })

  it('403s a non-owner', async () => {
    t = setup({ id: 's1', user_id: 'someone-else' })
    expect((await t.mod.getScan(baseCtx({ user: { id: 'u1' } }))).status).toBe(403)
  })

  it('never leaks internal-only fields (resumePath, resumeAtsPath, resumePdfPath, resumeHashHistory, fixPaymentId, fullAtsReport)', async () => {
    t = setup({ id: 's1', user_id: 'u1', resume_path: 'internal/key', resume_ats_path: 'k1', resume_pdf_path: 'k2', resume_hash_history: ['h1'], fix_payment_id: 'pay1', full_ats_report: { keywords: {} }, ats_score: 80 })
    const res = await t.mod.getScan(baseCtx())
    const keys = Object.keys(res.body.data)
    expect(keys).not.toContain('resumePath')
    expect(keys).not.toContain('resumeAtsPath')
    expect(keys).not.toContain('resumePdfPath')
    expect(keys).not.toContain('resumeHashHistory')
    expect(keys).not.toContain('fixPaymentId')
    expect(keys).not.toContain('fullAtsReport')
  })

  it('reshapes fullAtsReport into atsDetail, or null when the report itself is an error placeholder', async () => {
    t = setup({ id: 's1', user_id: 'u1', full_ats_report: { keywords: { matched: ['x'], missing: ['y'] }, aiMissingKeywords: ['z'] } })
    const res = await t.mod.getScan(baseCtx())
    expect(res.body.data.atsDetail.keywords).toEqual({ matched: ['x'], missing: ['y'] })
    expect(res.body.data.atsDetail.aiMissingKeywords).toEqual(['z'])
    t.restore()

    t = setup({ id: 's1', user_id: 'u1', full_ats_report: { error: 'scoring failed' } })
    const res2 = await t.mod.getScan(baseCtx())
    expect(res2.body.data.atsDetail).toBe(null)
  })
})

describe('updateResumeData', () => {
  function setup(opts = {}) {
    const state = { updates: [] }
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', input_mode: 'brain_dump', status: 'COMPLETE_PASS', fix_purchased: false, job_description_text: 'JD text' }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q.patch); return { data: null, error: opts.updateErr || null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('fake-docx') },
      'services/resume.parser.js': { extractText: async () => 'x'.repeat(150), serializeResumeData: () => 'synthetic' },
      'services/ats.service.js': { scoreResume: () => (opts.ruleResult ?? { score: 70, keywordScore: 70, formatScore: 70, sectionsScore: 70, contentScore: 70, detail: { keywords: {} } }) },
      'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: false }), extractJson: x => x },
    })
    return { mod, restore, state }
  }

  it('403s a non-owner', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else' } })
    expect((await t.mod.updateResumeData(baseCtx({ body: { resumeData: {} } }))).status).toBe(403)
  })

  it('400s for a file-mode scan (only brain_dump/saved_profile supported)', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file' } })
    expect((await t.mod.updateResumeData(baseCtx({ body: { resumeData: {} } }))).status).toBe(400)
  })

  it('400s when the scan is not yet complete', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', status: 'SCANNING' } })
    expect((await t.mod.updateResumeData(baseCtx({ body: { resumeData: {} } }))).status).toBe(400)
  })

  it('400s once a fix has been purchased', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', status: 'COMPLETE_PASS', fix_purchased: true } })
    expect((await t.mod.updateResumeData(baseCtx({ body: { resumeData: {} } }))).status).toBe(400)
  })

  it('400s on oversized resumeData', async () => {
    t = setup()
    const huge = { name: 'x'.repeat(200_000) }
    expect((await t.mod.updateResumeData(baseCtx({ body: { resumeData: huge } }))).status).toBe(400)
  })

  it('400s on a shape that fails the schema (wrong type for a field)', async () => {
    t = setup()
    expect((await t.mod.updateResumeData(baseCtx({ body: { resumeData: { name: 12345 } } }))).status).toBe(400)
  })

  it('persists the corrected data plus a fresh rescore, and reports COMPLETE_PASS/FAIL from the new score', async () => {
    t = setup({ ruleResult: { score: 85, keywordScore: 85, formatScore: 85, sectionsScore: 85, contentScore: 85, detail: { keywords: { matched: ['x'] } } } })
    const res = await t.mod.updateResumeData(baseCtx({ body: { resumeData: { name: 'Jane' } } }))
    expect(res.body.success).toBe(true)
    expect(res.body.data.atsScore).toBe(85)
    expect(res.body.data.status).toBe('COMPLETE_PASS')
    expect(res.body.data.badgeEligible).toBe(true)
    expect(t.state.updates[0]).toMatchObject({ ats_score: 85, status: 'COMPLETE_PASS', original_resume_data: { name: 'Jane' } })
  })

  it('a below-threshold rescore reports COMPLETE_FAIL', async () => {
    t = setup({ ruleResult: { score: 50, keywordScore: 50, formatScore: 50, sectionsScore: 50, contentScore: 50, detail: {} } })
    const res = await t.mod.updateResumeData(baseCtx({ body: { resumeData: { name: 'Jane' } } }))
    expect(res.body.data.status).toBe('COMPLETE_FAIL')
    expect(t.state.updates[0].status).toBe('COMPLETE_FAIL')
  })
})

describe('downloadDraft', () => {
  function setup(opts = {}) {
    const scan = 'scan' in opts ? opts.scan : { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' } }
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: scan, error: null } : undefined))
    let generateArgs = null
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/docx.service.js': { generateAtsDocx: async (...a) => { generateArgs = a; return Buffer.from('fake-docx') } },
    })
    return { mod, restore, getGenerateArgs: () => generateArgs }
  }

  it('403s a non-owner', async () => {
    t = setup({ scan: { id: 's1', user_id: 'someone-else' } })
    expect((await t.mod.downloadDraft(baseCtx())).status).toBe(403)
  })

  it('400s for a file-mode scan', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file' } })
    expect((await t.mod.downloadDraft(baseCtx())).status).toBe(400)
  })

  it('404s when there is no resume data on the scan yet', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: null } })
    expect((await t.mod.downloadDraft(baseCtx())).status).toBe(404)
  })

  it('generates the docx from original_resume_data with no verification URL (never credentialed)', async () => {
    t = setup()
    await t.mod.downloadDraft(baseCtx())
    expect(t.getGenerateArgs()).toEqual([{ name: 'Jane' }, null])
  })
})

// ─── createScan ─────────────────────────────────────────────────────────

describe('createScan', () => {
  function csCtx(over = {}) {
    const waitUntilPromises = []
    const bucketOps = []
    return {
      env: { RESUMES_BUCKET: { put: async (...a) => bucketOps.push({ op: 'put', a }), delete: async (...a) => bucketOps.push({ op: 'delete', a }) }, ...over.env },
      get: k => ({ uploadedFile: over.file, formFields: over.fields ?? {}, user: over.user, authError: over.authError }[k]),
      req: {},
      json: (body, status = 200) => ({ body, status }),
      executionCtx: over.noExecCtx ? undefined : { waitUntil: p => { waitUntilPromises.push(p); p.catch(() => {}) } },
      __waitUntilPromises: waitUntilPromises,
      __bucketOps: bucketOps,
    }
  }

  function setup(opts = {}) {
    const state = { inserts: [], rpcCalls: [], userUpdates: [] }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc' && q.name === 'increment_scan_count_if_under_limit') { state.rpcCalls.push(q); return { data: opts.quotaAllowed ?? true, error: opts.quotaErr || null } }
      if (q.op === 'rpc' && q.name === 'decrement_scan_count') { state.rpcCalls.push(q); return { data: true, error: null } }
      if (q.table === 'users' && q.op === 'select') return { data: opts.savedProfileRow ?? { saved_profile: { resumeData: { name: 'Jane' } } }, error: null }
      if (q.table === 'users' && q.op === 'update') { state.userUpdates.push(q.patch); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'insert') { state.inserts.push(q.values); return { data: null, error: opts.insertErr || null } }
    })
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { isBypassed: () => opts.bypassed ?? false },
      'services/jd.parser.js': { fetchJobDescriptionFromUrl: async () => opts.jdFetch ?? { success: false, message: 'fetch disabled in test' } },
    })
    return { mod, restore, state, db }
  }

  const validJd = 'A '.repeat(30) + 'valid job description with enough characters to pass the fifty character minimum.'
  const validBrainDump = 'x'.repeat(150)

  it('400s with no input mode at all', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: { jobDescriptionText: validJd } }))
    expect(res.status).toBe(400)
    expect(t.state.inserts).toHaveLength(0)
  })

  it('400s when more than one input mode is present (file + brain dump)', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ file: { mimetype: 'application/pdf', bytes: new Uint8Array(), originalname: 'r.pdf' }, fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } }))
    expect(res.status).toBe(400)
    expect(t.state.inserts).toHaveLength(0)
  })

  it('401s a saved-profile request with no logged-in user', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: { useSavedProfile: 'true', jobDescriptionText: validJd } }))
    expect(res.status).toBe(401)
  })

  it('503s when auth lookup itself failed, rather than silently treating the request as anonymous', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ authError: 'unavailable', fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } }))
    expect(res.status).toBe(503)
    expect(t.state.inserts).toHaveLength(0)
  })

  it('400s when the job description is too short', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: { brainDumpText: validBrainDump, jobDescriptionText: 'too short' } }))
    expect(res.status).toBe(400)
  })

  it('400s when a JD URL fetch is blocked (SSRF-style guard upstream)', async () => {
    t = setup({ jdFetch: { blocked: true, message: 'That URL cannot be fetched.' } })
    const res = await t.mod.createScan(csCtx({ fields: { brainDumpText: validBrainDump, jobDescriptionUrl: 'http://evil.internal' } }))
    expect(res.status).toBe(400)
    expect(res.body.blocked).toBe(true)
  })

  it('400s when the brain-dump text is below the minimum length', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: { brainDumpText: 'too short', jobDescriptionText: validJd } }))
    expect(res.status).toBe(400)
  })

  it('400s an anonymous brain-dump submission with an invalid contact email', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd, contactEmail: 'not-an-email' } }))
    expect(res.status).toBe(400)
  })

  it('400s useSavedProfile when the user has none saved', async () => {
    t = setup({ savedProfileRow: { saved_profile: null } })
    const res = await t.mod.createScan(csCtx({ user: { id: 'u1' }, fields: { useSavedProfile: 'true', jobDescriptionText: validJd } }))
    expect(res.status).toBe(400)
    expect(t.state.inserts).toHaveLength(0)
  })

  it('logged-in happy path: inserts with user_id set and anon_token null, triggers the background scan', async () => {
    t = setup()
    const ctx = csCtx({ user: { id: 'u1' }, fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } })
    const res = await t.mod.createScan(ctx)
    expect(res.body.success).toBe(true)
    expect(res.body.data.anonToken).toBe(null)
    expect(t.state.inserts[0]).toMatchObject({ user_id: 'u1', anon_token: null, input_mode: 'brain_dump' })
    expect(ctx.__waitUntilPromises).toHaveLength(1)
  })

  it('anonymous happy path: generates an anon_token, sets an expiry, returns the token to the caller', async () => {
    t = setup()
    const res = await t.mod.createScan(csCtx({ fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } }))
    expect(res.body.success).toBe(true)
    expect(typeof res.body.data.anonToken).toBe('string')
    expect(t.state.inserts[0].user_id).toBe(null)
    expect(t.state.inserts[0].anon_token).toBe(res.body.data.anonToken)
    expect(t.state.inserts[0].anon_expires_at).toBeTruthy()
  })

  it('429s over quota when not on a bypass IP, without ever inserting a scan', async () => {
    t = setup({ quotaAllowed: false, bypassed: false })
    const res = await t.mod.createScan(csCtx({ user: { id: 'u1' }, fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } }))
    expect(res.status).toBe(429)
    expect(t.state.inserts).toHaveLength(0)
  })

  it('a bypass IP over quota gets a manually-granted slot and still proceeds', async () => {
    t = setup({ quotaAllowed: false, bypassed: true })
    const res = await t.mod.createScan(csCtx({ user: { id: 'u1' }, fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } }))
    expect(res.body.success).toBe(true)
    expect(t.state.userUpdates[0]).toEqual({ scans_today: 3 })
  })

  it('a failed insert after quota was consumed rolls the quota back via decrement_scan_count', async () => {
    t = setup({ quotaAllowed: true, insertErr: new Error('insert boom') })
    await expect(t.mod.createScan(csCtx({ user: { id: 'u1' }, fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } }))).rejects.toThrow('insert boom')
    expect(t.state.rpcCalls.some(c => c.name === 'decrement_scan_count')).toBe(true)
  })

  it('a failed insert after a manually-granted bypass slot ALSO rolls back (the fix under audit)', async () => {
    t = setup({ quotaAllowed: false, bypassed: true, insertErr: new Error('insert boom') })
    await expect(t.mod.createScan(csCtx({ user: { id: 'u1' }, fields: { brainDumpText: validBrainDump, jobDescriptionText: validJd } }))).rejects.toThrow('insert boom')
    expect(t.state.rpcCalls.some(c => c.name === 'decrement_scan_count')).toBe(true)
  })

  it('a failed insert after a file was already written to R2 cleans the object up', async () => {
    t = setup({ insertErr: new Error('insert boom') })
    const ctx = csCtx({ user: { id: 'u1' }, file: { mimetype: 'application/pdf', bytes: new Uint8Array([1]), originalname: 'r.pdf' }, fields: { jobDescriptionText: validJd } })
    await expect(t.mod.createScan(ctx)).rejects.toThrow('insert boom')
    expect(ctx.__bucketOps.some(o => o.op === 'put')).toBe(true)
    expect(ctx.__bucketOps.some(o => o.op === 'delete')).toBe(true)
  })

  it('file-mode inserts resume_path/resume_original_name/resume_mime_type and never touches raw_brain_dump_text', async () => {
    t = setup()
    await t.mod.createScan(csCtx({ user: { id: 'u1' }, file: { mimetype: 'application/pdf', bytes: new Uint8Array([1]), originalname: 'resume.pdf' }, fields: { jobDescriptionText: validJd } }))
    expect(t.state.inserts[0]).toMatchObject({ input_mode: 'file', resume_original_name: 'resume.pdf', resume_mime_type: 'application/pdf' })
    expect(t.state.inserts[0].raw_brain_dump_text).toBeUndefined()
  })

  it('saved-profile mode never trusts a client-supplied resumeData — it always re-fetches from the DB', async () => {
    t = setup({ savedProfileRow: { saved_profile: { resumeData: { name: 'Server Truth' } } } })
    await t.mod.createScan(csCtx({ user: { id: 'u1' }, fields: { useSavedProfile: 'true', jobDescriptionText: validJd, resumeData: { name: 'Client Lie' } } }))
    expect(t.state.inserts[0].original_resume_data).toEqual({ name: 'Server Truth' })
  })
})

// ─── runAtsScan (background job — exported for webhook/payments/cron too) ─

describe('runAtsScan', () => {
  function setup(opts = {}) {
    const state = { scanUpdates: [], emails: [] }
    const scan = 'scan' in opts ? opts.scan : { id: 's1', input_mode: 'file', resume_path: 'r-key', resume_mime_type: 'application/pdf', job_description_text: 'JD', user_id: null }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.scanUpdates.push(q.patch); return { data: opts.updateFails ? null : [{ id: 's1' }], error: opts.updateFails ? new Error('save boom') : null } }
      if (q.table === 'users' && q.op === 'select') return { data: opts.userRow ?? { id: 'u1', name: 'Jane', email: 'jane@x.com' }, error: null }
    })
    const env = { RESUMES_BUCKET: { get: async () => ('r2Object' in opts ? opts.r2Object : { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) } }
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': {
        extractText: async () => opts.extractedText ?? 'x'.repeat(150),
        structureBrainDump: async () => opts.brainDumpResult ?? { resumeData: { name: 'Jane', email: 'jane@x.com' }, parseError: false },
        serializeResumeData: () => 'synthetic',
      },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('fake') },
      'services/ats.service.js': {
        scoreResume: () => opts.ruleResult ?? { score: 85, keywordScore: 85, formatScore: 85, sectionsScore: 85, contentScore: 85, detail: {} },
        detectRoleCategory: () => 'engineering',
        detectSeniority: () => 'mid',
      },
      'services/claude.service.js': { scoreResumeWithAI: async () => opts.aiResult ?? { success: false }, extractJson: x => (typeof x === 'string' ? JSON.parse(x) : x) },
      'services/email.service.js': {
        sendScanPass: async (...a) => { state.emails.push({ fn: 'sendScanPass', a } ); if (opts.emailThrows) throw opts.emailThrows },
        sendScanFail: async (...a) => { state.emails.push({ fn: 'sendScanFail', a } ); if (opts.emailThrows) throw opts.emailThrows },
        sendAnonScanResult: async (...a) => { state.emails.push({ fn: 'sendAnonScanResult', a } ); if (opts.emailThrows) throw opts.emailThrows },
      },
    })
    return { mod, restore, state, db, env }
  }

  it('marks the scan SCANNING immediately, before doing any real work', async () => {
    t = setup()
    await t.mod.runAtsScan({}, t.db, 's1')
    expect(t.state.scanUpdates[0]).toEqual({ status: 'SCANNING' })
  })

  it('file-mode: pulls bytes from R2 and extracts text', async () => {
    t = setup()
    await t.mod.runAtsScan(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.ats_score !== undefined)
    expect(finalUpdate.ats_score).toBe(85)
    expect(finalUpdate.status).toBe('COMPLETE_PASS')
  })

  it('file-mode: ERRORs the scan when the R2 object is missing', async () => {
    t = setup({ r2Object: null })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.scanUpdates.some(u => u.status === 'ERROR')).toBe(true)
  })

  it('brain_dump: a structuring failure ERRORs the scan with the parser\'s own message', async () => {
    t = setup({ scan: { id: 's1', input_mode: 'brain_dump', raw_brain_dump_text: 'x'.repeat(150), user_id: null }, brainDumpResult: { parseError: true, parseErrorMessage: 'could not parse' } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    const errUpdate = t.state.scanUpdates.find(u => u.status === 'ERROR')
    expect(errUpdate.full_ats_report.error).toBe('could not parse')
  })

  it('brain_dump: fills in a logged-in user\'s name/email when Claude did not extract them, but never overwrites what Claude DID extract', async () => {
    t = setup({
      scan: { id: 's1', input_mode: 'brain_dump', raw_brain_dump_text: 'x'.repeat(150), user_id: 'u1' },
      brainDumpResult: { resumeData: { name: null, email: 'claude-found@x.com' }, parseError: false },
      userRow: { id: 'u1', name: 'Account Name', email: 'account@x.com' },
    })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    const structuredUpdate = t.state.scanUpdates.find(u => u.original_resume_data)
    expect(structuredUpdate.original_resume_data.name).toBe('Account Name')     // filled in
    expect(structuredUpdate.original_resume_data.email).toBe('claude-found@x.com') // NOT overwritten
    expect(structuredUpdate.candidate_first_name).toBe('Account')
  })

  it('saved_profile: ERRORs when originalResumeData is missing', async () => {
    t = setup({ scan: { id: 's1', input_mode: 'saved_profile', original_resume_data: null, user_id: 'u1' } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.scanUpdates.some(u => u.status === 'ERROR')).toBe(true)
  })

  it('ERRORs when the extracted/rendered text is too short to score', async () => {
    t = setup({ extractedText: 'too short' })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    const errUpdate = t.state.scanUpdates.find(u => u.status === 'ERROR')
    expect(errUpdate.full_ats_report.error).toMatch(/could not be parsed/i)
  })

  it('blends the AI score in when the AI call succeeds', async () => {
    t = setup({
      ruleResult: { score: 60, keywordScore: 60, formatScore: 60, sectionsScore: 60, contentScore: 60, detail: {} },
      aiResult: { success: true, data: JSON.stringify({ aiScore: 100, missingKeywords: ['x'] }) },
    })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.ats_score !== undefined)
    // 70% rule (60) + 30% AI (100) = 72
    expect(finalUpdate.ats_score).toBe(72)
    expect(finalUpdate.full_ats_report.aiMissingKeywords).toEqual(['x'])
  })

  it('a below-threshold score still completes the scan (COMPLETE_FAIL, not ERROR)', async () => {
    t = setup({ ruleResult: { score: 40, keywordScore: 40, formatScore: 40, sectionsScore: 40, contentScore: 40, detail: {} } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.ats_score !== undefined)
    expect(finalUpdate.status).toBe('COMPLETE_FAIL')
  })

  it('a logged-in user gets sendScanPass on a pass and sendScanFail on a fail', async () => {
    t = setup({ scan: { id: 's1', input_mode: 'file', resume_path: 'r-key', resume_mime_type: 'application/pdf', user_id: 'u1', job_description_text: 'JD' }, ruleResult: { score: 90, keywordScore: 90, formatScore: 90, sectionsScore: 90, contentScore: 90, detail: {} } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.emails[0].fn).toBe('sendScanPass')
    t.restore()

    t = setup({ scan: { id: 's1', input_mode: 'file', resume_path: 'r-key', resume_mime_type: 'application/pdf', user_id: 'u1', job_description_text: 'JD' }, ruleResult: { score: 10, keywordScore: 10, formatScore: 10, sectionsScore: 10, contentScore: 10, detail: {} } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.emails[0].fn).toBe('sendScanFail')
  })

  it('an anonymous brain-dump scan with a contact email gets sendAnonScanResult; without one, no email at all', async () => {
    t = setup({ scan: { id: 's1', input_mode: 'brain_dump', raw_brain_dump_text: 'x'.repeat(150), user_id: null, contact_email: 'anon@x.com', contact_name: 'Anon', anon_token: 'tok1' } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.emails[0].fn).toBe('sendAnonScanResult')
    t.restore()

    t = setup({ scan: { id: 's1', input_mode: 'brain_dump', raw_brain_dump_text: 'x'.repeat(150), user_id: null, contact_email: null } })
    await t.mod.runAtsScan(t.env, t.db, 's1')
    expect(t.state.emails).toHaveLength(0)
  })

  it('a failed notification email never throws out of runAtsScan (the scan still completed)', async () => {
    t = setup({ scan: { id: 's1', input_mode: 'file', resume_path: 'r-key', resume_mime_type: 'application/pdf', user_id: 'u1', job_description_text: 'JD' }, emailThrows: new Error('mail down') })
    await expect(t.mod.runAtsScan(t.env, t.db, 's1')).resolves.not.toThrow()
    expect(t.state.scanUpdates.some(u => u.status === 'COMPLETE_PASS' || u.status === 'COMPLETE_FAIL')).toBe(true)
  })

  it('any unexpected throw mid-pipeline is caught and marks the scan ERROR rather than leaving it stuck SCANNING', async () => {
    t = setup({ updateFails: true })
    await expect(t.mod.runAtsScan(t.env, t.db, 's1')).resolves.not.toThrow()
    // The very last thing the catch-all does is attempt one more ERROR
    // write — even though every write in this fake fails, the function
    // itself must not throw back out to its caller (createScan's own
    // .catch just logs; a throw here would still be "handled" but the
    // point of the top-level try/catch is that nothing escapes it).
  })
})
// ─── generateFix (background job — AI rewrite + DOCX + PDF + credential) ──

describe('generateFix', () => {
  function setup(opts = {}) {
    const state = { scanUpdates: [], r2Puts: [], r2Deletes: [], credits: [], alerts: [], emails: [] }
    const scan = 'scan' in opts ? opts.scan : {
      id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' },
      job_description_text: 'JD', fix_tier: 'FIX', fix_retry_count: 0, role_category: null,
    }
    const userRow = 'userRow' in opts ? opts.userRow : { id: 'u1', name: 'Jane', email: 'jane@x.com' }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: userRow, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.scanUpdates.push(q.patch); return { data: opts.deliverError ? null : [{ id: 's1' }], error: opts.deliverError || null } }
      if (q.op === 'rpc' && q.name === 'increment_free_fix_credits') { state.credits.push(q.args); return { data: true, error: opts.creditErr || null } }
    })
    const rewriteCalls = []
    let rewriteCallIdx = 0
    const env = { RESUMES_BUCKET: {
      get: async () => opts.r2Object ?? { arrayBuffer: async () => new Uint8Array([1]).buffer },
      put: async (key, bytes, meta) => { state.r2Puts.push({ key, meta }) },
      delete: async key => { state.r2Deletes.push(key) },
    } }
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': {
        parse: async () => opts.fileParseResult ?? { resumeData: { name: 'Jane' }, parseError: false },
        extractText: async () => opts.extractedText ?? 'x'.repeat(150),
      },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('fake-docx') },
      'services/ats.service.js': {
        // Indexed by rewriteCallIdx - 1 (clamped at 0): by the time
        // scoreResume runs for a given attempt, rewriteResumeContent for
        // THAT SAME attempt has already incremented rewriteCallIdx, so the
        // post-increment value is one ahead of "this attempt's" index.
        scoreResume: () => { const idx = Math.max(0, Math.min(rewriteCallIdx - 1, (opts.scoreSequence || []).length - 1)); const r = opts.scoreSequence ? opts.scoreSequence[idx] : (opts.score ?? 90); return { score: r, detail: {} } },
        describeWeakAreas: () => ['weak area'],
      },
      'services/claude.service.js': {
        rewriteResumeContent: async (...a) => {
          rewriteCalls.push(a)
          const idx = rewriteCallIdx++
          if (opts.rewriteSequence) return opts.rewriteSequence[Math.min(idx, opts.rewriteSequence.length - 1)]
          return opts.rewriteResult ?? { success: true, data: { name: 'Jane Rewritten' }, quantificationOpportunities: [] }
        },
        generateBeautifulResumeHTML: async () => opts.htmlResult ?? { success: false },
      },
      'services/badge.service.js': {
        generateShortCode: async () => 'NEWCODE1',
        buildVerificationUrl: (env2, code) => `https://passthrough.dev/v/${code}`,
        hashBytes: async () => 'hash123',
      },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/pdf.service.js': { generateResumePDF: opts.pdfImpl ?? (async () => Buffer.from('fake-pdf')) },
      'services/email.service.js': {
        sendFixDelivered: async (...a) => state.emails.push({ fn: 'sendFixDelivered', a }),
        sendFixDeliveredPlain: async (...a) => state.emails.push({ fn: 'sendFixDeliveredPlain', a }),
        sendFixFailed: async (...a) => state.emails.push({ fn: 'sendFixFailed', a }),
        sendOwnerAlert: async (...a) => state.alerts.push(a),
      },
    })
    return { mod, restore, state, db, env, rewriteCalls, getRewriteCallCount: () => rewriteCallIdx }
  }

  it('marks the scan FIX_GENERATING immediately', async () => {
    t = setup()
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.state.scanUpdates[0]).toEqual({ status: 'FIX_GENERATING' })
  })

  it('brain_dump/saved_profile with no structured data fails into the top-level catch (ERROR + owner alert)', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: null, fix_tier: 'FIX', fix_retry_count: 0 } })
    const res = await t.mod.generateFix(t.env, t.db, 's1')
    expect(res.success).toBe(false)
    expect(t.state.scanUpdates.some(u => u.status === 'ERROR')).toBe(true)
    expect(t.state.alerts.length).toBe(1)
  })

  it('file-mode: pulls from R2 and parses; a parse failure also fails into the catch', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file', resume_path: 'r-key', resume_mime_type: 'application/pdf', fix_tier: 'FIX', fix_retry_count: 0 }, fileParseResult: { parseError: true, parseErrorMessage: 'bad file' } })
    const res = await t.mod.generateFix(t.env, t.db, 's1')
    expect(res.success).toBe(false)
  })

  it('a retry (fixRetryCount > 0) rewrites from the previously delivered rewrittenResumeData, not the original', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Original' }, rewritten_resume_data: { name: 'Previously Rewritten' }, fix_retry_count: 1, fix_ats_score: 60, fix_tier: 'FIX', verification_code: 'EXIST01', verification_url: 'https://passthrough.dev/v/EXIST01' } })
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.rewriteCalls[0][1]).toEqual({ name: 'Previously Rewritten' })
  })

  it('FIX_PLAIN never generates a verification code or URL', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, fix_tier: 'FIX_PLAIN', fix_retry_count: 0 } })
    await t.mod.generateFix(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.verification_code).toBe(null)
    expect(finalUpdate.verification_url).toBe(null)
    expect(finalUpdate.resume_hash).toBe(null)
  })

  it('reuses an existing verification code/url rather than minting a new one (idempotent redelivery)', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, fix_tier: 'FIX', fix_retry_count: 0, verification_code: 'EXIST01', verification_url: 'https://passthrough.dev/v/EXIST01' } })
    await t.mod.generateFix(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.verification_code).toBe('EXIST01')
  })

  it('generates a fresh code when the scan has none yet', async () => {
    t = setup()
    await t.mod.generateFix(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.verification_code).toBe('NEWCODE1')
  })

  it('stops attempting once a candidate reaches the badge threshold, without using all MAX_FIX_ATTEMPTS', async () => {
    t = setup({ scoreSequence: [90] })
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.getRewriteCallCount()).toBe(1)
  })

  it('keeps the best-scoring candidate across attempts even if a later one scores lower', async () => {
    t = setup({ scoreSequence: [70, 50, 65] })   // never reaches 80, so all 3 attempts run
    await t.mod.generateFix(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.fix_ats_score).toBe(70)
  })

  it('FABRICATION_DETECTED is not fatal — it continues to the next attempt (unlike a hard API failure)', async () => {
    t = setup({
      rewriteSequence: [
        { success: false, error: 'FABRICATION_DETECTED' },
        { success: true, data: { name: 'Clean rewrite' }, quantificationOpportunities: [] },
      ],
      scoreSequence: [90],
    })
    const res = await t.mod.generateFix(t.env, t.db, 's1')
    expect(res.success).toBe(true)
    expect(t.getRewriteCallCount()).toBe(2)
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.rewrite_failed).toBe(false)
  })

  it('a hard failure (e.g. PARSE_FAIL) stops the loop immediately rather than burning remaining attempts', async () => {
    t = setup({ rewriteResult: { success: false, error: 'PARSE_FAIL' } })
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.getRewriteCallCount()).toBe(1)
  })

  it('total rewrite failure (every attempt hard-failed): delivers the ORIGINAL resume, marks rewrite_failed, and grants a free credit', async () => {
    t = setup({ rewriteResult: { success: false, error: 'PARSE_FAIL' } })
    await t.mod.generateFix(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.rewrite_failed).toBe(true)
    expect(finalUpdate.rewritten_resume_data).toEqual({ name: 'Jane' })  // == original, unchanged
    expect(t.state.credits).toEqual([{ p_user_id: 'u1' }])
  })

  it('a credit-grant failure on total rewrite failure alerts the owner but does not abort delivery', async () => {
    t = setup({ rewriteResult: { success: false, error: 'PARSE_FAIL' }, creditErr: new Error('rpc down') })
    const res = await t.mod.generateFix(t.env, t.db, 's1')
    expect(res.success).toBe(true)
    expect(t.state.alerts.some(a => /credit NOT granted/i.test(a[1]))).toBe(true)
  })

  it('exhausted retries still below the badge threshold grants a free credit (and total-failure branch does NOT also fire)', async () => {
    t = setup({
      scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, rewritten_resume_data: { name: 'Prev' }, fix_retry_count: 2, fix_ats_score: 60, fix_tier: 'FIX', verification_code: 'C1', verification_url: 'https://x/v/C1' },
      scoreSequence: [65],
    })
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.state.credits).toEqual([{ p_user_id: 'u1' }])
  })

  it('below-threshold delivery keeps the verification link but marks the docx call as unverified', async () => {
    let docxArgs = null
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, fix_tier: 'FIX', fix_retry_count: 0 }, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: { id: 'u1', name: 'Jane', email: 'jane@x.com' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1' }], error: null }
    })
    const env = { RESUMES_BUCKET: { put: async () => {}, delete: async () => {} } }
    const loaded = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/docx.service.js': { generateAtsDocx: async (data, url, opts2) => { docxArgs = opts2; return Buffer.from('x') } },
      'services/resume.parser.js': { extractText: async () => 'x'.repeat(150) },
      'services/ats.service.js': { scoreResume: () => ({ score: 50, detail: {} }), describeWeakAreas: () => [] },
      'services/claude.service.js': { rewriteResumeContent: async () => ({ success: true, data: { name: 'R' }, quantificationOpportunities: [] }), generateBeautifulResumeHTML: async () => ({ success: false }) },
      'services/badge.service.js': { generateShortCode: async () => 'C1', buildVerificationUrl: () => 'https://x/v/C1', hashBytes: async () => 'h' },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/pdf.service.js': { generateResumePDF: async () => Buffer.from('p') },
      'services/email.service.js': { sendFixDelivered: async () => {}, sendFixDeliveredPlain: async () => {}, sendFixFailed: async () => {}, sendOwnerAlert: async () => {} },
    })
    await loaded.mod.generateFix(env, db, 's1')
    expect(docxArgs).toEqual({ verified: false })
    loaded.restore()
  })

  it('a PDF generation failure does not block delivery — the scan still delivers with pdfKey/pdfHash null', async () => {
    t = setup({ htmlResult: { success: true, data: '<html></html>' }, pdfImpl: async () => { throw new Error('pdf boom') } })
    const res = await t.mod.generateFix(t.env, t.db, 's1')
    expect(res.success).toBe(true)
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.resume_pdf_path).toBe(null)
    expect(finalUpdate.resume_pdf_hash).toBe(null)
  })

  it('the final DB write failing throws into the top-level catch (ERROR + sendFixFailed)', async () => {
    t = setup({ deliverError: new Error('save boom') })
    const res = await t.mod.generateFix(t.env, t.db, 's1')
    expect(res.success).toBe(false)
    expect(t.state.emails.some(e => e.fn === 'sendFixFailed')).toBe(true)
    expect(t.state.alerts.length).toBe(1)
  })

  it('sends the plain-tier email for FIX_PLAIN and the credentialed email otherwise', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, fix_tier: 'FIX_PLAIN', fix_retry_count: 0 } })
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.state.emails[0].fn).toBe('sendFixDeliveredPlain')
    t.restore()

    t = setup()
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.state.emails[0].fn).toBe('sendFixDelivered')
  })

  it('an anonymous scan (no user) never attempts to send a delivery email', async () => {
    t = setup({ scan: { id: 's1', user_id: null, input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, fix_tier: 'FIX', fix_retry_count: 0 }, userRow: null })
    await t.mod.generateFix(t.env, t.db, 's1')
    expect(t.state.emails).toHaveLength(0)
  })
})

// ─── generateBadge (background job — credential only, no AI rewrite) ──────

describe('generateBadge', () => {
  function setup(opts = {}) {
    const state = { scanUpdates: [], credits: [], alerts: [], emails: [] }
    const scan = 'scan' in opts ? opts.scan : {
      id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' },
      ats_score: 85, role_category: null,
    }
    const userRow = 'userRow' in opts ? opts.userRow : { id: 'u1', name: 'Jane', email: 'jane@x.com' }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: userRow, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.scanUpdates.push(q.patch); return { data: opts.deliverError ? null : [{ id: 's1' }], error: opts.deliverError || null } }
    })
    const env = { RESUMES_BUCKET: {
      get: async () => ('r2Object' in opts ? opts.r2Object : { arrayBuffer: async () => new Uint8Array([1]).buffer }),
      put: async () => {},
      delete: async () => {},
    } }
    const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': {
        parse: async () => opts.fileParseResult ?? { resumeData: { name: 'Jane From File' }, parseError: false },
        extractText: async () => opts.extractedText ?? 'python java sql aws docker kubernetes react node express postgres redis kafka terraform',
      },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('fake-docx') },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/claude.service.js': { generateBeautifulResumeHTML: async () => opts.htmlResult ?? { success: false } },
      'services/badge.service.js': {
        generateShortCode: async () => 'NEWCODE1',
        buildVerificationUrl: (env2, code) => `https://passthrough.dev/v/${code}`,
        hashBytes: async () => 'hash123',
      },
      'services/pdf.service.js': { generateResumePDF: opts.pdfImpl ?? (async () => Buffer.from('fake-pdf')) },
      'services/email.service.js': {
        sendFixDelivered: async (...a) => state.emails.push({ fn: 'sendFixDelivered', a }),
        sendFixFailed: async (...a) => state.emails.push({ fn: 'sendFixFailed', a }),
        sendOwnerAlert: async (...a) => state.alerts.push(a),
      },
    })
    return { mod, restore, state, db, env }
  }

  it('marks the scan FIX_GENERATING immediately', async () => {
    t = setup()
    await t.mod.generateBadge(t.env, t.db, 's1')
    expect(t.state.scanUpdates[0]).toEqual({ status: 'FIX_GENERATING' })
  })

  it('never rewrites content — the AI rewrite service is never invoked, and rewritten_resume_data is never written', async () => {
    t = setup()
    await t.mod.generateBadge(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.original_resume_data).toEqual({ name: 'Jane' })
    expect('rewritten_resume_data' in finalUpdate).toBe(false)
  })

  it('brain_dump/saved_profile: falls back to an empty-shell candidate rather than crashing when structured data is missing', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'saved_profile', original_resume_data: null, ats_score: 85 } })
    const res = await t.mod.generateBadge(t.env, t.db, 's1')
    expect(res.success).toBe(true)
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.original_resume_data.name).toBe('Candidate')
  })

  it('file-mode: throws into the top-level catch when the R2 object is missing', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file', resume_path: 'r-key', resume_mime_type: 'application/pdf', ats_score: 85 }, r2Object: null })
    const res = await t.mod.generateBadge(t.env, t.db, 's1')
    expect(res.success).toBe(false)
  })

  it('file-mode: uses the freshly parsed resumeData when parsing succeeds', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'file', resume_path: 'r-key', resume_mime_type: 'application/pdf', ats_score: 85 } })
    await t.mod.generateBadge(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.original_resume_data).toEqual({ name: 'Jane From File' })
  })

  it('file-mode: a parse failure never crashes — falls back to a skills-from-raw-text shell instead', async () => {
    t = setup({
      scan: { id: 's1', user_id: 'u1', input_mode: 'file', resume_path: 'r-key', resume_mime_type: 'application/pdf', ats_score: 85 },
      fileParseResult: { parseError: true },
    })
    const res = await t.mod.generateBadge(t.env, t.db, 's1')
    expect(res.success).toBe(true)
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.original_resume_data.name).toBe('Candidate')
    expect(finalUpdate.original_resume_data.skills.length).toBeGreaterThan(0)
  })

  it('reuses an existing verification code rather than minting a new one', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, ats_score: 85, verification_code: 'EXIST01' } })
    await t.mod.generateBadge(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.verification_code).toBe('EXIST01')
  })

  it('persists fix_ats_score from the scan\'s existing atsScore (no new scoring happens for a badge)', async () => {
    t = setup({ scan: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, ats_score: 91 } })
    await t.mod.generateBadge(t.env, t.db, 's1')
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.fix_ats_score).toBe(91)
  })

  it('always renders the credentialed (verified:true) HTML — a badge purchase requires being at/above threshold already', async () => {
    t = setup()
    let htmlArgs = null
    t.restore()
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', user_id: 'u1', input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, ats_score: 85 }, error: null }
      if (q.table === 'users' && q.op === 'select') return { data: { id: 'u1', name: 'Jane', email: 'jane@x.com' }, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1' }], error: null }
    })
    const env = { RESUMES_BUCKET: { put: async () => {}, delete: async () => {} } }
    const loaded = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/docx.service.js': { generateAtsDocx: async () => Buffer.from('x') },
      'services/design.service.js': { getDesignTokens: () => ({}) },
      'services/claude.service.js': { generateBeautifulResumeHTML: async (...a) => { htmlArgs = a; return { success: false } } },
      'services/badge.service.js': { generateShortCode: async () => 'C1', buildVerificationUrl: () => 'https://x/v/C1', hashBytes: async () => 'h' },
      'services/pdf.service.js': { generateResumePDF: async () => Buffer.from('p') },
      'services/email.service.js': { sendFixDelivered: async () => {}, sendFixFailed: async () => {}, sendOwnerAlert: async () => {} },
    })
    await loaded.mod.generateBadge(env, db, 's1')
    expect(htmlArgs[4]).toEqual({ verified: true })
    loaded.restore()
  })

  it('a PDF generation failure does not block delivery', async () => {
    t = setup({ htmlResult: { success: true, data: '<html></html>' }, pdfImpl: async () => { throw new Error('pdf boom') } })
    const res = await t.mod.generateBadge(t.env, t.db, 's1')
    expect(res.success).toBe(true)
    const finalUpdate = t.state.scanUpdates.find(u => u.status === 'FIX_DELIVERED')
    expect(finalUpdate.resume_pdf_path).toBe(null)
    expect(finalUpdate.resume_pdf_hash).toBe(null)
  })

  it('the final DB write failing throws into the top-level catch (ERROR + sendFixFailed + owner alert)', async () => {
    t = setup({ deliverError: new Error('save boom') })
    const res = await t.mod.generateBadge(t.env, t.db, 's1')
    expect(res.success).toBe(false)
    expect(t.state.scanUpdates.some(u => u.status === 'ERROR')).toBe(true)
    expect(t.state.emails.some(e => e.fn === 'sendFixFailed')).toBe(true)
    expect(t.state.alerts.length).toBe(1)
  })

  it('sends the delivered-credential email to a logged-in user', async () => {
    t = setup()
    await t.mod.generateBadge(t.env, t.db, 's1')
    expect(t.state.emails[0].fn).toBe('sendFixDelivered')
  })

  it('an anonymous scan never attempts to send an email', async () => {
    t = setup({ scan: { id: 's1', user_id: null, input_mode: 'brain_dump', original_resume_data: { name: 'Jane' }, ats_score: 85 }, userRow: null })
    await t.mod.generateBadge(t.env, t.db, 's1')
    expect(t.state.emails).toHaveLength(0)
  })
})
