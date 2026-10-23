import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 29: the welcome-code system partner is plumbing (never listed, edited, paid, erased or mailed), personal codes
// never become another visitor's attribution, one visitor counts once per code, the payout RPC re-checks details under the lock.

let t
afterEach(() => t?.restore())
const WELCOME = '00000000-0000-4000-8000-00000000e1c0'
const PID = '0b0c8c64-1d0f-4f7e-9a49-0a6a4b1f4c11'
const makeKv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, m } }
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD', ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1', email: 'a@x.co' } : undefined),
  req: { param: k => (over.params || {})[k ?? 'id'] ?? PID, query: k => (over.query || {})[k], json: async () => over.body ?? {},
    header: k => (over.headers || {})[String(k).toLowerCase()] },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})
const load = (db, email = {}) => (t = loadWithStubs('controllers/partners.controller.js', {
  'config/supabase.js': { getSupabase: () => db },
  'services/email.service.js': { sendOwnerAlert: async () => {}, ...email },
}))

describe('the welcome-code system partner', () => {
  it('is refused by every admin action that would edit, pause, pay or erase it, before any database call', async () => {
    const db = createFakeSupabase()
    const { mod } = load(db)
    const params = { id: WELCOME }
    for (const [fn, body] of [['adminUpdatePartner', { status: 'PAUSED' }], ['adminAnonymizePartner', { reason: 'cleanup' }],
      ['adminRecordPayout', {}], ['adminAdjustLedger', { amountCents: 100, reason: 'x y z' }], ['adminRegeneratePayoutLink', {}],
      ['adminResendPayoutLink', {}], ['adminGetPartnerLinks', {}], ['adminGetPartner', {}], ['adminCreateReferralCode', { code: 'ABC', tierPrices: { FIX: 100 } }],
      ['adminRevealPayoutDetails', {}]]) {
      const res = await mod[fn](ctxOf({ params, body }))
      expect(res, fn).toMatchObject({ status: 409, body: { success: false, code: 'SYSTEM_PARTNER' } })
    }
    expect(db.calls).toHaveLength(0)
  })
  it('refuses editing a code it owns', async () => {
    const db = createFakeSupabase(q => q.table === 'referral_codes' ? { data: { partner_id: WELCOME, code: 'FN-AAAAA', active: true, partners: { email: 'welcome-codes@system.invalid', status: 'ACTIVE' } }, error: null } : undefined)
    const res = await load(db).mod.adminUpdateReferralCode(ctxOf({ params: { codeId: 'c1' }, body: { active: false } }))
    expect(res).toMatchObject({ status: 409, body: { code: 'SYSTEM_PARTNER' } })
  })
  it('is left out of the partner list, the overview, the terms notice and the legacy-link conversion', async () => {
    const db = createFakeSupabase(q => (q.table === 'partners' && q.cols && String(q.cols).includes('count')) ? undefined : undefined)
    const { mod } = load(db)
    await mod.adminListPartners(ctxOf())
    await mod.adminPartnersOverview(ctxOf())
    await mod.adminSendTermsNotice(ctxOf())
    await mod.adminConvertLegacyDashboardLinks(ctxOf())
    const partnerSelects = db.calls.filter(q => q.table === 'partners' && q.op === 'select')
    expect(partnerSelects.length).toBeGreaterThanOrEqual(5)
    for (const q of partnerSelects) expect(q.filters, JSON.stringify(q.cols)).toContainEqual(['neq', 'id', WELCOME])
    const ledger = db.calls.filter(q => q.table === 'commission_ledger' && q.op === 'select')
    expect(ledger.length).toBeGreaterThan(0)
    for (const q of ledger) expect(q.filters).toContainEqual(['neq', 'partner_id', WELCOME])
  })
  it('its zero-cent rows are not read into the unpaid-ledger figures', async () => {
    const db = createFakeSupabase()
    await load(db).mod.adminListPartners(ctxOf())
    const unpaid = db.calls.find(q => q.table === 'commission_ledger' && q.filters.some(f => f[0] === 'is' && f[1] === 'payout_id'))
    expect(unpaid.filters).toContainEqual(['neq', 'commission_amount_cents', 0])
  })
  it('personal codes are hidden from the cross-partner code list unless asked for', async () => {
    let db = createFakeSupabase(); await load(db).mod.adminListReferralCodes(ctxOf())
    expect(db.calls[0].filters).toContainEqual(['is', 'user_id', null])
    t.restore(); db = createFakeSupabase(); await load(db).mod.adminListReferralCodes(ctxOf({ query: { personal: 'true' } }))
    expect(db.calls[0].filters).toContainEqual(['not', 'user_id', 'is', null])
  })
  it('its 0-cent rows are left out of the cross-partner ledger unless includeSystem=true', async () => {
    let db = createFakeSupabase(); await load(db).mod.adminListLedger(ctxOf())
    expect(db.calls[0].filters).toContainEqual(['neq', 'partner_id', WELCOME])
    t.restore(); db = createFakeSupabase(); await load(db).mod.adminListLedger(ctxOf({ query: { includeSystem: 'true' } }))
    expect(db.calls[0].filters).not.toContainEqual(['neq', 'partner_id', WELCOME])
  })
  it('the expiry sweep never reads welcome codes', async () => {
    const db = createFakeSupabase(); t = loadWithStubs('services/referral.service.js', {})
    await t.mod.sweepExpiringCodes(db, { RATE_LIMIT_KV: makeKv() })
    expect(db.calls[0].filters).toContainEqual(['neq', 'partner_id', WELCOME])
  })
})

