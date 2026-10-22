import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 27: derived dashboard links, keyset paging, rate stamped at checkout, masked admin detail + step-up reveal,
// atomic re-attribution, legacy-link conversion, and the partner mail-label guard.

let t
afterEach(() => t?.restore())
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
const SECRET = 'test-link-secret-0123456789abcdef0123'
const ENV = { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: SECRET, PAYSTACK_CURRENCY: 'USD' }
const PID = '0b0c8c64-1d0f-4f7e-9a49-0a6a4b1f4c11'

const ctxOf = (over = {}) => ({
  env: { ...ENV, ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1', email: 'a@x.co' } : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? PID,
    query: k => (over.query || {})[k],
    json: async () => over.body ?? {},
    header: k => (over.headers || {})[String(k).toLowerCase()],
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
  executionCtx: { waitUntil: () => {} },
})
function load(handler, emailStubs = {}) {
  const db = createFakeSupabase(handler)
  t = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async () => {}, ...emailStubs },
  })
  return { mod: t.mod, db }
}

describe('derived dashboard links (lib/partnerLinks)', () => {
  const links = require('../src/lib/partnerLinks')
  const dbFor = row => createFakeSupabase(q => (q.table === 'partners' ? { data: row, error: null } : undefined))

  it('a derived token resolves to its partner; nothing about it is stored', async () => {
    const token = await links.deriveDashboardToken({ JWT_SECRET: SECRET }, PID, 0)
    expect(token).toMatch(new RegExp(`^${PID}\\.[0-9a-f]{128}$`))
    const row = { id: PID, dashboard_token_version: 0 }
    expect(await links.findPartnerByDashboardToken({ JWT_SECRET: SECRET }, dbFor(row), token)).toEqual(row)
  })
  it('a tampered mac, another secret, or a bumped version no longer opens the dashboard', async () => {
    const token = await links.deriveDashboardToken({ JWT_SECRET: SECRET }, PID, 0)
    const bad = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    expect(await links.findPartnerByDashboardToken({ JWT_SECRET: SECRET }, dbFor({ id: PID, dashboard_token_version: 0 }), bad)).toBeNull()
    expect(await links.findPartnerByDashboardToken({ JWT_SECRET: 'another-secret-another-secret-0000' }, dbFor({ id: PID, dashboard_token_version: 0 }), token)).toBeNull()
    expect(await links.findPartnerByDashboardToken({ JWT_SECRET: SECRET }, dbFor({ id: PID, dashboard_token_version: 1 }), token)).toBeNull()
  })
  it('a token for an id that does not exist is null; a stored (legacy) token is matched by equality', async () => {
    const token = await links.deriveDashboardToken({ JWT_SECRET: SECRET }, PID, 0)
    expect(await links.findPartnerByDashboardToken({ JWT_SECRET: SECRET }, dbFor(null), token)).toBeNull()
    const db = dbFor({ id: PID })
    await links.findPartnerByDashboardToken({ JWT_SECRET: SECRET }, db, 'a'.repeat(64))
    expect(db.calls[0].filters).toContainEqual(['eq', 'dashboard_token', 'a'.repeat(64)])
    const dotted = createFakeSupabase(() => ({ data: null, error: null }))
    await links.findPartnerByDashboardToken({ JWT_SECRET: SECRET }, dotted, 'not.a.derived.token')
    expect(dotted.calls[0].filters).toContainEqual(['eq', 'dashboard_token', 'not.a.derived.token'])   // malformed dotted string -> stored-token lookup
  })
  it('emails carry the stored legacy token until the link rotates, then the derived one; rotation bumps the version', async () => {
    const legacy = { id: PID, dashboard_token: 'legacytoken', dashboard_token_version: 0 }
    expect(await links.dashboardUrlOf(ENV, legacy)).toBe('https://usepassthrough.com/partner/dashboard?token=legacytoken')
    const patch = links.rotateDashboardPatch(legacy)
    expect(patch).toEqual({ dashboard_token: null, dashboard_token_version: 1 })
    const url = await links.dashboardUrlOf(ENV, { ...legacy, ...patch })
    expect(url).toMatch(new RegExp(`token=${PID}\\.[0-9a-f]{128}$`))
    expect(url).not.toBe(await links.dashboardUrlOf(ENV, { id: PID, dashboard_token: null, dashboard_token_version: 0 }))
  })
  it('refuses to derive anything when no secret is configured', async () => {
    await expect(links.deriveDashboardToken({}, PID, 0)).rejects.toThrow(/secret|JWT_SECRET/i)
  })
})

