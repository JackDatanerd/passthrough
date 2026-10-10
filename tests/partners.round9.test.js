import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 9 — locks in every fix and feature from this pass.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REMOVED = `partner-${A}@removed.invalid`
let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://passthrough.dev', ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? A,
    query: k => ('query' in over && k in over.query ? over.query[k] : k === 'token' ? over.token : undefined),
    json: async () => (over.rawBody !== undefined ? over.rawBody : over.body ?? {}),
    header: k => (over.headers || {})[String(k).toLowerCase()],
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

function load(db, emailStubs = {}) {
  return loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/turnstile.js': { verifyTurnstile: async () => true },
    'services/email.service.js': { sendOwnerAlert: async () => {}, ...emailStubs },
  })
}

// ── B1: migration 0071 — a refund racing a fresh conversion can no longer leak a usage slot ───────────
describe('migration 0071 — usage-slot race', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0071_partners_round9_usage_race.sql'), 'utf8')
  it('increment_referral_code_usage locks the original ledger row and refuses to count a reversed sale', () => {
    expect(sql).toMatch(/from commission_ledger where id = p_ledger_id for update/)
    expect(sql).toMatch(/reverses_ledger_id = p_ledger_id/)
    expect(sql).toMatch(/if v_reversed then v_flipped := 0/)
  })
  it('release_referral_code_usage_for_ledger decides under the same lock, only for a counted row', () => {
    expect(sql).toMatch(/create or replace function release_referral_code_usage_for_ledger\(p_ledger_id uuid\)/)
    expect(sql).toMatch(/where id = p_ledger_id for update/)
    expect(sql).toMatch(/v_counted is not true/)
    expect(sql).toMatch(/grant\s+execute on function release_referral_code_usage_for_ledger\(uuid\) to service_role/)
  })
  it('ends with the schema_version stamp for 67', () => {
    expect(sql.trim()).toMatch(/'version', 71/)
  })
})

// ── B3: a literal `null` body is not a crash ───────────────────────────────────────────────────────────
describe('trackClick — non-object JSON bodies', () => {
  it.each([[null], [42], [['A']], ['str']])('%j answers a quiet success', async raw => {
    t = load(createFakeSupabase(() => undefined))
    const res = await t.mod.trackClick(ctxOf({ rawBody: raw, headers: { 'user-agent': 'Mozilla/5.0' } }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
  })
})

// ── B4: an anonymized partner gets no links and no codes ───────────────────────────────────────────────
describe('removed partners — no links, no codes', () => {
  function setup(email = REMOVED) {
    const writes = []
    const db = createFakeSupabase(q => {
      if (['update', 'insert', 'delete'].includes(q.op) && q.table !== 'admin_audit_log') writes.push(`${q.op}:${q.table}`)
      if (q.table === 'partners' && q.op === 'select') return { data: { id: A, name: 'Removed partner', email, status: 'PAUSED', dashboard_token: 'd', payout_details_token: 'p' }, error: null }
      if (q.table === 'referral_codes' && q.op === 'select') return { data: { partner_id: A, partners: { email } }, error: null }
      if (q.table === 'referral_codes' && q.op === 'update') return { data: { id: 'c1', partner_id: A, code: 'X', active: false }, error: null }
    })
    return { ...load(db, { sendPartnerPayoutDetailsRequest: async () => true, sendReferralCodeCreated: async () => true }), writes }
  }
  const expectRemoved = res => { expect(res.status).toBe(409); expect(res.body.code).toBe('PARTNER_REMOVED') }

  it('resend-link', async () => { t = setup(); expectRemoved(await t.mod.adminResendPayoutLink(ctxOf())); expect(t.writes).toEqual([]) })
  it('regenerate-link rotates nothing', async () => { t = setup(); expectRemoved(await t.mod.adminRegeneratePayoutLink(ctxOf({ body: { scope: 'both' } }))); expect(t.writes).toEqual([]) })
  it('view links', async () => { t = setup(); expectRemoved(await t.mod.adminGetPartnerLinks(ctxOf())) })
  it('create code inserts nothing', async () => {
    t = setup()
    expectRemoved(await t.mod.adminCreateReferralCode(ctxOf({ body: { code: 'NEW', tierPrices: { FIX_PLAIN: 500 } } })))
    expect(t.writes).toEqual([])
  })
  it('re-activating or re-pricing a code is refused', async () => {
    t = setup()
    expectRemoved(await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: A }, body: { active: true } })))
    expectRemoved(await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: A }, body: { usageLimit: 5 } })))
    expect(t.writes).toEqual([])
  })
  it('switching a code OFF stays allowed', async () => {
    t = setup()
    const res = await t.mod.adminUpdateReferralCode(ctxOf({ params: { codeId: A }, body: { active: false } }))
    expect(res.status).toBe(200)
    expect(t.writes).toContain('update:referral_codes')
  })
  it('an ordinary partner is unaffected', async () => {
    t = setup('k@x.co')
    const res = await t.mod.adminResendPayoutLink(ctxOf())
    expect(res.body.success).toBe(true)
  })
})

