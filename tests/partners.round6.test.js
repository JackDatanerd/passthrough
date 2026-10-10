import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 6 — locks in every fix and feature from this pass.

const OLD_TS = '2026-01-01T10:00:00.000000+00:00'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const has = (q, op, col) => (q.filters || []).some(f => f[0] === op && f[1] === col)
let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://passthrough.dev', ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? 'p1',
    query: k => (over.query || {})[k],
    json: async () => over.body ?? {},
    header: k => (over.headers || {})[String(k).toLowerCase()],
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

const partnerRow = (over = {}) => ({
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', payout_method: 'BANK',
  payout_details: { bankName: 'B', accountNumber: '0123456789' }, payout_details_submitted_at: OLD_TS,
  payout_details_token: 'ptok', dashboard_token: 'dtok', commission_rate: 0.1, notify_conversions: true, ...over,
})

function setup(o = {}) {
  const st = { audits: [], emails: [], inserts: [], updates: [], queries: [], rpcs: [], alerts: [], appUpdates: [] }
  const byId = o.partnersById || null
  const db = createFakeSupabase(q => {
    st.queries.push(q)
    if (q.op === 'rpc') { st.rpcs.push(q); return o.rpc ? o.rpc(q) : { data: null, error: null } }
    if (q.table === 'admin_audit_log' && q.op === 'insert') { st.audits.push(q.values); return { data: null, error: null } }
    if (q.table === 'partners' && q.op === 'select') {
      if (o.partnersSelect) return o.partnersSelect(q, st)
      if (byId) { const id = (q.filters.find(f => f[0] === 'eq' && f[1] === 'id') || [])[2]; return { data: byId[id] ?? null, error: null } }
      return { data: 'partner' in o ? o.partner : partnerRow(), error: null }
    }
    if (q.table === 'partners' && q.op === 'update') { st.updates.push(q.patch); return { data: o.updated ?? partnerRow(), error: null } }
    if (q.table === 'commission_ledger' && q.op === 'select') {
      if (o.ledgerSelect) return o.ledgerSelect(q)
      if (has(q, 'not', 'reverses_ledger_id')) return { data: [], error: null }
      if (q.filters.some(f => f[0] === 'in')) return { data: [], error: null }
      return { data: o.window ?? [{ id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, currency: null, payments: { status: 'SUCCESS' } }], error: null }
    }
    if (q.table === 'commission_ledger' && q.op === 'update') {
      const ids = (q.filters.find(f => f[0] === 'in') || [])[2] || []
      return { data: ids.map(id => ({ id, commission_amount_cents: 0 })), error: null }
    }
    if (q.table === 'payouts' && q.op === 'insert') { st.inserts.push(q.values); return { data: { id: 'po1', ...q.values }, error: null } }
    if (q.table === 'payouts' && q.op === 'update') return { data: { id: 'po1' }, error: null }
    if (o.other) return o.other(q, st)
    return undefined
  })
  const ok = async (...a) => { st.emails.push(a.slice(3)); return true }
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/turnstile.js': { verifyTurnstile: async () => true },
    'services/email.service.js': {
      sendOwnerAlert: async (...a) => { st.alerts.push(a) }, sendPayoutSent: ok, sendPartnerPayoutVoided: ok,
      sendPartnerPayoutDetailsRequest: async () => true, sendPartnerApplicationRejected: ok,
      sendPartnerApplicationReceived: ok, sendPayoutDetailsChanged: ok,
    },
  })
  return { ...m, st, db }
}