describe('partner mail labels', () => {
  it('every partner-facing email label in email.service.js is in the anonymize purge list', () => {
    const labels = [...read('src/services/email.service.js').matchAll(/'(partner_[a-z_]+|payout_sent|referral_code_created)'/g)].map(m => m[1])
    const listed = require('../src/lib/partnerMailTemplates')
    expect(labels.length).toBeGreaterThan(10)
    for (const l of new Set(labels)) expect(listed, `email label ${l} would survive an erasure`).toContain(l)
  })
  it('the controller purges by that shared list', () => {
    expect(read('src/controllers/partners.controller.js')).toContain("require('../lib/partnerMailTemplates')")
  })
})

describe('keyset paging of the unpaid ledger', () => {
  it('pages by primary key (id > last), never by offset', async () => {
    const mk = i => ({ id: `l${String(i).padStart(5, '0')}`, partner_id: 'p1', commission_amount_cents: 1, gross_amount_cents: 10, payout_id: null,
      reverses_ledger_id: null, kind: 'SALE', currency: 'USD', created_at: '2026-01-01T00:00:00Z', payments: { status: 'SUCCESS' } })
    let page = 0
    const { mod, db } = load(q => {
      if (q.table === 'partners') return { data: [{ id: 'p1', name: 'K', email: 'k@x.co', status: 'ACTIVE', commission_rate: 0.2 }], error: null }
      if (q.table === 'commission_ledger') return { data: page++ === 0 ? Array.from({ length: 1000 }, (_, i) => mk(i)) : [mk(1000)], error: null }
      return undefined
    })
    await mod.adminListPartners(ctxOf())
    const calls = db.calls.filter(q => q.table === 'commission_ledger')
    expect(calls).toHaveLength(2)
    expect(calls[0].filters.some(f => f[0] === 'gt')).toBe(false)
    expect(calls[1].filters).toContainEqual(['gt', 'id', 'l00999'])
    expect(calls.every(c => c.range === undefined && c.limit === 1000)).toBe(true)
  })
})

describe('admin payout details: masked detail view, step-up reveal, audit', () => {
  const row = { id: PID, email: 'k@x.co', payout_method: 'BANK', payout_details: { bankName: 'B', accountName: 'K', accountNumber: '1234567890' },
    tax_country: 'US', tax_id: '123-45-6789', payouts: [{ id: 'po1', payout_method: 'BANK', payout_details_snapshot: { accountNumber: '0987654321' } }] }
  it('reveal returns the full values and writes partner.details_viewed', async () => {
    const audits = []
    const { mod } = load(q => {
      if (q.table === 'admin_audit_log' && q.op === 'insert') { audits.push(q.values); return { data: null, error: null } }
      if (q.table === 'partners') return { data: row, error: null }
      return undefined
    })
    const res = await mod.adminRevealPayoutDetails(ctxOf())
    expect(res.body.data.payoutDetails.accountNumber).toBe('1234567890')
    expect(res.body.data.taxId).toBe('123-45-6789')
    expect(res.body.data.snapshots.po1.accountNumber).toBe('0987654321')
    expect(audits[0]).toMatchObject({ action: 'partner.details_viewed', target_id: PID })
  })
  it('fails CLOSED: if the audit entry cannot be written, nothing is revealed', async () => {
    const { mod } = load(q => {
      if (q.table === 'admin_audit_log') return { data: null, error: { message: 'db down' } }
      if (q.table === 'partners') return { data: row, error: null }
      return undefined
    })
    const res = await mod.adminRevealPayoutDetails(ctxOf())
    expect(res.status).toBe(503)
    expect(JSON.stringify(res.body)).not.toContain('1234567890')
    expect(JSON.stringify(res.body)).not.toContain('123-45-6789')
  })
  it('a removed partner reveals nothing, and nothing is audited', async () => {
    const audits = []
    const { mod } = load(q => {
      if (q.table === 'admin_audit_log') { audits.push(q); return { data: null, error: null } }
      if (q.table === 'partners') return { data: { ...row, email: 'removed-1@removed.invalid' }, error: null }
      return undefined
    })
    const res = await mod.adminRevealPayoutDetails(ctxOf())
    expect(res.body.success).toBe(false)
    expect(audits).toHaveLength(0)
  })
  it('both new admin routes sit behind step-up', () => {
    const routes = read('src/routes/partners.routes.js')
    expect(routes).toMatch(/'\/:id\/payout-details',\s+admin, admin\.stepUp/)
    expect(routes).toMatch(/'\/:id\/ledger\/:ledgerId\/reattribute', admin, admin\.stepUp/)
    expect(routes).toMatch(/'\/dashboard-links\/convert',\s+admin, admin\.stepUp/)
  })
})

