import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 5 — locks in every fix from this pass. The headline regression (bug 1) is the
// real PostgREST timestamp format: earlier tests only ever used `...Z`, so a validator that
// rejected `+00:00` (what Postgres actually returns) shipped and blocked ALL payout recording.

const PG_TS = '2026-09-01T10:00:00.123456+00:00'   // exactly what PostgREST returns for timestamptz
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

function setup(o = {}) {
  const st = { audits: [], emails: [], inserts: [], updates: [], claimedIds: null, queries: [] }
  const partner = 'partner' in o ? o.partner : {
    id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', payout_method: 'BANK',
    payout_details: { bankName: 'B', accountNumber: '0123456789' }, payout_details_submitted_at: PG_TS,
    payout_details_token: 'ptok', dashboard_token: 'dtok', commission_rate: 0.1, notify_conversions: true,
  }
  const db = createFakeSupabase(q => {
    st.queries.push(q)
    if (q.table === 'admin_audit_log' && q.op === 'insert') { st.audits.push(q.values); return { data: null, error: null } }
    if (q.table === 'partners' && q.op === 'select') {
      if (o.partnerByToken) {
        const eq = q.filters.find(f => f[0] === 'eq' && /token/.test(f[1]))
        return { data: eq && eq[2] === o.partnerByToken.token && eq[1] === o.partnerByToken.column ? o.partnerByToken.row : null, error: null }
      }
      return { data: partner, error: null }
    }
    if (q.table === 'partners' && q.op === 'update') { st.updates.push(q.patch); return { data: o.updated ?? partner, error: null } }
    if (q.table === 'partners' && q.op === 'insert') return { data: o.inserted ?? { id: 'p9', name: 'Ann', email: 'ann@x.co', commission_rate: 0.1, payout_details_token: 'newtok', dashboard_token: 'newd' }, error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') {
      if (has(q, 'not', 'reverses_ledger_id')) return { data: o.credits ?? [], error: null }
      if (q.filters.some(f => f[0] === 'in')) return { data: [], error: null }
      return { data: o.window ?? [{ id: 'l1', commission_amount_cents: 500, reverses_ledger_id: null, payments: { status: 'SUCCESS' } }], error: null }
    }
    if (q.table === 'commission_ledger' && q.op === 'update') {
      if (q.patch && q.patch.payout_id === null) return o.releaseError ? { data: null, error: { message: 'boom' } } : { data: o.released ?? [{ id: 'l1' }, { id: 'l2' }], error: null }
      const ids = (q.filters.find(f => f[0] === 'in') || [])[2] || []
      st.claimedIds = ids
      return { data: ids.map(id => ({ id, commission_amount_cents: 0 })), error: null }
    }
    if (q.table === 'payouts' && q.op === 'insert') { st.inserts.push(q.values); return { data: { id: 'po1', ...q.values }, error: null } }
    if (q.table === 'payouts' && q.op === 'update') { st.updates.push(q.patch); return { data: o.claim === undefined ? { id: 'po1' } : o.claim, error: null } }
    if (q.table === 'payouts' && q.op === 'select') return { data: o.payout === undefined ? { id: 'po1', partner_id: 'p1', amount_cents: 5000, currency: 'USD', voided_at: null } : o.payout, error: null }
    return undefined
  })
  const ok = async (...a) => { st.emails.push(a.slice(3)); return o.emailOk ?? true }
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/turnstile.js': { verifyTurnstile: async (_e, tok) => tok === 'good' },
    'services/email.service.js': {
      sendOwnerAlert: async () => {}, sendPayoutSent: ok, sendPartnerPayoutVoided: ok,
      sendPartnerLinkRegenerated: async () => { st.emails.push(['payout-link']); return o.emailOk ?? true },
      sendPartnerDashboardLinkRegenerated: async () => { st.emails.push(['dash-link']); return o.emailOk ?? true },
      sendPartnerPayoutDetailsRequest: async () => o.emailOk ?? true,
      sendPartnerApplicationRejected: ok,
    },
  })
  return { ...m, st }
}

describe('bug 1 — payout recording with the real PostgREST timestamp', () => {
  it('accepts expectedDetailsSubmittedAt echoed back as `…+00:00`', async () => {
    t = setup()
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500, expectedDetailsSubmittedAt: PG_TS } }))
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })
  it('still refuses (409) when the details really changed since', async () => {
    t = setup()
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500, expectedDetailsSubmittedAt: '2026-09-02T10:00:00.000000+00:00' } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PAYOUT_DETAILS_CHANGED')
  })
})