// ── payout-details hold (server-side cooling-off) ───────────────────────────────────────────────
describe('payouts are held after a payout-details change', () => {
  const recent = () => partnerRow({ payout_details_submitted_at: new Date(Date.now() - 3600000).toISOString() })
  it('refuses with PAYOUT_DETAILS_RECENT inside the window and records nothing', async () => {
    t = setup({ partner: recent() })
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500 } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PAYOUT_DETAILS_RECENT')
    expect(t.st.inserts).toHaveLength(0)
  })
  it('goes through once the admin states they confirmed the change with the partner', async () => {
    t = setup({ partner: recent() })
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500, confirmedWithPartner: true } }))
    expect(res.status).toBe(200)
    expect(t.st.inserts).toHaveLength(1)
  })
  it('PAYOUT_DETAILS_HOLD_HOURS=0 turns the hold off', async () => {
    t = setup({ partner: recent() })
    const res = await t.mod.adminRecordPayout(ctxOf({ env: { PAYOUT_DETAILS_HOLD_HOURS: '0' }, body: { amountCents: 500 } }))
    expect(res.status).toBe(200)
  })
  it('a change older than the window is not held (default 48h)', async () => {
    t = setup({ partner: partnerRow({ payout_details_submitted_at: new Date(Date.now() - 49 * 3600000).toISOString() }) })
    expect((await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500 } }))).status).toBe(200)
  })
  it('a garbage env value falls back to the 48h default rather than disabling the hold', async () => {
    t = setup({ partner: recent() })
    const res = await t.mod.adminRecordPayout(ctxOf({ env: { PAYOUT_DETAILS_HOLD_HOURS: 'abc' }, body: { amountCents: 500 } }))
    expect(res.status).toBe(409)
  })
})

// ── currency ───────────────────────────────────────────────────────────────────────────────────
describe('payout currency', () => {
  it('is normalised to upper case', async () => {
    t = setup({ window: [{ id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, currency: 'USD', payments: { status: 'SUCCESS' } }] })
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500, currency: 'usd' } }))
    expect(res.status).toBe(200)
    expect(t.st.inserts[0].currency).toBe('USD')
  })
  it('is refused when the commission being settled is in a different currency, and nothing is recorded', async () => {
    t = setup({ window: [{ id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, currency: 'KES', payments: { status: 'SUCCESS' } }] })
    const res = await t.mod.adminRecordPayout(ctxOf({ env: { PAYSTACK_CURRENCY: 'USD' }, body: { amountCents: 500 } }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CURRENCY_MISMATCH')
    expect(t.st.inserts).toHaveLength(0)
  })
  it('refuses a payout whose rows span two currencies', async () => {
    t = setup({ window: [
      { id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, currency: 'USD', payments: { status: 'SUCCESS' } },
      { id: 'l2', commission_amount_cents: 500, reverses_ledger_id: null, currency: 'KES', payments: { status: 'SUCCESS' } }] })
    const res = await t.mod.adminRecordPayout(ctxOf({ env: { PAYSTACK_CURRENCY: 'USD' }, body: {} }))
    expect(res.body.code).toBe('CURRENCY_MISMATCH')
  })
  it('rows with no currency recorded count as the platform currency', async () => {
    t = setup()
    expect((await t.mod.adminRecordPayout(ctxOf({ env: { PAYSTACK_CURRENCY: 'KES' }, body: { amountCents: 500 } }))).status).toBe(200)
  })
  it('rejects a currency that is not 3 letters', async () => {
    t = setup()
    await expect(t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500, currency: 'U$D' } }))).rejects.toThrow()
  })
  it('adminGetPartner flags unpaid commission that spans currencies', async () => {
    t = setup({ other: q => (q.table === 'partners' ? undefined : undefined) })
    const row = { ...partnerRow(), payouts: [], referral_codes: [], commission_ledger: [
      { id: 'a', commission_amount_cents: 10, gross_amount_cents: 100, currency: 'USD', payout_id: null, created_at: new Date().toISOString(), payments: { status: 'SUCCESS' } },
      { id: 'b', commission_amount_cents: 10, gross_amount_cents: 100, currency: 'KES', payout_id: null, created_at: new Date().toISOString(), payments: { status: 'SUCCESS' } },
    ] }
    t.restore()
    t = setup({ partner: row })
    const res = await t.mod.adminGetPartner(ctxOf({ env: { PAYSTACK_CURRENCY: 'USD' } }))
    expect(res.body.data.mixedCurrency).toBe(true)
    expect(res.body.data.unpaidCurrencies.sort()).toEqual(['KES', 'USD'])
    expect(res.body.data.payoutDetailsHoldHours).toBe(48)
  })
})