describe('re-attributing a sale', () => {
  const sale = { id: 'led1', partner_id: PID, referral_code_id: 'rcOld', kind: 'SALE', reverses_ledger_id: null, payment_id: 'pay1', gross_amount_cents: 2900, payout_id: null }
  const target = { id: 'rcNew', partner_id: 'p2', code: 'NEW10', active: true, partners: { status: 'ACTIVE', email: 'n@x.co', previous_emails: [], commission_rate: 0.3 } }
  function setup({ ledger = sale, code = target, outcome = 'ok' } = {}) {
    const audits = [], rpcs = []
    const r = load(q => {
      if (q.op === 'rpc') { rpcs.push(q); return { data: outcome, error: null } }
      if (q.table === 'admin_audit_log' && q.op === 'insert') { audits.push(q.values); return { data: null, error: null } }
      if (q.table === 'commission_ledger') return { data: ledger, error: null }
      if (q.table === 'referral_codes') return { data: code, error: null }
      return undefined
    })
    return { ...r, audits, rpcs }
  }
  const body = { toCode: 'new10', reason: 'buyer used the wrong code' }
  it('moves the sale at the TARGET partner\'s rate through one RPC, and audits it', async () => {
    const s = setup()
    const res = await s.mod.adminReattributeSale(ctxOf({ body, params: { id: PID, ledgerId: 'led1' } }))
    expect(res.body).toMatchObject({ success: true, data: { toPartnerId: 'p2', toCodeId: 'rcNew', commissionCents: 870 } })
    expect(s.rpcs[0].name).toBe('reattribute_sale')
    expect(s.rpcs[0].args).toEqual({ p_ledger_id: 'led1', p_to_code_id: 'rcNew', p_to_partner_id: 'p2', p_rate: 0.3, p_commission_cents: 870 })
    expect(s.audits[0]).toMatchObject({ action: 'partner.sale_reattributed' })
  })
  it('refuses a paid sale, an adjustment, an inactive target partner, the same code, and a missing reason', async () => {
    const run = async (opts, b = body) => setup(opts).mod.adminReattributeSale(ctxOf({ body: b, params: { id: PID, ledgerId: 'led1' } }))
    expect((await run({ ledger: { ...sale, payout_id: 'po1' } })).body.code).toBe('ALREADY_PAID')
    expect((await run({ ledger: { ...sale, kind: 'ADJUSTMENT', payment_id: null } })).status).toBe(400)
    expect((await run({ code: { ...target, partners: { ...target.partners, status: 'PAUSED' } } })).status).toBe(409)
    expect((await run({ code: { ...target, id: 'rcOld' } })).status).toBe(409)
    await expect(run({}, { toCode: 'NEW10', reason: 'x' })).rejects.toThrow()
  })
  it('a refusal from the database (already reversed, raced to paid) is reported, not swallowed', async () => {
    const res = await setup({ outcome: 'already_reversed' }).mod.adminReattributeSale(ctxOf({ body, params: { id: PID, ledgerId: 'led1' } }))
    expect(res).toMatchObject({ status: 409, body: { success: false, code: 'ALREADY_REVERSED' } })
  })
  it('the migration refuses paid and reversed sales and moves ledger, payment and both usage counters together', () => {
    const sql = read('supabase/migrations/0107_partners_section4_round27.sql')
    expect(sql).toMatch(/payout_id is not null then return 'already_paid'/)
    expect(sql).toMatch(/reverses_ledger_id = p_ledger_id/)
    expect(sql).toMatch(/uses_so_far = greatest\(uses_so_far - 1, 0\)/)
    expect(sql).toMatch(/update payments/)
    expect(sql).toMatch(/revoke execute on function reattribute_sale/)
  })
})

