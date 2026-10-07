// Section 4 (Partners / Referral) — round 4 regression tests. Each block names the bug or
// feature gap it locks in. Uses the shared fakeSupabase, extended per-test with a resolver
// that actually APPLIES the filters the controller sends (the default fake ignores them,
// which is why these pair/period cases were never exercised before).
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { createFakeSupabase } = require('./helpers/fakeSupabase.cjs')
const { loadWithStubs } = require('./helpers/loadWithStubs.cjs')

let t
afterEach(() => { t?.restore?.(); t = null })

const DAY = 86400000
const daysAgo = n => new Date(Date.now() - n * DAY).toISOString()
const ctxOf = (body = {}, over = {}) => ({
  env: { FRONTEND_URL: 'https://app.test', ...(over.env || {}) },
  req: { param: k => (over.params || {})[k] ?? 'p1', query: k => (over.query || {})[k], json: async () => body, header: () => over.ua ?? 'Mozilla/5.0' },
  header: () => {}, json: (b, status = 200) => ({ body: b, status }),
})

// Applies the .is/.in/.eq/.gte/.lte/.or(hold) filters the controller sends to an in-memory ledger.
function filterLedger(rows, q) {
  let out = rows.slice()
  for (const [op, col, val] of q.filters) {
    if (op === 'is' && col === 'payout_id' && val === null) out = out.filter(l => !l.payout_id)
    if (op === 'eq' && col === 'partner_id') out = out.filter(l => (l.partner_id || 'p1') === val)
    if (op === 'in') out = out.filter(l => val.includes(l[col]))
    if (op === 'gte' && col === 'created_at') out = out.filter(l => l.created_at >= val)
    if (op === 'lte' && col === 'created_at') out = out.filter(l => l.created_at <= val)
  }
  for (const expr of q.or || []) {
    const m = /created_at\.lte\.(.+)$/.exec(expr)
    if (m) out = out.filter(l => l.reverses_ledger_id || l.created_at <= m[1])
  }
  return out
}

function setupPayout(ledger, { env = {}, partner } = {}) {
  const state = { inserts: [], deletes: [], claimedIds: [], alerts: [], emails: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'partners' && q.op === 'select')
      return { data: partner || { id: 'p1', name: 'K', email: 'k@x.co', payout_method: 'BANK', payout_details: { bankName: 'X' }, payout_details_submitted_at: null }, error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: filterLedger(ledger, q), error: null }
    if (q.table === 'commission_ledger' && q.op === 'update') {
      const ids = q.filters.find(f => f[0] === 'in')?.[2] || []
      state.claimedIds = ids
      return { data: state.claimOverride ?? ledger.filter(l => ids.includes(l.id) && !l.payout_id), error: null }
    }
    if (q.table === 'payouts' && q.op === 'insert') { state.inserts.push(q.values); return { data: { id: 'po1', ...q.values }, error: null } }
    if (q.table === 'payouts' && q.op === 'delete') { state.deletes.push(q.filters); return { data: null, error: null } }
    if (q.table === 'payouts' && q.op === 'update') return { data: { id: 'po1', ...state.inserts[0], ...q.patch }, error: null }
    return undefined
  })
  const loaded = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert: async (e, subject) => { state.alerts.push(subject) },
      sendPayoutSent: async (e, s, email, name, cents) => { state.emails.push(cents); return true },
    },
  })
  return { ...loaded, state, c: (body, o = {}) => ctxOf(body, { env, ...o }) }
}

const row = (id, cents, created_at, extra = {}) => ({ id, partner_id: 'p1', commission_amount_cents: cents, gross_amount_cents: cents * 4, created_at, payout_id: null, reverses_ledger_id: null, payments: { status: 'SUCCESS' }, ...extra })