describe('personal welcome codes and attribution', () => {
  const personal = { id: 'rc1', code: 'FN-ABCDE', active: true, user_id: 'owner-1', partner_id: WELCOME, tier_prices: { FIX: 100 }, partners: { status: 'ACTIVE', email: 'welcome-codes@system.invalid', commission_rate: 0 } }
  it('track-click calls a personal code invalid and counts nothing', async () => {
    const db = createFakeSupabase(q => q.table === 'referral_codes' ? { data: personal, error: null } : undefined)
    const res = await load(db).mod.trackClick(ctxOf({ body: { code: 'fn-abcde' }, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 13)' } }))
    expect(res.body).toEqual({ success: true, valid: false })
    expect(db.calls.filter(q => q.op === 'rpc')).toHaveLength(0)
  })
  it('only the owner can attribute their own account to it', async () => {
    const db = createFakeSupabase(q => q.table === 'referral_codes' ? { data: personal, error: null } : q.table === 'users' ? { data: null, error: null } : undefined)
    t = loadWithStubs('services/referral.service.js', {})
    expect(await t.mod.setUserAttribution(db, { id: 'stranger', email: 's@x.co' }, 'FN-ABCDE', undefined, null)).toEqual({ stored: false, reason: 'personal' })
    expect((await t.mod.setUserAttribution(db, { id: 'owner-1', email: 'o@x.co' }, 'FN-ABCDE', undefined, null)).stored).toBe(true)
  })
  it('re-crediting a sale to a personal, switched-off or expired code is refused before the move', async () => {
    const sale = { id: 'led1', partner_id: PID, referral_code_id: 'rcOld', kind: 'SALE', reverses_ledger_id: null, payment_id: 'pay1', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null }
    const partners = { status: 'ACTIVE', email: 'n@x.co', previous_emails: [], commission_rate: 0.3 }
    for (const [target, code] of [[{ ...personal, partners }, 'PERSONAL_CODE'], [{ id: 'rcN', partner_id: 'p2', active: false, partners }, 'CODE_INACTIVE'],
      [{ id: 'rcN', partner_id: 'p2', active: true, expires_at: '2020-01-01T00:00:00Z', partners }, 'CODE_INACTIVE']]) {
      const db = createFakeSupabase(q => q.op === 'rpc' ? { data: 'ok', error: null } : q.table === 'commission_ledger' ? { data: sale, error: null } : q.table === 'referral_codes' ? { data: target, error: null } : undefined)
      const res = await load(db).mod.adminReattributeSale(ctxOf({ params: { id: PID, ledgerId: 'led1' }, body: { toCode: 'X1', reason: 'wrong code used' } }))
      expect(res).toMatchObject({ status: 409, body: { code } })
      expect(db.calls.filter(q => q.op === 'rpc')).toHaveLength(0)
      t.restore()
    }
  })
})

describe('click counting and the payout-link swap', () => {
  const row = { id: 'rc1', code: 'COACH20', active: true, user_id: null, partner_id: 'p1', partners: { status: 'ACTIVE', email: 'p@x.co', commission_rate: 0.2 } }
  it('one visitor counts once per code per window, another visitor counts again', async () => {
    const kv = makeKv()
    const db = createFakeSupabase(q => q.table === 'referral_codes' ? { data: row, error: null } : undefined)
    const { mod } = load(db)
    const click = ip => mod.trackClick(ctxOf({ env: { RATE_LIMIT_KV: kv }, body: { code: 'COACH20' }, headers: { 'user-agent': 'Mozilla/5.0 Chrome', 'cf-connecting-ip': ip } }))
    await click('1.1.1.1'); await click('1.1.1.1'); await click('2.2.2.2')
    expect(db.calls.filter(q => q.op === 'rpc' && q.name === 'increment_referral_code_clicks')).toHaveLength(2)
  })
  it('a read-only dashboard link can swap the payout link once per 15 minutes, not in a loop', async () => {
    const kv = makeKv()
    const db = createFakeSupabase(q => q.table === 'partners'
      ? (q.op === 'update' ? { data: { id: 'p1' }, error: null } : { data: { id: 'p1', name: 'P', email: 'p@x.co', payout_token_hash: 'old', dashboard_token_version: 0 }, error: null }) : undefined)
    const { mod } = load(db, { sendPartnerPayoutDetailsRequest: async () => true })
    for (let i = 0; i < 3; i++) await mod.requestPayoutLink(ctxOf({ env: { RATE_LIMIT_KV: kv }, headers: { 'x-partner-token': 'legacy-dashboard-token' } }))
    expect(db.calls.filter(q => q.table === 'partners' && q.op === 'update')).toHaveLength(1)
  })
})

describe('referral code admin answers', () => {
  it('reports notified:false when the code email did not go', async () => {
    const db = createFakeSupabase(q => q.table === 'partners' ? { data: { name: 'P', email: 'p@x.co', status: 'ACTIVE', id: PID, dashboard_token_version: 0 }, error: null }
      : q.table === 'referral_codes' && q.op === 'insert' ? { data: { id: 'c1', partner_id: PID, code: 'ANNA20', tier_prices: { FIX: 2000 } }, error: null } : undefined)
    const { mod } = load(db, { sendReferralCodeCreated: async () => false })
    const res = await mod.adminCreateReferralCode(ctxOf({ body: { code: 'anna20', tierPrices: { FIX: 2000 }, confirmLowPrice: true } }))
    expect(res.body).toMatchObject({ success: true, notified: false })
  })
  it('warns when a new limit is already used up', async () => {
    const db = createFakeSupabase(q => q.table === 'referral_codes' && q.op === 'select' ? { data: { partner_id: PID, code: 'A1', active: true, tier_prices: {}, usage_limit: null, expires_at: null, partners: { name: 'P', email: 'p@x.co', status: 'PAUSED' } }, error: null }
      : q.table === 'referral_codes' ? { data: { id: 'c1', partner_id: PID, code: 'A1', usage_limit: 3, uses_so_far: 5, active: true, tier_prices: {} }, error: null } : undefined)
    const res = await load(db).mod.adminUpdateReferralCode(ctxOf({ params: { codeId: 'c1' }, body: { usageLimit: 3 } }))
    expect(res.body.warnings.join(' ')).toMatch(/at or below the 5 redemption/)
  })
})

describe('payout recording re-checks the payout details under the lock', () => {
  it('sends the expected details timestamp to the RPC and records nothing when it reports a change', async () => {
    const partner = { id: PID, name: 'P', email: 'p@x.co', payout_method: 'BANK', payout_details: { accountNumber: '1234' }, payout_details_submitted_at: '2026-01-01T00:00:00+00:00' }
    const rpcs = []
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') { rpcs.push(q); return { data: { payout: null, requested: 1, claimed: 0, discarded: false, details_changed: true }, error: null } }
      if (q.table === 'partners') return { data: partner, error: null }
      if (q.table === 'commission_ledger') return { data: [{ id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, kind: 'SALE', currency: 'USD', created_at: '2025-01-01T00:00:00Z', payments: { status: 'SUCCESS' } }], error: null }
      return undefined
    })
    const res = await load(db).mod.adminRecordPayout(ctxOf({ body: { amountCents: 500, confirmedWithPartner: true } }))
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_DETAILS_CHANGED' } })
    expect(rpcs[0].args).toMatchObject({ p_check_details: true, p_expected_details_submitted_at: '2026-01-01T00:00:00+00:00' })
  })
})