// ── batch payout run ───────────────────────────────────────────────────────────────────────────
describe('adminRecordPayoutBatch', () => {
  const item = (id, over = {}) => ({ partnerId: id, amountCents: 500, expectedDetailsSubmittedAt: OLD_TS, ...over })
  it('records every item through the single-payout checks, scoped to what is payable NOW', async () => {
    t = setup()
    const res = await t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [item(A), item(B)] } }))
    expect(res.body.data).toMatchObject({ recorded: 2, failed: 0 })
    expect(res.body.data.results.every(r => r.ok)).toBe(true)
    expect(t.st.inserts).toHaveLength(2)
    // 'ready' scope: only rows from CLOSED cycles (created_at < the running cycle's start)
    const ledgerSelect = t.db.calls.find(q => q.table === 'commission_ledger' && q.op === 'select')
    expect(has(ledgerSelect, 'lt', 'created_at')).toBe(true)
    expect(t.st.audits.at(-1)).toMatchObject({ action: 'partner.payout_batch', detail: { requested: 2, recorded: 2, failed: 0 } })
  })
  it('a stale amount fails THAT item only', async () => {
    t = setup()
    const res = await t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [item(A, { amountCents: 700 }), item(B)] } }))
    const [a, b] = res.body.data.results
    expect(a).toMatchObject({ ok: false, code: 'AMOUNT_DIFFERS' })
    expect(b.ok).toBe(true)
    expect(res.body.data).toMatchObject({ recorded: 1, failed: 1 })
    expect(t.st.inserts).toHaveLength(1)
  })
  it('a partner whose details changed recently is held; one confirmed with the partner goes through', async () => {
    const recent = partnerRow({ payout_details_submitted_at: new Date(Date.now() - 3600000).toISOString() })
    t = setup({ partnersById: { [A]: recent, [B]: recent } })
    const res = await t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [
      item(A, { expectedDetailsSubmittedAt: recent.payout_details_submitted_at }),
      item(B, { expectedDetailsSubmittedAt: recent.payout_details_submitted_at, confirmedWithPartner: true })] } }))
    expect(res.body.data.results[0]).toMatchObject({ ok: false, code: 'PAYOUT_DETAILS_RECENT' })
    expect(res.body.data.results[1].ok).toBe(true)
  })
  it('changed details since the admin looked fail that item (PAYOUT_DETAILS_CHANGED)', async () => {
    t = setup()
    const res = await t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [item(A, { expectedDetailsSubmittedAt: '2020-01-01T00:00:00.000Z' })] } }))
    expect(res.body.data.results[0]).toMatchObject({ ok: false, code: 'PAYOUT_DETAILS_CHANGED' })
  })
  it('an unexpected error on one item does not abort the run', async () => {
    let n = 0
    t = setup({ partnersSelect: () => (++n === 1 ? { data: null, error: { message: 'boom' } } : { data: partnerRow(), error: null }) })
    const res = await t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [item(A), item(B)] } }))
    expect(res.body.data.results[0]).toMatchObject({ ok: false, status: 500 })
    expect(res.body.data.results[1].ok).toBe(true)
  })
  it('refuses the same partner twice in one run', async () => {
    t = setup()
    const res = await t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [item(A), item(A)] } }))
    expect(res.status).toBe(400)
    expect(t.st.inserts).toHaveLength(0)
  })
  it('validates: at most 25 items, a real uuid, a positive integer amount, details timestamp present', async () => {
    t = setup()
    const many = Array.from({ length: 26 }, (_, i) => item(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`))
    await expect(t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: many } }))).rejects.toThrow()
    await expect(t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [item('nope')] } }))).rejects.toThrow()
    await expect(t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [item(A, { amountCents: 0 })] } }))).rejects.toThrow()
    await expect(t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [{ partnerId: A, amountCents: 500 }] } }))).rejects.toThrow()
    await expect(t.mod.adminRecordPayoutBatch(ctxOf({ body: { items: [] } }))).rejects.toThrow()
  })
})

// ── list endpoint carries the hold the admin screen needs ──────────────────────────────────────
describe('adminListPartners', () => {
  it('returns the server payout-details hold so the payout-run screen flags the same partners', async () => {
    t = setup({ partnersSelect: () => ({ data: [], error: null }) })
    expect((await t.mod.adminListPartners(ctxOf())).body.payoutDetailsHoldHours).toBe(48)
    expect((await t.mod.adminListPartners(ctxOf({ env: { PAYOUT_DETAILS_HOLD_HOURS: '12' } }))).body.payoutDetailsHoldHours).toBe(12)
  })
})

// ── click validity ─────────────────────────────────────────────────────────────────────────────
describe('trackClick reports whether the code is real', () => {
  const codeRow = (over = {}) => ({ id: 'c1', code: 'COACH20', active: true, expires_at: null, usage_limit: null, uses_so_far: 0, partners: { status: 'ACTIVE' }, ...over })
  const call = (o, headers = { 'user-agent': 'Mozilla/5.0' }) => ({ ctx: ctxOf({ body: { code: 'coach20' }, headers }), o })
  it('valid:true and counts the click for a usable code', async () => {
    t = setup({ other: q => (q.table === 'referral_codes' ? { data: codeRow(), error: null } : undefined) })
    const res = await t.mod.trackClick(ctxOf({ body: { code: 'coach20' }, headers: { 'user-agent': 'Mozilla/5.0' } }))
    expect(res.body).toEqual({ success: true, valid: true })
    expect(t.st.rpcs.map(r => r.name)).toEqual(['increment_referral_code_clicks'])
  })
  it('valid:false and NO click for an unknown code (a generic ?ref=twitter)', async () => {
    t = setup({ other: q => (q.table === 'referral_codes' ? { data: null, error: null } : undefined) })
    const res = await t.mod.trackClick(ctxOf({ body: { code: 'twitter' }, headers: { 'user-agent': 'Mozilla/5.0' } }))
    expect(res.body).toEqual({ success: true, valid: false })
    expect(t.st.rpcs).toHaveLength(0)
  })
  it.each([
    ['inactive', { active: false }], ['expired', { expires_at: '2020-01-01T00:00:00Z' }],
    ['at its limit', { usage_limit: 1, uses_so_far: 1 }], ['paused partner', { partners: { status: 'PAUSED' } }],
  ])('valid:false for a code that is %s', async (_n, over) => {
    t = setup({ other: q => (q.table === 'referral_codes' ? { data: codeRow(over), error: null } : undefined) })
    const res = await t.mod.trackClick(ctxOf({ body: { code: 'coach20' }, headers: { 'user-agent': 'Mozilla/5.0' } }))
    expect(res.body.valid).toBe(false)
  })
  it('a failed lookup says nothing about validity (client keeps the code) and still counts the click', async () => {
    t = setup({ other: q => (q.table === 'referral_codes' ? { data: null, error: { message: 'down' } } : undefined) })
    const res = await t.mod.trackClick(ctxOf({ body: { code: 'coach20' }, headers: { 'user-agent': 'Mozilla/5.0' } }))
    expect(res.body).toEqual({ success: true })
    expect(t.st.rpcs).toHaveLength(1)
  })
  it('bots and missing codes answer success with no lookup at all', async () => {
    t = setup()
    expect((await t.mod.trackClick(ctxOf({ body: { code: 'coach20' }, headers: { 'user-agent': 'Googlebot/2.1' } }))).body).toEqual({ success: true })
    expect((await t.mod.trackClick(ctxOf({ body: {}, headers: { 'user-agent': 'Mozilla/5.0' } }))).body).toEqual({ success: true })
    expect(t.st.queries).toHaveLength(0)
  })
})

// ── partner dashboard: conversions paging + readiness ──────────────────────────────────────────
describe('getPartnerConversions', () => {
  const tokenCtx = (over = {}) => ctxOf({ headers: { 'x-partner-token': 'dtok' }, ...over })
  const row = i => ({ id: `l${i}`, referral_code_id: 'c1', gross_amount_cents: 1000, commission_rate: '0.1000', commission_amount_cents: 100, payout_id: null, reverses_ledger_id: null, reversal_reason: null, created_at: `2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z` })
  it('pages newest first, maps rows for the partner and reports the total', async () => {
    t = setup({
      partner: { id: 'p1' },
      other: q => {
        if (q.table === 'referral_codes') return { data: [{ id: 'c1', code: 'COACH20' }], error: null }
        if (q.table === 'commission_ledger') return { data: [row(2), row(1)], error: null, count: 7 }
        return undefined
      },
      ledgerSelect: q => ({ data: [row(2), row(1)], error: null, count: 7 }),
    })
    const res = await t.mod.getPartnerConversions(tokenCtx({ query: { limit: '2', offset: '4' } }))
    expect(res.body.success).toBe(true)
    expect(res.body.total).toBe(7)
    expect(res.body.data[0]).toMatchObject({ id: 'l2', code: 'COACH20', commissionRate: 0.1, commissionAmountCents: 100, paid: false, isReversal: false })
    expect(res.body.data[0].paymentRef).toBeUndefined()
    const q = t.db.calls.find(c => c.table === 'commission_ledger')
    expect(q.range).toEqual([4, 5])
    expect(q.selectOpts).toMatchObject({ count: 'exact' })
    expect(q.orders[0][0]).toBe('created_at')
    expect(q.orders[0][1]).toMatchObject({ ascending: false })
  })
  it('404s for an unknown token and 400s with none', async () => {
    t = setup({ partner: null })
    expect((await t.mod.getPartnerConversions(tokenCtx())).status).toBe(404)
    expect((await t.mod.getPartnerConversions(ctxOf())).status).toBe(400)
  })
})

describe('getPartnerDashboard readiness', () => {
  it('returns the ready-to-pay and credit figures the partner previously had to add up themselves', async () => {
    t = setup({
      partner: partnerRow(),
      other: q => (q.table === 'referral_codes' ? { data: [], error: null } : undefined),
    })
    const res = await t.mod.getPartnerDashboard(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('readyToPayCents')
    expect(res.body.data).toHaveProperty('creditCents')
  })
})

// ── program terms + applications ───────────────────────────────────────────────────────────────
describe('program terms', () => {
  it('getProgramTerms returns the live numbers the payout run enforces', async () => {
    t = setup()
    const res = await t.mod.getProgramTerms(ctxOf({ env: { COMMISSION_HOLD_DAYS: '14', COMMISSION_MIN_PAYOUT_CENTS: '2000', PAYSTACK_CURRENCY: 'KES' } }))
    expect(res.body.data).toMatchObject({ termsVersion: '2026-10', holdDays: 14, minPayoutCents: 2000, currency: 'KES', payoutDetailsHoldHours: 48, reapplyCooldownDays: 30 })
  })
  const app = { name: 'Ann', email: 'ann@x.co', audience: 'newsletter' }
  const appSetup = o => setup({ partnersSelect: () => ({ data: [], error: null }), other: (q, st) => {
    if (q.table === 'partner_applications' && q.op === 'insert') { st.appInserts = (st.appInserts || []).concat([q.values]); return { data: null, error: o?.insertError || null } }
    return undefined
  } })
  it('applying without accepting the terms is refused and stores nothing', async () => {
    t = appSetup()
    await expect(t.mod.applyAsPartner(ctxOf({ body: app }))).rejects.toThrow()
    await expect(t.mod.applyAsPartner(ctxOf({ body: { ...app, acceptTerms: false } }))).rejects.toThrow()
    expect(t.st.appInserts).toBeUndefined()
  })
  it('a stored application records acceptance + version and sends the acknowledgment', async () => {
    t = appSetup()
    await t.mod.applyAsPartner(ctxOf({ body: { ...app, acceptTerms: true } }))
    expect(t.st.appInserts[0]).toMatchObject({ terms_version: '2026-10' })
    expect(Date.parse(t.st.appInserts[0].terms_accepted_at)).toBeGreaterThan(Date.now() - 5000)
    expect(t.st.emails).toEqual([['Ann']])
  })
  it('the acknowledgment is NOT sent for a duplicate pending application (no probing which emails apply)', async () => {
    t = appSetup({ insertError: { code: '23505', message: 'dup' } })
    const res = await t.mod.applyAsPartner(ctxOf({ body: { ...app, acceptTerms: true } }))
    expect(res.body.success).toBe(true)
    expect(t.st.emails).toEqual([])
  })
  it('the honeypot still short-circuits before anything is stored or sent', async () => {
    t = appSetup()
    await t.mod.applyAsPartner(ctxOf({ body: { ...app, acceptTerms: true, company: 'spam' } }))
    expect(t.st.appInserts).toBeUndefined()
    expect(t.st.emails).toEqual([])
  })
})

// ── approve flow: no flip-flop when the email already belongs to a partner ─────────────────────
describe('adminApproveApplication', () => {
  function approveSetup(o = {}) {
    return setup({
      partnersSelect: q => (q.filters.some(f => f[0] === 'ilike') ? { data: o.emailTaken ? [{ id: 'x' }] : [], error: null } : { data: null, error: null }),
      other: (q, s) => {
        if (q.table === 'partner_applications' && q.op === 'select') return { data: o.pending === undefined ? { email: 'ann@x.co' } : o.pending, error: null }
        if (q.table === 'partner_applications' && q.op === 'update') {
          s.appUpdates.push(q.patch)
          if (q.patch.status === 'PENDING' && o.restoreError) return { data: null, error: o.restoreError }
          return { data: q.patch.status === 'APPROVED' ? { id: 'a1', name: 'Ann', email: 'ann@x.co', terms_accepted_at: '2026-10-01T00:00:00Z', terms_version: '2026-10' } : null, error: null }
        }
        if (q.table === 'partners' && q.op === 'insert') { s.partnerInsert = q.values; return { data: o.insertError ? null : { id: 'newp', commission_rate: 0.2, payout_details_token: 'tk', dashboard_token: 'dk', ...q.values }, error: o.insertError || null } }
        return undefined
      },
    })
  }
  it('looks BEFORE claiming: an email that already belongs to a partner never flips the application', async () => {
    t = approveSetup({ emailTaken: true })
    const res = await t.mod.adminApproveApplication(ctxOf({ params: { id: 'a1' }, body: {} }))
    expect(res.status).toBe(400)
    expect(t.st.appUpdates).toEqual([])
  })
  it('carries the recorded terms acceptance onto the new partner', async () => {
    t = approveSetup()
    const res = await t.mod.adminApproveApplication(ctxOf({ params: { id: 'a1' }, body: {} }))
    expect(res.body.success).toBe(true)
    expect(t.st.partnerInsert).toMatchObject({ terms_accepted_at: '2026-10-01T00:00:00Z', terms_version: '2026-10' })
  })
  it('a failed approval is restored to PENDING', async () => {
    t = approveSetup({ insertError: { message: 'boom' } })
    await expect(t.mod.adminApproveApplication(ctxOf({ params: { id: 'a1' }, body: {} }))).rejects.toBeTruthy()
    expect(t.st.appUpdates.map(p => p.status)).toEqual(['APPROVED', 'PENDING'])
  })
  it('if the applicant re-applied meanwhile (restore hits the unique index) the old one is closed as superseded, not stranded APPROVED', async () => {
    t = approveSetup({ insertError: { message: 'boom' }, restoreError: { code: '23505', message: 'dup' } })
    await expect(t.mod.adminApproveApplication(ctxOf({ params: { id: 'a1' }, body: {} }))).rejects.toBeTruthy()
    const last = t.st.appUpdates.at(-1)
    expect(last).toMatchObject({ status: 'REJECTED' })
    expect(last.review_note).toMatch(/superseded/i)
  })
})

// ── wiring ─────────────────────────────────────────────────────────────────────────────────────
describe('route + limiter wiring', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'partners.routes.js'), 'utf8')
  it('the notification toggle has its own limiter bucket, not payout-details'+"'"+' partnerWrite', () => {
    expect(routes).toMatch(/'\/notifications',\s*rl\.partnerPrefs/)
    expect(routes).toMatch(/'\/payout-details',\s*rl\.partnerWrite/)
    const limiter = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'rateLimiter.js'), 'utf8')
    expect(limiter).toMatch(/keyPrefix: 'rl:partnerprefs'/)
  })
  it('new endpoints are registered: admin batch, partner conversions, public program terms', () => {
    expect(routes).toMatch(/post\(\s*'\/payouts\/batch',\s*admin, admin\.stepUp, c\.adminRecordPayoutBatch/)
    expect(routes).toMatch(/get\(\s*'\/conversions',\s*rl\.partnerRead,\s*c\.getPartnerConversions/)
    expect(routes).toMatch(/get\(\s*'\/program',\s*rl\.partnerRead,\s*c\.getProgramTerms/)
    // literal paths must come before the '/:id' routes so they are never parsed as an id
    expect(routes.indexOf("'/payouts/batch'")).toBeLessThan(routes.indexOf("'/:id',"))
    expect(routes.indexOf("'/conversions'")).toBeLessThan(routes.indexOf("'/:id',"))
  })
})