describe('B1 — a refunded sale is never paid out (pairs settle together)', () => {
  it('cycle-scoped payout takes the reversal that landed in a LATER cycle along with the original', async () => {
    const ledger = [
      row('o1', 500, '2026-09-05T10:00:00.000Z'),
      row('l2', 300, '2026-09-06T10:00:00.000Z'),
      row('r1', -500, '2026-10-03T10:00:00.000Z', { reverses_ledger_id: 'o1', payments: { status: 'REFUNDED' } }),
    ]
    t = setupPayout(ledger)
    const res = await t.mod.adminRecordPayout(t.c({ periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-15T23:59:59.999Z' }))
    expect(res.status).toBe(200)
    expect(t.state.inserts[0].amount_cents).toBe(300)           // NOT 800: the refunded 500 is netted out
    expect(t.state.claimedIds.sort()).toEqual(['l2', 'o1', 'r1']) // pair is claimed together, never stranded
  })

  it('cycle-scoped payout takes the ORIGINAL along when only the reversal falls in the period', async () => {
    const ledger = [
      row('o1', 500, '2026-09-05T10:00:00.000Z'),
      row('r1', -500, '2026-10-03T10:00:00.000Z', { reverses_ledger_id: 'o1' }),
      row('l3', 900, '2026-10-04T10:00:00.000Z'),
    ]
    t = setupPayout(ledger)
    const res = await t.mod.adminRecordPayout(t.c({ periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-10-15T23:59:59.999Z' }))
    expect(t.state.inserts[0].amount_cents).toBe(900)
    expect(t.state.claimedIds.sort()).toEqual(['l3', 'o1', 'r1'])
    expect(res.status).toBe(200)
  })

  it('hold window: a young original whose reversal is already in does not leave the partner charged', async () => {
    const ledger = [
      row('l2', 300, daysAgo(40)),
      row('o1', 500, daysAgo(2)),                                  // inside the 7-day hold
      row('r1', -500, daysAgo(1), { reverses_ledger_id: 'o1' }),   // reversals are never held
    ]
    t = setupPayout(ledger, { env: { COMMISSION_HOLD_DAYS: '7' } })
    const res = await t.mod.adminRecordPayout(t.c({}))
    expect(res.status).toBe(200)
    expect(t.state.inserts[0].amount_cents).toBe(300)             // used to be 300 - 500 -> refused / short
    expect(t.state.claimedIds.sort()).toEqual(['l2', 'o1', 'r1'])
  })

  it('an ALREADY-PAID original keeps its reversal as a real credit (not voided)', async () => {
    const ledger = [
      row('o1', 500, daysAgo(40), { payout_id: 'poOld' }),
      row('r1', -500, daysAgo(20), { reverses_ledger_id: 'o1' }),
      row('l2', 800, daysAgo(21)),
    ]
    t = setupPayout(ledger)
    await t.mod.adminRecordPayout(t.c({}))
    expect(t.state.inserts[0].amount_cents).toBe(300)             // 800 - 500 credit
  })

  function detail(ledger, env = {}) {
    const rowP = { id: 'p1', name: 'K', email: 'k@x.co', status: 'ACTIVE', commission_rate: 0.2, payouts: [], referral_codes: [], commission_ledger: ledger }
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: rowP, error: null } : undefined))
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    return t.mod.adminGetPartner(ctxOf({}, { env }))
  }

  it('ready-to-pay and cycle figures exclude an unpaid refund pair that straddles cycles', async () => {
    const res = await detail([row('o1', 500, daysAgo(20)), row('r1', -500, daysAgo(0), { reverses_ledger_id: 'o1' })])
    expect(res.body.data.pendingCommissionCents).toBe(0)
    expect(res.body.data.readyToPayCents).toBe(0)                 // was 500
    expect(res.body.data.cyclesSummary.every(cy => cy.unpaidCents === 0)).toBe(true)
  })

  it('B6 — net-negative balance reports a credit and never a negative "ready to pay"', async () => {
    const res = await detail([row('o1', 500, daysAgo(40), { payout_id: 'poOld' }), row('r1', -500, daysAgo(20), { reverses_ledger_id: 'o1' })])
    expect(res.body.data.readyToPayCents).toBe(0)
    expect(res.body.data.creditCents).toBe(500)
  })
})

describe('B2 — payout race recovery works for the amount the admin UI always sends', () => {
  it('amountCents === owed + every row already claimed => phantom payout deleted, no email, 409', async () => {
    t = setupPayout([row('l1', 700, daysAgo(30))])
    t.state.claimOverride = []                                    // a concurrent payout took everything
    const res = await t.mod.adminRecordPayout(t.c({ amountCents: 700 }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PAYOUT_RACED')
    expect(t.state.deletes.length).toBe(1)
    expect(t.state.emails).toEqual([])
  })

  it('a deliberately DIFFERENT typed amount is still never rewritten or discarded', async () => {
    t = setupPayout([row('l1', 700, daysAgo(30))])
    t.state.claimOverride = []
    const res = await t.mod.adminRecordPayout(t.c({ amountCents: 650, acknowledgeDifference: true, internalNote: 'short-paid' }))
    expect(res.status).not.toBe(409)
    expect(t.state.deletes.length).toBe(0)
  })

  it('minimum-payout rule now applies to an amount equal to the owed figure', async () => {
    t = setupPayout([row('l1', 700, '2026-09-05T10:00:00.000Z')], { env: { COMMISSION_MIN_PAYOUT_CENTS: '1000' } })
    // cycle-scoped (the minimum only governs those; ad hoc is the deliberate override)
    const res = await t.mod.adminRecordPayout(t.c({ amountCents: 700, periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-15T23:59:59.999Z' }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('BELOW_MINIMUM')
    expect(t.state.inserts.length).toBe(0)
  })

  it('B5 — the difference explanation can be an INTERNAL note, and it is stored separately', async () => {
    t = setupPayout([row('l1', 700, daysAgo(30))])
    const res = await t.mod.adminRecordPayout(t.c({ amountCents: 650, acknowledgeDifference: true, internalNote: 'owes us a chargeback', note: 'September' }))
    expect(res.status).toBe(200)
    expect(t.state.inserts[0]).toMatchObject({ note: 'September', internal_note: 'owes us a chargeback' })
  })
})

describe('G1 — read-only dashboard token vs write-capable payout token', () => {
  function dash(partner, which) {
    const db = createFakeSupabase(q => {
      if (q.table !== 'partners') return undefined
      const col = q.filters.find(f => f[0] === 'eq')?.[1]
      return { data: col === which ? partner : null, error: null }
    })
    const sent = []
    t = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPartnerPayoutDetailsRequest: async (...a) => { sent.push(a.slice(2)); return true }, sendOwnerAlert: async () => {} },
    })
    return { sent, db }
  }
  const partner = { name: 'K', email: 'k@x.co', payout_details_token: 'WRITE', commission_rate: 0.2, status: 'ACTIVE', referral_codes: [], commission_ledger: [], payouts: [] }

  it('dashboard opens with the read-only token and reports scope "dashboard"', async () => {
    dash(partner, 'dashboard_token')
    const res = await t.mod.getPartnerDashboard(ctxOf({}, { query: { token: 'D' } }))
    expect(res.body.data.scope).toBe('dashboard')
  })
  it('the legacy payout token still opens it, with scope "payout"', async () => {
    dash(partner, 'payout_details_token')
    const res = await t.mod.getPartnerDashboard(ctxOf({}, { query: { token: 'W' } }))
    expect(res.body.data.scope).toBe('payout')
  })
  it('an unknown token is a 404 and the lookups are exact-match (no or() string built from the token)', async () => {
    const { db } = dash(partner, 'nothing')
    const res = await t.mod.getPartnerDashboard(ctxOf({}, { query: { token: 'x),id.neq.0' } }))
    expect(res.status).toBe(404)
    expect(db.calls.every(q => !q.or)).toBe(true)
  })
  it('B5 — partner never sees internal notes, settled figures, or an explanatory note on a short-paid payout', async () => {
    dash({ ...partner, payouts: [
      { id: 'a', amount_cents: 1000, settled_commission_cents: 1000, note: 'September', internal_note: 'SECRET', paid_at: daysAgo(3), created_at: daysAgo(3) },
      { id: 'b', amount_cents: 600, settled_commission_cents: 1000, note: 'owes us for a chargeback', paid_at: daysAgo(2), created_at: daysAgo(2) },
    ] }, 'dashboard_token')
    const res = await t.mod.getPartnerDashboard(ctxOf({}, { query: { token: 'D' } }))
    const p = res.body.data.payouts
    expect(p.find(x => x.id === 'a').note).toBe('September')
    expect(p.find(x => x.id === 'b').note).toBeNull()
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|settledCommissionCents|internal/i)
  })
  it('request-payout-link emails the WRITE link to the address on file for either token, never returning it', async () => {
    const { sent } = dash(partner, 'dashboard_token')
    const res = await t.mod.requestPayoutLink(ctxOf({}, { query: { token: 'D' } }))
    expect(res.status).toBe(200)
    expect(sent[0][0]).toBe('k@x.co')
    expect(sent[0][2]).toContain('/partner/payout-details?token=WRITE')
    expect(JSON.stringify(res.body)).not.toContain('WRITE')
  })
  it('request-payout-link with a bad token is a 404 and sends nothing', async () => {
    const { sent } = dash(partner, 'nothing')
    const res = await t.mod.requestPayoutLink(ctxOf({}, { query: { token: 'nope' } }))
    expect(res.status).toBe(404)
    expect(sent).toEqual([])
  })
  it('payout page gets the READ-ONLY token to link on to, and neither secret appears in the mapped partner', async () => {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: { name: 'K', payout_details: {}, dashboard_token: 'DASH', payout_details_token: 'WRITE' }, error: null } : undefined))
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const res = await t.mod.getPartnerByToken(ctxOf({}, { query: { token: 'W' } }))
    expect(res.body.data.dashboardToken).toBe('DASH')
    expect(JSON.stringify(res.body)).not.toContain('WRITE')
  })
  it('admin links endpoint returns both URLs (no-store) and audit-logs the view', async () => {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: { dashboard_token: 'DASH', payout_details_token: 'WRITE' }, error: null } : undefined))
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const res = await t.mod.adminGetPartnerLinks(ctxOf({}))
    expect(res.body.data.dashboardUrl).toBe('https://app.test/partner/dashboard?token=DASH')
    expect(res.body.data.payoutUrl).toBe('https://app.test/partner/payout-details?token=WRITE')
    expect(db.calls.some(q => q.op === 'insert' && /audit/i.test(q.table))).toBe(true)
  })
})