describe('bug 2 — refund credits settle with a cycle payout', () => {
  it('pulls in unpaid credits from other closed cycles and nets them', async () => {
    t = setup({
      window:  [{ id: 'a', commission_amount_cents: 10000, reverses_ledger_id: null, payments: { status: 'SUCCESS' } }],
      credits: [{ id: 'c', commission_amount_cents: -3000, reverses_ledger_id: 'paid-orig', payments: { status: 'REFUNDED' } }],
    })
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-08-15T23:59:59.999Z' } }))
    expect(res.body.success).toBe(true)
    expect(t.st.inserts[0].amount_cents).toBe(7000)
    expect(t.st.inserts[0].settled_commission_cents).toBe(7000)
    expect([...t.st.claimedIds].sort()).toEqual(['a', 'c'])
    const creditQ = t.st.queries.find(q => q.table === 'commission_ledger' && has(q, 'not', 'reverses_ledger_id'))
    expect(creditQ).toBeTruthy()
    expect(has(creditQ, 'lt', 'created_at')).toBe(true)     // closed cycles only — the running cycle is excluded, matching payableCents()
  })
  it('does NOT go looking for credits on an ad hoc payout (it already takes every unpaid row)', async () => {
    t = setup()
    await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500 } }))
    expect(t.st.queries.some(q => q.table === 'commission_ledger' && has(q, 'not', 'reverses_ledger_id'))).toBe(false)
  })
  it('buildCyclesSummary reports the credit that lives OUTSIDE each cycle, and nets refunded sales out of the count', () => {
    t = setup()
    const { buildCyclesSummary } = t.mod
    const cycles = buildCyclesSummary([], 4)
    // Two closed cycles; a credit dated in the OLDER one, a sale in the NEWER one.
    const [, newer, older] = cycles
    const mid = c => new Date((Date.parse(c.start) + Date.parse(c.end)) / 2).toISOString()
    const rows = [
      { id: 's1', created_at: mid(newer), gross_amount_cents: 20000, commission_amount_cents: 2000, reverses_ledger_id: null, payout_id: null },
      { id: 'r1', created_at: mid(older), gross_amount_cents: 0, commission_amount_cents: -300, reverses_ledger_id: 'paid-elsewhere', payout_id: null },
      { id: 's2', created_at: mid(newer), gross_amount_cents: 5000, commission_amount_cents: 500, reverses_ledger_id: null, payout_id: null },
      { id: 'r2', created_at: mid(newer), gross_amount_cents: 0, commission_amount_cents: -500, reverses_ledger_id: 's2', payout_id: null },
    ]
    const out = buildCyclesSummary(rows, 4)
    const n = out.find(c => c.key === newer.key), o = out.find(c => c.key === older.key)
    expect(n.outsideCreditCents).toBe(-300)      // the credit sitting in the older cycle
    expect(o.outsideCreditCents).toBe(0)         // its own credit is already inside its own unpaidCents
    expect(n.ledgerCount).toBe(1)                // s2 was refunded — not a conversion any more
    expect(n.unpaidCents).toBe(2000)             // s2 + r2 is a void pair and nets out of what is payable
  })
})

describe('bug 4 — payoutMethod override', () => {
  it('refuses a method that does not match the partner\'s stored details', async () => {
    t = setup()
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500, payoutMethod: 'MOBILE_MONEY' } }))
    expect(res.status).toBe(400)
    expect(t.st.inserts).toHaveLength(0)
  })
  it('an override can no longer stand in for missing details', async () => {
    t = setup({ partner: { id: 'p1', name: 'K', email: 'k@x.co', status: 'ACTIVE', payout_method: null, payout_details: null } })
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { amountCents: 500, payoutMethod: 'BANK' } }))
    expect(res.status).toBe(400)
    expect(t.st.inserts).toHaveLength(0)
  })
})

