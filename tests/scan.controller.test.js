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
    expect(t.state.paymentInserts[0]).toMatchObject({ amount_cents: 0, status: 'SUCCESS', scan_id: 's1', user_id: 'u1' })
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
})

describe('getScanHistory', () => {
  function setup(rows, count = 0) {
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: rows, error: null, count } : undefined))
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

  it('sanitizes the search term before building the .or() filter', async () => {
    t = setup([], 0)
    await t.mod.getScanHistory(baseCtx({ query: { search: 'jo,(hn' } }))
    const call = t.db.calls.find(c => c.table === 'scans')
    const orExpr = (call.or || []).join(',')
    expect(orExpr).toContain('%john%')
    expect(orExpr).not.toContain('(hn')
  })
})
