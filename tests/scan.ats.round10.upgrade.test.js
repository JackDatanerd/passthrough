// Scan/ATS round 10 — Badge -> Fix upgrade on the same scan, by spending a free fix credit.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

function ctxOf(over = {}) {
  const sent = []
  return {
    env: { FIX_QUEUE: { send: async m => { if (over.queueThrows) throw over.queueThrows; sent.push(m) } }, PAYSTACK_CURRENCY: 'USD' },
    get: k => (k === 'user' ? (over.user ?? { id: 'u1', emailVerified: true }) : undefined),
    req: { param: () => 's1', query: () => undefined, json: async () => ({}) },
    json: (body, status = 200) => ({ body, status }),
    header: () => {}, body: b => ({ rawBody: b }),
    __sent: sent,
  }
}
const BADGE = { id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'BADGE', fix_payment_id: 'pay0', ats_score: 85, fix_ats_score: 72 }
let t
afterEach(() => t?.restore())

function setup(opts = {}) {
  const st = { ledger: [], scanUpdates: [], refunds: [], alerts: [], paymentUpdates: [] }
  const scan = 'scan' in opts ? opts.scan : BADGE
  const db = createFakeSupabase(q => {
    if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
    if (q.table === 'payments' && q.op === 'select') return { data: { status: opts.originalPaymentStatus ?? 'SUCCESS' }, error: null }
    if (q.op === 'rpc' && q.name === 'redeem_free_fix_credit') return { data: opts.redeemed ?? true, error: null }
    if (q.op === 'rpc' && q.name === 'increment_free_fix_credits') { st.refunds.push(q.args); return { data: true, error: opts.refundErr || null } }
    if (q.table === 'payments' && q.op === 'insert') { st.ledger.push(q.values); return { data: { id: 'ledger1' }, error: null } }
    if (q.table === 'payments' && q.op === 'update') { st.paymentUpdates.push(q.patch); return { data: null, error: null } }
    if (q.table === 'scans' && q.op === 'update') { st.scanUpdates.push(q.patch); return { data: opts.claimed ?? [{ id: 's1' }], error: opts.claimErr || null } }
  })
  const m = loadWithStubs('controllers/scan.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (...a) => { st.alerts.push(a) }, sendFixFailed: async () => {} },
  })
  return { ...m, st, db }
}

describe('upgradeBadgeToFix — refusals happen before a credit is spent', () => {
  it('an unverified account is refused before any lookup', async () => {
    t = setup()
    const r = await t.mod.upgradeBadgeToFix(ctxOf({ user: { id: 'u1', emailVerified: false } }))
    expect(r.status).toBe(403); expect(r.body.code).toBe('EMAIL_NOT_VERIFIED'); expect(t.db.calls).toHaveLength(0)
  })
  it('someone else\'s scan is 403', async () => {
    t = setup({ scan: { ...BADGE, user_id: 'other' } })
    expect((await t.mod.upgradeBadgeToFix(ctxOf())).status).toBe(403)
  })
  it('only a credential-only purchase can be upgraded (a Fix, a Plain fix and an unpaid scan are 400)', async () => {
    for (const scan of [{ ...BADGE, fix_tier: 'FIX' }, { ...BADGE, fix_tier: 'FIX_PLAIN' }, { ...BADGE, fix_purchased: false, fix_tier: null }]) {
      t = setup({ scan })
      expect((await t.mod.upgradeBadgeToFix(ctxOf())).status).toBe(400)
      expect(t.db.calls.some(c => c.name === 'redeem_free_fix_credit')).toBe(false)
      t.restore()
    }
  })
  it('waits for the credential to be delivered first', async () => {
    t = setup({ scan: { ...BADGE, status: 'FIX_GENERATING' } })
    expect((await t.mod.upgradeBadgeToFix(ctxOf())).status).toBe(400)
  })
  it('a refunded or disputed Badge payment blocks the upgrade', async () => {
    for (const s of ['REFUNDED', 'DISPUTED']) {
      t = setup({ originalPaymentStatus: s })
      const r = await t.mod.upgradeBadgeToFix(ctxOf())
      expect(r.status).toBe(403); expect(r.body.code).toBe('PURCHASE_REVERSED')
      expect(t.db.calls.some(c => c.name === 'redeem_free_fix_credit')).toBe(false)
      t.restore()
    }
  })
  it('no credit: 400 and nothing is written', async () => {
    t = setup({ redeemed: false })
    expect((await t.mod.upgradeBadgeToFix(ctxOf())).status).toBe(400)
    expect(t.st.ledger).toEqual([]); expect(t.st.scanUpdates).toEqual([])
  })
})