describe('G1 — void a payout', () => {
  const vctx = body => ctxOf({ params: { id: 'p1', payoutId: 'po1' }, body })
  it('marks it void, releases the ledger rows, audits it and tells the partner', async () => {
    t = setup()
    const res = await t.mod.adminVoidPayout(vctx({ reason: 'Wrong cycle' }))
    expect(res.body).toMatchObject({ success: true, alreadyVoided: false, releasedCount: 2 })
    expect(t.st.updates.some(u => u && u.voided_at && u.void_reason === 'Wrong cycle')).toBe(true)
    const rel = t.st.queries.find(q => q.table === 'commission_ledger' && q.op === 'update')
    expect(rel.patch).toEqual({ payout_id: null })
    expect(t.st.audits[0]).toMatchObject({ action: 'partner.payout_voided', target_id: 'po1' })
    expect(t.st.emails).toHaveLength(1)
  })
  it('requires a reason', async () => {
    t = setup()
    await expect(t.mod.adminVoidPayout(vctx({ reason: '' }))).rejects.toThrow()
  })
  it('is idempotent: a repeat call re-runs the release but does not re-audit or re-email', async () => {
    t = setup({ payout: { id: 'po1', partner_id: 'p1', amount_cents: 5000, currency: 'USD', voided_at: '2026-09-02T00:00:00Z' } })
    const res = await t.mod.adminVoidPayout(vctx({ reason: 'again' }))
    expect(res.body.alreadyVoided).toBe(true)
    expect(t.st.queries.some(q => q.table === 'commission_ledger' && q.op === 'update')).toBe(true)
    expect(t.st.audits).toHaveLength(0); expect(t.st.emails).toHaveLength(0)
  })
  it('404s for a payout that is not this partner\'s', async () => {
    t = setup({ payout: null })
    expect((await t.mod.adminVoidPayout(vctx({ reason: 'x y z' }))).status).toBe(404)
  })
  it('says so (500) when the release fails, so the admin retries instead of assuming success', async () => {
    t = setup({ releaseError: true })
    const res = await t.mod.adminVoidPayout(vctx({ reason: 'x y z' }))
    expect(res.status).toBe(500)
    expect(res.body.message).toMatch(/Void" again/)
  })
})

describe('G3 — link rotation scope and token transport', () => {
  it('scope "dashboard" rotates only the dashboard token', async () => {
    t = setup()
    const res = await t.mod.adminRegeneratePayoutLink(ctxOf({ body: { scope: 'dashboard' } }))
    expect(Object.keys(t.st.updates[0])).toEqual(['dashboard_token'])
    expect(res.body.dashboardUrl).toMatch(/\/partner\/dashboard\?token=/)
    expect(res.body.payoutUrl).toBeUndefined()
    expect(t.st.emails).toEqual([['dash-link']])
  })
  it('scope "both" rotates and emails both; the default stays payout-only', async () => {
    t = setup()
    const both = await t.mod.adminRegeneratePayoutLink(ctxOf({ body: { scope: 'both' } }))
    expect(Object.keys(t.st.updates[0]).sort()).toEqual(['dashboard_token', 'payout_details_token'])
    expect(both.body.payoutUrl && both.body.dashboardUrl).toBeTruthy()
    t.restore(); t = setup()
    await t.mod.adminRegeneratePayoutLink(ctxOf())
    expect(Object.keys(t.st.updates[0])).toEqual(['payout_details_token'])
  })
  it('the dashboard reads the token from X-Partner-Token (no query string), drops partnerId and hides voided payouts', async () => {
    const row = {
      name: 'K', commission_rate: 0.1, status: 'ACTIVE', payout_method: 'BANK', notify_conversions: false,
      referral_codes: [{ id: 'rc1', partner_id: 'p1', code: 'K10', tier_prices: {}, active: true, uses_so_far: 0, clicks: 3 }],
      commission_ledger: [],
      payouts: [
        { id: 'po1', amount_cents: 100, currency: 'USD', status: 'PAID', paid_at: '2026-09-01T00:00:00Z', voided_at: null },
        { id: 'po2', amount_cents: 999, currency: 'USD', status: 'PAID', paid_at: '2026-09-02T00:00:00Z', voided_at: '2026-09-03T00:00:00Z' },
      ],
    }
    t = setup({ partnerByToken: { column: 'dashboard_token', token: 'HDR', row } })
    const res = await t.mod.getPartnerDashboard(ctxOf({ headers: { 'x-partner-token': 'HDR' } }))
    expect(res.status).toBe(200)
    expect(res.body.data.referralCodes[0]).not.toHaveProperty('partnerId')
    expect(res.body.data.payouts.map(p => p.id)).toEqual(['po1'])
    expect(res.body.data.notifyConversions).toBe(false)
  })
  it('the old ?token= link still works, and an absurdly long token is treated as missing', async () => {
    const row = { name: 'K', commission_rate: 0.1, status: 'ACTIVE', payout_method: null, referral_codes: [], commission_ledger: [], payouts: [] }
    t = setup({ partnerByToken: { column: 'dashboard_token', token: 'OLD', row } })
    expect((await t.mod.getPartnerDashboard(ctxOf({ query: { token: 'OLD' } }))).status).toBe(200)
    expect((await t.mod.getPartnerDashboard(ctxOf({ query: { token: 'x'.repeat(300) } }))).status).toBe(400)
  })
})

describe('G8 — per-sale email preference', () => {
  it('saves the preference for a valid token', async () => {
    t = setup({ partnerByToken: { column: 'dashboard_token', token: 'T', row: { id: 'p1' } } })
    const res = await t.mod.updatePartnerNotifications(ctxOf({ headers: { 'x-partner-token': 'T' }, body: { conversions: false } }))
    expect(res.body.data.notifyConversions).toBe(false)
    expect(t.st.updates[0].notify_conversions).toBe(false)
  })
  it('404s for an unknown token and rejects a non-boolean', async () => {
    t = setup({ partnerByToken: { column: 'dashboard_token', token: 'T', row: { id: 'p1' } } })
    expect((await t.mod.updatePartnerNotifications(ctxOf({ headers: { 'x-partner-token': 'nope' }, body: { conversions: true } }))).status).toBe(404)
    await expect(t.mod.updatePartnerNotifications(ctxOf({ headers: { 'x-partner-token': 'T' }, body: { conversions: 'yes' } }))).rejects.toThrow()
  })
})

describe('bug 3 / G5 — delivery is reported, not assumed', () => {
  it('create: emailed:false carries the link so the admin can hand it over', async () => {
    t = setup({ emailOk: false, partner: null })
    const res = await t.mod.adminCreatePartner(ctxOf({ body: { name: 'Ann', email: 'ann@x.co' } }))
    expect(res.body.success).toBe(true)
    expect(res.body.emailed).toBe(false)
    expect(res.body.payoutUrl).toContain('/partner/payout-details?token=')
  })
  it('create: emailed:true carries no link', async () => {
    t = setup({ partner: null })
    const res = await t.mod.adminCreatePartner(ctxOf({ body: { name: 'Ann', email: 'ann@x.co' } }))
    expect(res.body.emailed).toBe(true)
    expect(res.body.payoutUrl).toBeUndefined()
  })
})

describe('G2 — apply form challenge', () => {
  const app = { name: 'Ann', email: 'ann@x.co', audience: 'Career coaches with 5k followers' }
  it('is refused without a valid Turnstile token when a secret is configured, and never stored', async () => {
    t = setup({ partner: null })
    const res = await t.mod.applyAsPartner(ctxOf({ body: app, env: { TURNSTILE_SECRET_KEY: 's' } }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CAPTCHA_FAILED')
    expect(t.st.queries.some(q => q.table === 'partner_applications' && q.op === 'insert')).toBe(false)
  })
})

describe('G4 — cross-partner lookups', () => {
  it('code search escapes LIKE wildcards and upper-cases', async () => {
    t = setup()
    await t.mod.adminListReferralCodes(ctxOf({ query: { q: 'a_b%' } }))
    const q = t.st.queries.find(x => x.table === 'referral_codes')
    expect(q.filters.find(f => f[0] === 'ilike')[2]).toBe('%A\\_B\\%%')
  })
  it('payouts list hides voided ones unless asked', async () => {
    t = setup({ payout: [] })
    await t.mod.adminListPayouts(ctxOf())
    expect(has(t.st.queries.find(x => x.table === 'payouts'), 'is', 'voided_at')).toBe(true)
    t.restore(); t = setup({ payout: [] })
    await t.mod.adminListPayouts(ctxOf({ query: { includeVoided: 'true' } }))
    expect(has(t.st.queries.find(x => x.table === 'payouts'), 'is', 'voided_at')).toBe(false)
  })
})

describe('referral — self-referral aliasing', () => {
  it('canonicalEmail folds Gmail dots, +tags and googlemail.com, and nothing more aggressive', () => {
    const { canonicalEmail } = require('../src/services/referral.service.js')
    expect(canonicalEmail('M.e+promo@Gmail.com')).toBe('me@gmail.com')
    expect(canonicalEmail('me@googlemail.com')).toBe('me@gmail.com')
    expect(canonicalEmail('a.b+x@corp.com')).toBe('a.b@corp.com')   // dots are only ignorable at Gmail
  })
})

describe('routes — literal admin paths are registered before /:id', () => {
  it('overview, codes and payouts come before the generic GET /:id', () => {
    const router = require('../src/routes/partners.routes.js')
    const gets = router.routes.filter(r => r.method === 'GET').map(r => r.path)
    const idIdx = gets.indexOf('/:id')
    for (const p of ['/overview', '/codes', '/payouts']) {
      expect(gets.indexOf(p)).toBeGreaterThan(-1)
      expect(gets.indexOf(p)).toBeLessThan(idIdx)
    }
  })
})