describe('G4 — payout details are format-checked', () => {
  function submit(body) {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: { id: 'p1', name: 'K', email: 'k@x.co', payout_details: null, payout_details_submitted_at: null }, error: null } : undefined))
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {}, sendPayoutDetailsChanged: async () => true } })
    return t.mod.submitPayoutDetails(ctxOf(body, { query: { token: 'W' } }))
  }
  const bank = n => ({ payoutMethod: 'BANK', bankName: 'B', accountName: 'K', accountNumber: n })
  const momo = n => ({ payoutMethod: 'MOBILE_MONEY', provider: 'M-Pesa', accountName: 'K', phoneNumber: n })
  it.each([['1'], ['12'], ['abc!defg'], ['x'.repeat(40)]])('rejects bank account number %s', async n => { await expect(submit(bank(n))).rejects.toThrow() })
  it.each([['0700'], ['phone-me'], ['+'], ['1'.repeat(30)]])('rejects phone %s', async n => { await expect(submit(momo(n))).rejects.toThrow() })
  it.each([['0123456789'], ['GB82 WEST 1234 5698 7654 32'], ['12-3456-78']])('accepts bank account number %s', async n => { expect((await submit(bank(n))).status).toBe(200) })
  it.each([['+254 712 345 678'], ['0712345678'], ['(0712) 345-678']])('accepts phone %s', async n => { expect((await submit(momo(n))).status).toBe(200) })
})