describe('upgradeBadgeToFix — the upgrade', () => {
  it('spends the credit, records a $0 ledger row, moves the scan to FIX with the marker, and enqueues generateFix', async () => {
    t = setup()
    const ctx = ctxOf()
    const r = await t.mod.upgradeBadgeToFix(ctx)
    expect(r).toEqual({ body: { success: true, data: { scanId: 's1' } }, status: 200 })
    expect(t.st.ledger).toHaveLength(1)
    expect(t.st.ledger[0]).toMatchObject({ amount_cents: 0, status: 'SUCCESS', fix_tier: 'FIX', user_id: 'u1', scan_id: 's1' })
    expect(t.st.ledger[0].paystack_ref).toMatch(/^credit-upgrade:s1:\d+$/)
    expect(t.st.scanUpdates[0]).toMatchObject({ fix_tier: 'FIX', status: 'FIX_PURCHASED', fix_progress: null })  // the Badge run's progress must not leak into the fix's waiting screen
    expect(typeof t.st.scanUpdates[0].badge_upgraded_at).toBe('string')
    // the original paid payment stays the scan's owning payment (refunds on it keep blocking edits/retries)
    expect(t.st.scanUpdates[0]).not.toHaveProperty('fix_payment_id')
    expect(ctx.__sent).toEqual([{ type: 'generateFix', scanId: 's1' }])
    expect(t.st.refunds).toEqual([])
  })
  it('the claim is a compare-and-set on (purchased, BADGE, FIX_DELIVERED)', async () => {
    t = setup()
    await t.mod.upgradeBadgeToFix(ctxOf())
    const upd = t.db.calls.find(c => c.table === 'scans' && c.op === 'update')
    const filters = JSON.stringify(upd)
    expect(filters).toMatch(/fix_purchased/); expect(filters).toMatch(/BADGE/); expect(filters).toMatch(/FIX_DELIVERED/)
  })
  it('a lost claim (the scan changed under us) is 409, the ledger row is FAILED, the credit is handed back, nothing is queued', async () => {
    t = setup({ claimed: [] })
    const ctx = ctxOf()
    const r = await t.mod.upgradeBadgeToFix(ctx)
    expect(r.status).toBe(409)
    expect(t.st.paymentUpdates).toContainEqual({ status: 'FAILED' })
    expect(t.st.refunds).toEqual([{ p_user_id: 'u1' }])
    expect(ctx.__sent).toEqual([])
  })
  it('a failed enqueue AFTER the claim still succeeds (the orphan sweep delivers it) and does not refund', async () => {
    t = setup()
    const r = await t.mod.upgradeBadgeToFix(ctxOf({ queueThrows: new Error('queue down') }))
    expect(r.body.success).toBe(true); expect(t.st.refunds).toEqual([])
  })
  it('a database failure BEFORE the claim refunds the credit and surfaces the error', async () => {
    t = setup({ claimErr: new Error('db down') })
    await expect(t.mod.upgradeBadgeToFix(ctxOf())).rejects.toThrow('db down')
    expect(t.st.refunds).toEqual([{ p_user_id: 'u1' }])
  })
  it('a refund that itself fails alerts the owner with the restore instruction', async () => {
    t = setup({ claimed: [], refundErr: new Error('rpc down') })
    await t.mod.upgradeBadgeToFix(ctxOf())
    expect(t.st.alerts.some(a => /refund failed/.test(a[1]))).toBe(true)
  })
})

describe('a crashed upgrade run is reverted, not stranded', () => {
  it('generateFix on an upgrade whose run throws puts the scan back to BADGE/FIX_DELIVERED, fails the ledger row and refunds the credit', async () => {
    const st = { scanUpdates: [], refunds: [], paymentUpdates: [] }
    // brain_dump with no structured data -> generateFixRun throws after FIX_GENERATING is set.
    const row = { ...BADGE, status: 'FIX_PURCHASED', fix_tier: 'FIX', badge_upgraded_at: '2026-10-15T10:00:00Z', input_mode: 'brain_dump', original_resume_data: null, resume_ats_path: 'x.docx' }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc' && q.name === 'claim_fix_job') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'select') return { data: row, error: null }
      if (q.op === 'rpc' && q.name === 'increment_free_fix_credits') { st.refunds.push(q.args); return { data: true, error: null } }
      if (q.table === 'payments' && q.op === 'update') { st.paymentUpdates.push(q.patch); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'update') { st.scanUpdates.push(q.patch); return { data: [{ id: 's1' }], error: null } }
    })
    t = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async () => {}, sendFixFailed: async () => {} },
    })
    const res = await t.mod.generateFix({}, db, 's1')
    expect(res.success).toBe(false)
    // round 12: the once-per-upgrade credit marker is cleared with the rest, so a later upgrade of this scan can be handed back again
    expect(st.scanUpdates).toContainEqual({ fix_tier: 'BADGE', status: 'FIX_DELIVERED', badge_upgraded_at: null, fix_progress: null, upgrade_credit_granted_at: null })
    expect(st.scanUpdates.some(p => p.status === 'ERROR')).toBe(false)
    expect(st.paymentUpdates).toContainEqual({ status: 'FAILED' })
    expect(st.refunds).toEqual([{ p_user_id: 'u1' }])
  })
  it('a run that had already delivered is not undone: the revert is a compare-and-set that matches nothing, so no refund', async () => {
    const st = { refunds: [] }
    const row = { ...BADGE, status: 'FIX_PURCHASED', fix_tier: 'FIX', badge_upgraded_at: '2026-10-15T10:00:00Z', input_mode: 'brain_dump', original_resume_data: null }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc' && q.name === 'claim_fix_job') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'select') return { data: row, error: null }
      if (q.op === 'rpc' && q.name === 'increment_free_fix_credits') { st.refunds.push(q.args); return { data: true, error: null } }
      if (q.table === 'scans' && q.op === 'update') return { data: [], error: null }   // nothing matches: already delivered
    })
    t = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {}, sendFixFailed: async () => {} } })
    await t.mod.generateFix({}, db, 's1')
    expect(st.refunds).toEqual([])
  })
})