describe('commission rate stamped at checkout', () => {
  const { recordConversion } = require('../src/services/referral.service.js')
  const payment = { id: 'pay1', referral_code_id: 'rc1', amount_cents: 1900 }
  const db = stamp => createFakeSupabase(q => {
    if (q.table === 'referral_codes') return { data: { id: 'rc1', partner_id: 'p1' }, error: null }
    if (q.table === 'partners') return { data: { commission_rate: 0.2 }, error: null }
    if (q.table === 'payments') return stamp === 'missing-column' ? { data: null, error: { code: '42703', message: 'column does not exist' } } : { data: stamp == null ? null : { referral_commission_rate: stamp }, error: null }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: null, error: null }
    if (q.table === 'commission_ledger') return { data: { id: 'led1' }, error: null }
    if (q.op === 'rpc') return { error: null }
    return undefined
  })
  const rateOf = d => d.calls.find(q => q.table === 'commission_ledger' && q.op === 'insert').values
  it('pays the rate the sale was made under, not the rate at the time the row is written', async () => {
    const d = db(0.15)
    await recordConversion(d, payment)
    expect(rateOf(d)).toMatchObject({ commission_rate: 0.15, commission_amount_cents: 285 })
  })
  it('a payment with no stamp (made before 0107, or a database without the column) uses the current rate', async () => {
    for (const stamp of [null, 'missing-column']) {
      const d = db(stamp)
      await recordConversion(d, payment)
      expect(rateOf(d)).toMatchObject({ commission_rate: 0.2, commission_amount_cents: 380 })
    }
  })
  it('checkout stamps the rate on the payment row, with a fallback for a database that predates the column', () => {
    const src = read('src/controllers/payments.controller.js')
    expect(src).toContain('referral_commission_rate: Number(finalPriced.referralCode.partners.commission_rate)')
    expect(src).toMatch(/insertErr\.code === '42703'[\s\S]{0,120}referral_commission_rate/)
  })
})

describe('converting legacy stored dashboard links', () => {
  const legacy = n => ({ id: `p${n}`, name: `P${n}`, email: `p${n}@x.co`, dashboard_token: `old${n}`, dashboard_token_version: 0 })
  function setup(mailOk) {
    const updates = [], audits = [], mails = []
    const r = load(q => {
      if (q.table === 'admin_audit_log' && q.op === 'insert') { audits.push(q.values); return { data: null, error: null } }
      if (q.table === 'partners' && q.op === 'select') return { data: [legacy(1), legacy(2)], count: 2, error: null }
      if (q.table === 'partners' && q.op === 'update') { updates.push(q); return { data: { id: 'x' }, error: null } }
      return undefined
    }, { sendPartnerDashboardLinkRegenerated: async (...a) => { mails.push(a); return mailOk } })
    return { ...r, updates, audits, mails }
  }
  it('rotates each legacy partner, emails the new derived link, and reports what remains', async () => {
    const s = setup(true)
    const res = await s.mod.adminConvertLegacyDashboardLinks(ctxOf())
    expect(res.body).toMatchObject({ success: true, converted: 2, failed: 0, remaining: 0 })
    expect(s.updates[0].patch).toMatchObject({ dashboard_token: null, dashboard_token_version: 1 })
    expect(s.mails[0][4]).toMatch(/token=p1\.[0-9a-f]{128}$/)
    expect(s.audits[0]).toMatchObject({ action: 'partner.dashboard_links_converted' })
  })
  it('when the email cannot be sent the old link is restored, so nobody is locked out', async () => {
    const s = setup(false)
    const res = await s.mod.adminConvertLegacyDashboardLinks(ctxOf())
    expect(res.body).toMatchObject({ converted: 0, failed: 2, remaining: 2 })
    const undo = s.updates.filter(u => u.patch.dashboard_token === 'old1')
    expect(undo).toHaveLength(1)
    expect(undo[0].patch).toMatchObject({ dashboard_token_version: 0 })
  })
})