describe('G2/G3/B7 — applications: approve with rate + first code, reject with reason + email, cooldown', () => {
  function app(o = {}) {
    const st = { updates: [], created: [], codes: [], rejected: [], alerts: [], codeEmails: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: [], error: null }
      if (q.table === 'partners' && q.op === 'insert') { st.created.push(q.values); return { data: { id: 'newp', commission_rate: 0.25, ...q.values }, error: null } }
      if (q.table === 'referral_codes' && q.op === 'select') return { data: o.codeTaken ? [{ id: 'x' }] : [], error: null }
      if (q.table === 'referral_codes' && q.op === 'insert') { st.codes.push(q.values); return { data: { id: 'rc1', ...q.values }, error: o.codeInsertError || null } }
      if (q.table === 'partner_applications' && q.op === 'select') return { data: o.recentReject ? [{ id: 'old' }] : [], error: null }
      if (q.table === 'partner_applications' && q.op === 'insert') { st.inserted = q.values; return { data: null, error: null } }
      if (q.table === 'partner_applications' && q.op === 'update') { st.updates.push(q.patch); return { data: { id: 'a1', name: 'Ann', email: 'ann@x.co', website: 'https://ann.test', audience: 'newsletter' }, error: null } }
      return undefined
    })
    t = { st, ...loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendOwnerAlert: async (e, s) => { st.alerts.push(s) },
        sendPartnerPayoutDetailsRequest: async () => true,
        sendReferralCodeCreated: async (...a) => { st.codeEmails.push(a); return true },
        sendPartnerApplicationRejected: async (...a) => { st.rejected.push(a.slice(2)); return true },
      },
    }) }
    return t
  }
  const approveBody = { commissionRate: 0.3, referralCode: { code: 'ann20', tierPrices: { FIX: 1900 } } }

  it('approval sets the rate, copies website/audience onto the partner, and creates the first code (uppercased)', async () => {
    app()
    const res = await t.mod.adminApproveApplication(ctxOf(approveBody, { params: { id: 'a1' } }))
    expect(res.body.success).toBe(true)
    expect(t.st.created[0]).toMatchObject({ commission_rate: 0.3, website: 'https://ann.test', audience: 'newsletter' })
    expect(t.st.created[0].dashboard_token).toBeTruthy()
    expect(t.st.created[0].dashboard_token).not.toBe(t.st.created[0].payout_details_token)
    expect(t.st.codes[0]).toMatchObject({ partner_id: 'newp', code: 'ANN20' })
    expect(res.body.codeCreated.code).toBe('ANN20')
    // the code email carries the READ-ONLY token
    expect(t.st.codeEmails[0][5]).toContain(`token=${t.st.created[0].dashboard_token}`)
  })
  it('approval with no body still works exactly as before', async () => {
    app()
    const res = await t.mod.adminApproveApplication({ ...ctxOf({}, { params: { id: 'a1' } }), req: { param: () => 'a1', json: async () => { throw new Error('no body') } } })
    expect(res.body.success).toBe(true)
    expect(t.st.codes).toEqual([])
  })
  it('a duplicate first code is a clean 400 BEFORE the application is claimed', async () => {
    app({ codeTaken: true })
    const res = await t.mod.adminApproveApplication(ctxOf(approveBody, { params: { id: 'a1' } }))
    expect(res.status).toBe(400)
    expect(t.st.updates).toEqual([])
    expect(t.st.created).toEqual([])
  })
  it('a first-code failure AFTER the partner exists is reported, not rolled back', async () => {
    app({ codeInsertError: { code: '23505' } })
    const res = await t.mod.adminApproveApplication(ctxOf(approveBody, { params: { id: 'a1' } }))
    expect(res.body.success).toBe(true)
    expect(res.body.codeError).toMatch(/already exists/)
    expect(res.body.codeCreated).toBeNull()
  })
  it('rejection stores the reason and EMAILS the applicant with it', async () => {
    app()
    const res = await t.mod.adminRejectApplication(ctxOf({ reason: 'Not a fit yet.' }, { params: { id: 'a1' } }))
    expect(res.body).toMatchObject({ success: true, emailed: true })
    expect(t.st.updates[0]).toMatchObject({ status: 'REJECTED', review_note: 'Not a fit yet.' })
    expect(t.st.rejected[0]).toEqual(['ann@x.co', 'Ann', 'Not a fit yet.'])
  })
  it('rejection with no reason / no body still emails', async () => {
    app()
    const res = await t.mod.adminRejectApplication({ ...ctxOf({}, { params: { id: 'a1' } }), req: { param: () => 'a1', json: async () => { throw new Error('no body') } } })
    expect(res.body.emailed).toBe(true)
    expect(t.st.rejected[0][2]).toBeNull()
  })
  it('a rejected applicant re-applying inside the cooldown is told OK but nothing is created or alerted', async () => {
    app({ recentReject: true })
    const res = await t.mod.applyAsPartner(ctxOf({ name: 'Ann', email: 'ann@x.co', audience: 'newsletter' }))
    expect(res.status).toBe(200)
    expect(t.st.inserted).toBeUndefined()
    expect(t.st.alerts).toEqual([])
  })
})

describe('G6 — the partner list no longer embeds history', () => {
  it('selects partners bare, reads only UNPAID ledger rows (paged), and never asks for payouts/codes', async () => {
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: [{ id: 'p1', name: 'K', email: 'k@x.co', status: 'ACTIVE', commission_rate: 0.2 }], error: null }
      if (q.table === 'commission_ledger') return { data: [row('l1', 500, daysAgo(30))], error: null }
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const res = await t.mod.adminListPartners(ctxOf({}))
    const pq = db.calls.find(q => q.table === 'partners'), lq = db.calls.find(q => q.table === 'commission_ledger')
    expect(pq.cols).toBe('*')
    expect(lq.filters.some(f => f[0] === 'is' && f[1] === 'payout_id' && f[2] === null)).toBe(true)
    expect(lq.range).toEqual([0, 999])
    expect(res.body.data[0].readyToPayCents).toBe(500)
  })
})