describe('upgrade wiring', () => {
  const src = readFileSync(new URL('../src/controllers/scan.controller.js', import.meta.url), 'utf8')
  it('the delivery write clears the marker and the Badge-era edit only for an upgrade run', () => {
    expect(src).toMatch(/\.\.\.\(upgradeRound \? \{ badge_upgraded_at: null, user_edited_resume_data: null \} : \{\}\)/)
  })
  it('an upgrade run rewrites the resume the person actually holds (their Badge-era edit)', () => {
    expect(src).toMatch(/if \(upgradeRound\) \{\s*const held = scan\.rewrittenResumeData \|\| scan\.userEditedResumeData\s*if \(held\) originalData = held/)
  })
  it('the route is authenticated and uses the credit limiter', () => {
    const routes = readFileSync(new URL('../src/routes/scan.routes.js', import.meta.url), 'utf8')
    expect(routes).toMatch(/router\.post\('\/:id\/upgrade-to-fix', auth, rl\.redeemCredit, validateUuidParam\(\), c\.upgradeBadgeToFix\)/)
  })
  it('the column exists in migration 0089', () => {
    expect(readFileSync(new URL('../supabase/migrations/0089_scan_ats_round10.sql', import.meta.url), 'utf8')).toMatch(/add column if not exists badge_upgraded_at\s+timestamptz/)
  })
})

import { fallbackQuantificationPrompts } from '../src/services/claude.service.js'
describe('gap 3: quantification prompts and the no-gain retry flag', () => {
  const data = { experience: [
    { company: 'Acme', title: 'Dev', bullets: ['Built REST services for internal tools used by the finance team', 'Improved reporting performance by 40% by rewriting slow queries', 'Led it', '  Maintained deployment scripts and monitored production services for the platform  '] },
    { company: 'Beta', title: 'Dev', bullets: ['Wrote documentation and tutorials for open source contributors worldwide'] }] }
  it('builds prompts from real, unquantified, substantial experience bullets - exact text, trimmed', () => {
    const r = fallbackQuantificationPrompts(data)
    expect(r.map(p => p.bullet)).toEqual([
      'Built REST services for internal tools used by the finance team',
      'Maintained deployment scripts and monitored production services for the platform',
      'Wrote documentation and tutorials for open source contributors worldwide',
    ])
    expect(r.every(p => typeof p.suggestion === 'string' && p.suggestion.length > 10)).toBe(true)
  })
  it('caps at five and tolerates missing data', () => {
    const many = { experience: [{ bullets: Array.from({ length: 12 }, (_, i) => `Handled the quarterly reconciliation process number${'x'.repeat(i)} for finance`) }] }
    expect(fallbackQuantificationPrompts(many)).toHaveLength(5)
    expect(fallbackQuantificationPrompts(null)).toEqual([])
    expect(fallbackQuantificationPrompts({ experience: [{ bullets: null }, null] })).toEqual([])
  })
  const src = readFileSync(new URL('../src/controllers/scan.controller.js', import.meta.url), 'utf8')
  it('the controller only falls back when the model gave nothing, and writes the no-gain flag best-effort after delivery', () => {
    expect(src).toMatch(/if \(!quantificationPrompts\?\.length\) quantificationPrompts = claudeService\.fallbackQuantificationPrompts\?\.\(finalData\) \?\? \[\]/)
    const i = src.indexOf('if (deliverErr) throw deliverErr', src.indexOf('async function generateFixRun'))
    const after = src.slice(i, i + 700)
    expect(after).toMatch(/fix_retry_no_gain: carriedForward && producedCandidate/)
    expect(after).toMatch(/try \{ await supabase\.from\('scans'\)\.update\(\{ fix_retry_no_gain/)
  })
})