// ── B5: what a link holder can read ─────────────────────────────────────────────────────────────────────
describe('getPartnerByToken — what a link holder can read (B5)', () => {
  function run(row) {
    const db = createFakeSupabase(q => (q.table === 'partners' && q.op === 'select' ? { data: row, error: null } : undefined))
    t = load(db)
    return t.mod.getPartnerByToken(ctxOf({ token: 'tok' }))
  }
  it('returns only the last four digits of a bank account, never the full number', async () => {
    const res = await run({ name: 'K', payout_method: 'BANK', payout_details: { bankName: 'Equity', accountName: 'Coach K', accountNumber: '0123 4567 89' }, dashboard_token: 'dash' })
    expect(res.body.data.payoutDetails).toEqual({ bankName: 'Equity', accountName: 'Coach K', accountNumber: '…6789' })
    expect(res.body.data.payoutDetailsMasked).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('0123')
  })
  it('returns only the last four digits of a phone number', async () => {
    const res = await run({ name: 'K', payout_method: 'MOBILE_MONEY', payout_details: { provider: 'M-Pesa', accountName: 'K', phoneNumber: '+254 712 345 678' }, dashboard_token: 'dash' })
    expect(res.body.data.payoutDetails).toEqual({ provider: 'M-Pesa', accountName: 'K', phoneNumber: '…5678' })
    expect(JSON.stringify(res.body)).not.toContain('712')
  })
  it('nothing is masked (and nothing is invented) when nothing is saved', async () => {
    const res = await run({ name: 'K', payout_method: null, payout_details: null, dashboard_token: 'dash' })
    expect(res.body.data).toMatchObject({ payoutDetails: null, payoutDetailsMasked: false })
  })
})

// ── G4 / B2: anonymize ────────────────────────────────────────────────────────────────────────────
describe('adminAnonymizePartner — payout notes, late commission', () => {
  function setup({ email = 'k.o_100%@x.co', ledgerReads = [[]] } = {}) {
    const st = { ops: [], payoutPatches: [], partnerPatch: null }
    let reads = 0
    const db = createFakeSupabase(q => {
      st.ops.push(`${q.op}:${q.table}`)
      if (q.table === 'partners' && q.op === 'select') return { data: { id: A, email }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: ledgerReads[Math.min(reads++, ledgerReads.length - 1)], error: null }
      if (q.table === 'payouts' && q.op === 'select') return { data: [{ id: 'p1', payout_method: 'BANK', payout_details_snapshot: { bankName: 'B', accountName: 'K', accountNumber: '12345678' } }], error: null }
      if (q.table === 'payouts' && q.op === 'update') { st.payoutPatches.push(q.patch); return { data: null, error: null } }
      if (q.table === 'partners' && q.op === 'update') { st.partnerPatch = q.patch; return { data: null, error: null } }
    })
    return { ...load(db), st, db }
  }
  const body = { reason: 'erasure request by email' }

  it('clears the free-text payout notes along with the account snapshot', async () => {
    t = setup()
    await t.mod.adminAnonymizePartner(ctxOf({ body }))
    expect(t.st.payoutPatches[0]).toMatchObject({ note: null, internal_note: null })
  })
  it('stops — wiping nothing — when a sale converted after the codes were switched off', async () => {
    t = setup({ ledgerReads: [[], [{ id: 'l9', commission_amount_cents: 700 }]] })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('COMMISSION_OWED')
    expect(t.st.partnerPatch).toBeNull()
    expect(t.st.ops).not.toContain('update:payouts')
  })
})

// ── G3: partner list says how the setup email went ─────────────────────────────────────────────────────
describe('adminListPartners — payoutLinkEmail (G3)', () => {
  function run(partners, logs) {
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: partners, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: [], error: null }
      if (q.table === 'email_logs' && q.op === 'select') return { data: logs, error: q.table === 'email_logs' && logs === 'ERR' ? { message: 'boom' } : null }
    })
    t = load(db)
    return t.mod.adminListPartners(ctxOf())
  }
  const row = (id, email, method = null) => ({ id, name: id, email, status: 'ACTIVE', commission_rate: 0.2, payout_method: method, created_at: '2026-10-01T00:00:00Z' })

  it('reports the LATEST email outcome for partners who have not set details up, case-insensitively', async () => {
    const res = await run([row('a', 'A@x.co')], [
      { to: 'a@x.co', status: 'failed', sent_at: '2026-10-02T00:00:00Z' },
      { to: 'a@x.co', status: 'sent', sent_at: '2026-10-01T00:00:00Z' },
    ])
    expect(res.body.data[0].payoutLinkEmail).toEqual({ status: 'failed', sentAt: '2026-10-02T00:00:00Z' })
  })
  it('is null for a partner who already has details, and for one never mailed', async () => {
    const res = await run([row('a', 'a@x.co', 'BANK'), row('b', 'b@x.co')], [])
    expect(res.body.data.map(p => p.payoutLinkEmail)).toEqual([null, null])
  })
  it('a failed log lookup omits the field instead of failing the list', async () => {
    const res = await run([row('a', 'a@x.co')], 'ERR')
    expect(res.status).toBe(200)
    expect(res.body.data[0].payoutLinkEmail).toBeNull()
  })
})