// ---- Round 30 --------------------------------------------------------------------------------------------------------------
describe('round 30: finding a personal code, and the migration number', () => {
  it('a text search still finds a personal welcome code and flags it; the plain list keeps hiding them', async () => {
    let db = createFakeSupabase(q => q.table === 'referral_codes' ? { data: [{ id: 'c1', partner_id: WELCOME, user_id: 'u1', code: 'FN-ABCDE', tier_prices: {}, active: true, partners: { name: 'Passthrough welcome codes (system)', email: 'welcome-codes@system.invalid', status: 'ACTIVE' } }], count: 1, error: null } : undefined)
    const res = await load(db).mod.adminListReferralCodes(ctxOf({ query: { q: 'fn-abc' } }))
    expect(db.calls[0].filters).not.toContainEqual(['is', 'user_id', null])
    expect(res.body.data[0]).toMatchObject({ code: 'FN-ABCDE', personal: true })
    t.restore(); db = createFakeSupabase(); await load(db).mod.adminListReferralCodes(ctxOf())
    expect(db.calls[0].filters).toContainEqual(['is', 'user_id', null])
  })
})

// ---- Round 31 --------------------------------------------------------------------------------------------------------------
describe('round 31: the payout-link throttle only counts a link that was really sent', () => {
  const mk = (kv, sender) => {
    const db = createFakeSupabase(q => q.table === 'partners'
      ? (q.op === 'update' ? { data: { id: 'p1' }, error: null } : { data: { id: 'p1', name: 'P', email: 'p@x.co', payout_token_hash: 'old', dashboard_token_version: 0 }, error: null }) : undefined)
    return { db, ...load(db, { sendPartnerPayoutDetailsRequest: sender }) }
  }
  const call = (mod, kv) => mod.requestPayoutLink(ctxOf({ env: { RATE_LIMIT_KV: kv }, headers: { 'x-partner-token': 'legacy-dashboard-token' } }))
  const updates = db => db.calls.filter(q => q.table === 'partners' && q.op === 'update')
  it('a failed send does not lock the partner out: the retry swaps and sends again', async () => {
    const kv = makeKv(); const { db, mod } = mk(kv, async () => false)
    await call(mod, kv); await call(mod, kv)
    expect(kv.m.size).toBe(0)
    // each attempt: the swap, then the undo of it
    expect(updates(db)).toHaveLength(4)
  })
  it('a delivered link starts the window', async () => {
    const kv = makeKv(); const { db, mod } = mk(kv, async () => true)
    await call(mod, kv); await call(mod, kv)
    expect(kv.m.size).toBe(1)
    expect(updates(db)).toHaveLength(1)
  })
})
